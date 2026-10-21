jest.mock('@swalvo/rtc', () => require('./helpers/fake-rtc-client'));

import { act, fireEvent, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SwalvoRoom } from '../src/swalvo-room';
import { useAgentState, useTranscription } from '../src/hooks';
import { AgentVisualizer, Captions } from '../src/video/captions';
import { VideoConference } from '../src/video/video-conference';
import { lastClient, resetFakeRtc, type FakeRoom } from './helpers/fake-rtc-client';
import { FakePeer, renderInRoom, videoRoom, type VideoRoom } from './helpers/fake-video';

function seg(overrides: Record<string, unknown> = {}) {
  return {
    type: 'transcription.segment',
    transcriptionId: 'trx_1',
    participantId: 'alice',
    segmentId: 'seg_1',
    text: 'hello',
    final: false,
    language: 'en',
    startMs: 0,
    endMs: 100,
    ...overrides,
  };
}

async function hookInRoom<T>(hook: () => T, room: VideoRoom) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SwalvoRoom token="t" endpoint="wss://rtc.example.com" room="room-1">
      {children}
    </SwalvoRoom>
  );
  const result = renderHook(hook, { wrapper });
  await act(async () => {
    lastClient().pendingJoin.resolve(room as unknown as FakeRoom);
    await lastClient().pendingJoin.promise;
  });
  return result;
}

describe('useTranscription', () => {
  beforeEach(() => resetFakeRtc());

  it('folds interim and final segments and tracks active', async () => {
    const room = videoRoom();
    const { result } = await hookInRoom(() => useTranscription(), room);
    expect(result.current).toMatchObject({ segments: [], interim: {}, active: false });

    act(() => room.emit('transcriptionStateChanged', { transcriptionId: 'trx_1', status: 'ACTIVE', language: 'en' }));
    expect(result.current.active).toBe(true);

    act(() => room.emit('transcriptionSegment', seg({ text: 'hel' })));
    act(() => room.emit('transcriptionSegment', seg({ text: 'hello every' })));
    expect(result.current.interim.alice.text).toBe('hello every');

    act(() => room.emit('transcriptionSegment', seg({ text: 'hello everyone', final: true })));
    expect(result.current.interim).toEqual({});
    expect(result.current.segments.map((s) => s.text)).toEqual(['hello everyone']);
  });

  it('clears an interim on an empty final and filters by participant', async () => {
    const room = videoRoom();
    const bob = new FakePeer('bob');
    const { result } = await hookInRoom(() => useTranscription({ participant: bob as never }), room);
    act(() => room.emit('transcriptionSegment', seg({ participantId: 'alice', final: true })));
    act(() => room.emit('transcriptionSegment', seg({ participantId: 'bob', segmentId: 'b1', text: 'um' })));
    expect(Object.keys(result.current.interim)).toEqual(['bob']);
    act(() => room.emit('transcriptionSegment', seg({ participantId: 'bob', segmentId: 'b1', text: '', final: true })));
    expect(result.current.interim).toEqual({});
    expect(result.current.segments).toEqual([]);
  });
});

describe('useAgentState', () => {
  beforeEach(() => resetFakeRtc());

  it('reads agentState and follows agentStateChanged', async () => {
    const agent = Object.assign(new FakePeer('agent-agt_1'), { agentState: 'listening' });
    const { result } = await hookInRoom(() => useAgentState(agent as never), videoRoom([agent]));
    expect(result.current).toBe('listening');
    act(() => {
      agent.agentState = 'speaking';
      agent.emit('agentStateChanged', 'speaking');
    });
    expect(result.current).toBe('speaking');
  });

  it('is undefined for no participant', async () => {
    const { result } = await hookInRoom(() => useAgentState(undefined), videoRoom());
    expect(result.current).toBeUndefined();
  });
});

