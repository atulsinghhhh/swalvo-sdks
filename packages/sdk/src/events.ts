/** Minimal typed pub/sub. No dependency, and it keeps the bundle small. */
export class TypedEventEmitter<EventMap extends { [K in keyof EventMap]: (...args: never[]) => void }> {
  private listeners = new Map<keyof EventMap, Set<(...args: never[]) => void>>();

  on<E extends keyof EventMap>(event: E, handler: EventMap[E]): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (...args: never[]) => void);
    return this;
  }

  off<E extends keyof EventMap>(event: E, handler: EventMap[E]): this {
    this.listeners.get(event)?.delete(handler as (...args: never[]) => void);
    return this;
  }

  once<E extends keyof EventMap>(event: E, handler: EventMap[E]): this {
    const wrapped = ((...args: never[]) => {
      this.off(event, wrapped as EventMap[E]);
      (handler as (...args: never[]) => void)(...args);
    }) as EventMap[E];
    return this.on(event, wrapped);
  }

  removeAllListeners(event?: keyof EventMap): this {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
    return this;
  }

  protected emit<E extends keyof EventMap>(event: E, ...args: Parameters<EventMap[E]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy before iterating: a handler might call .off() on itself, or on
    // another handler for this event, mid-dispatch.
    for (const handler of Array.from(set)) {
      (handler as (...args: unknown[]) => void)(...args);
    }
  }
}
