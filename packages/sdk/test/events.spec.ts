import { TypedEventEmitter } from '../src/events';

interface TestEventMap {
  greet: (name: string) => void;
  ping: () => void;
}

class TestEmitter extends TypedEventEmitter<TestEventMap> {
  fire(name: string): void {
    this.emit('greet', name);
  }
  ping(): void {
    this.emit('ping');
  }
}

describe('TypedEventEmitter', () => {
  it('calls registered handlers with the emitted arguments', () => {
    const emitter = new TestEmitter();
    const handler = jest.fn();
    emitter.on('greet', handler);

    emitter.fire('alice');

    expect(handler).toHaveBeenCalledWith('alice');
  });

  it('supports multiple handlers for the same event', () => {
    const emitter = new TestEmitter();
    const a = jest.fn();
    const b = jest.fn();
    emitter.on('greet', a);
    emitter.on('greet', b);

    emitter.fire('bob');

    expect(a).toHaveBeenCalledWith('bob');
    expect(b).toHaveBeenCalledWith('bob');
  });

  it('off() stops a specific handler from being called again', () => {
    const emitter = new TestEmitter();
    const handler = jest.fn();
    emitter.on('greet', handler);
    emitter.off('greet', handler);

    emitter.fire('carol');

    expect(handler).not.toHaveBeenCalled();
  });

  it('once() only fires a single time', () => {
    const emitter = new TestEmitter();
    const handler = jest.fn();
    emitter.once('ping', handler);

    emitter.ping();
    emitter.ping();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a handler that unregisters itself mid-dispatch does not break other handlers', () => {
    const emitter = new TestEmitter();
    const b = jest.fn();
    const a: jest.Mock<void, [string]> = jest.fn((_name: string) => {
      emitter.off('greet', a);
    });
    emitter.on('greet', a);
    emitter.on('greet', b);

    emitter.fire('dana');

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    emitter.fire('erin');
    expect(a).toHaveBeenCalledTimes(1); // removed itself, no second call
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('removeAllListeners() clears a single event without affecting others', () => {
    const emitter = new TestEmitter();
    const greetHandler = jest.fn();
    const pingHandler = jest.fn();
    emitter.on('greet', greetHandler);
    emitter.on('ping', pingHandler);

    emitter.removeAllListeners('greet');
    emitter.fire('finn');
    emitter.ping();

    expect(greetHandler).not.toHaveBeenCalled();
    expect(pingHandler).toHaveBeenCalledTimes(1);
  });
});