describe('<Captions>', () => {
  beforeEach(() => resetFakeRtc());
  afterEach(() => jest.useRealTimers());

  it('shows the speaker, italic-marks interim text, and is a polite live region', async () => {
    const alice = new FakePeer('alice', JSON.stringify({ name: 'Alice' }));
    const { container, room } = await renderInRoom(<Captions />, videoRoom([alice]));
    const region = container.querySelector('.swalvo-captions')!;
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('data-empty');

    act(() => room.emit('transcriptionSegment', seg({ text: 'hello every' })));
    const interim = container.querySelector('.swalvo-captions__line[data-interim]')!;
    expect(interim).toHaveTextContent('Alice: hello every');
    expect(interim).toHaveAttribute('aria-hidden', 'true');

    act(() => room.emit('transcriptionSegment', seg({ text: 'hello everyone', final: true })));
    expect(container.querySelector('[data-interim]')).toBeNull();
    expect(container.querySelector('.swalvo-captions__line[data-final]')).toHaveTextContent('Alice: hello everyone');
  });

  it('fades finals after fadeAfterMs and keeps at most maxLines', async () => {
    jest.useFakeTimers();
    const { container, room } = await renderInRoom(
      <Captions fadeAfterMs={1000} maxLines={2} showSpeaker={false} />,
      videoRoom(),
    );
    act(() => {
      for (const id of ['a', 'b', 'c'])
        room.emit('transcriptionSegment', seg({ segmentId: id, text: id, final: true }));
    });
    expect(Array.from(container.querySelectorAll('.swalvo-captions__line')).map((n) => n.textContent)).toEqual([
      'b',
      'c',
    ]);
    act(() => {
      jest.advanceTimersByTime(1100);
    });
    expect(container.querySelectorAll('.swalvo-captions__line')).toHaveLength(0);
  });
});

describe('<AgentVisualizer>', () => {
  beforeEach(() => resetFakeRtc());

  it('reflects the agent state as data-state and an accessible status', async () => {
    const agent = Object.assign(new FakePeer('agent-agt_1').withTracks('microphone'), { agentState: 'thinking' });
    const { container } = await renderInRoom(
      <AgentVisualizer participant={agent as never} barCount={3} />,
      videoRoom([agent]),
    );
    const root = container.querySelector('.swalvo-agent-visualizer')!;
    expect(root).toHaveAttribute('data-state', 'thinking');
    expect(container.querySelectorAll('.swalvo-agent-visualizer__bar')).toHaveLength(3);
    expect(screen.getByRole('status')).toHaveTextContent('agent-agt_1 · Thinking');
    act(() => {
      agent.agentState = 'speaking';
      agent.emit('agentStateChanged', 'speaking');
    });
    expect(root).toHaveAttribute('data-state', 'speaking');
  });
});

describe('<VideoConference captions>', () => {
  beforeEach(() => resetFakeRtc());

  it('adds a Captions toggle and overlay only when asked', async () => {
    const { container, unmount } = await renderInRoom(<VideoConference />, videoRoom());
    expect(screen.queryByRole('button', { name: 'Captions' })).toBeNull();
    expect(container.querySelector('.swalvo-captions')).toBeNull();
    unmount();

    resetFakeRtc();
    const rendered = await renderInRoom(<VideoConference captions />, videoRoom());
    const toggle = screen.getByRole('button', { name: 'Captions' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(rendered.container.querySelector('.swalvo-video-conference__captions')).not.toBeNull();
    act(() => rendered.room.emit('transcriptionSegment', seg({ final: true })));
    expect(rendered.container.querySelector('.swalvo-captions__line')).toHaveTextContent('alice: hello');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(rendered.container.querySelector('.swalvo-captions')).toBeNull();
  });

  it('can start with captions off', async () => {
    const { container } = await renderInRoom(<VideoConference captions={{ defaultEnabled: false }} />, videoRoom());
    expect(screen.getByRole('button', { name: 'Captions' })).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelector('.swalvo-captions')).toBeNull();
  });
});
