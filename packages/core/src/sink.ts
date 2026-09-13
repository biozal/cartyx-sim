import type { SimEvent } from './events';

/** Durable event storage. `append` receives one whole turn and must write it atomically. */
export interface EventSink {
  readAll(): Promise<SimEvent[]>;
  append(events: readonly SimEvent[]): Promise<void>;
}

export class MemorySink implements EventSink {
  readonly events: SimEvent[] = [];

  async readAll(): Promise<SimEvent[]> {
    return [...this.events];
  }

  async append(events: readonly SimEvent[]): Promise<void> {
    this.events.push(...events);
  }
}
