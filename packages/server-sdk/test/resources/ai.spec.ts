import { AgentsResource, TranscriptionsResource } from '../../src/resources/ai';
import type { SwalvoHttpClient } from '../../src/http-client';

const httpMock = () => ({ request: jest.fn().mockResolvedValue(undefined) });

describe('TranscriptionsResource', () => {
  it('starts, reads, stops and exports with the contract paths', async () => {
    const http = httpMock();
    const trx = new TranscriptionsResource(http as unknown as SwalvoHttpClient);

    await trx.start('r1', { language: 'en', providerKeys: { deepgram: 'k' } });
    await trx.get('r1');
    await trx.stop('r1');
    await trx.transcript('trx_1', { cursor: 'c', limit: 10 });
    await trx.export('trx_1', 'vtt');
    await trx.eraseParticipant('alice');

    expect(http.request.mock.calls).toEqual([
      [
        '/v1/rooms/r1/transcription',
        { method: 'POST', body: { language: 'en', providerKeys: { deepgram: 'k' } }, retryable: false },
      ],
      ['/v1/rooms/r1/transcription'],
      ['/v1/rooms/r1/transcription', { method: 'DELETE' }],
      ['/v1/transcripts/trx_1', { query: { cursor: 'c', limit: 10 } }],
      ['/v1/transcripts/trx_1.vtt', { responseType: 'text' }],
      ['/v1/transcripts/participants/alice', { method: 'DELETE' }],
    ]);
  });
});

describe('AgentsResource', () => {
  it('maps every agent call onto its route', async () => {
    const http = httpMock();
    const agents = new AgentsResource(http as unknown as SwalvoHttpClient);

    await agents.create('r1', { name: 'Bot', instructions: 'Be nice' });
    await agents.list('r1');
    await agents.get('agt_1');
    await agents.update('agt_1', { interruptible: false });
    await agents.say('agt_1', 'hello');
    await agents.interrupt('agt_1');
    await agents.delete('agt_1');

    expect(http.request.mock.calls).toEqual([
      ['/v1/rooms/r1/agents', { method: 'POST', body: { name: 'Bot', instructions: 'Be nice' }, retryable: false }],
      ['/v1/rooms/r1/agents'],
      ['/v1/agents/agt_1'],
      ['/v1/agents/agt_1', { method: 'PATCH', body: { interruptible: false } }],
      ['/v1/agents/agt_1/say', { method: 'POST', body: { text: 'hello' }, retryable: false }],
      ['/v1/agents/agt_1/interrupt', { method: 'POST' }],
      ['/v1/agents/agt_1', { method: 'DELETE' }],
    ]);
  });
});
