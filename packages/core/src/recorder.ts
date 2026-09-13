import { z } from 'zod';
import { SimEvent, type Visibility } from './events';
import { applyEvent, type GameState } from './state';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the recorder stamps seq, ts, and turnId. Visibility defaults to public. */
export type EventInput = DistributiveOmit<
  z.input<typeof SimEvent>,
  'seq' | 'ts' | 'turnId' | 'visibility'
> & { visibility?: Visibility };

/**
 * Buffers one turn's events. Each emitted event is validated and applied to a working state, so
 * tools later in the same turn see earlier results. Nothing is persisted until the director commits.
 */
export class TurnRecorder {
  private working: GameState;
  private readonly emitted: SimEvent[] = [];

  constructor(
    base: GameState,
    readonly turnId: string,
    private readonly now: () => Date
  ) {
    this.working = base;
  }

  get state(): GameState {
    return this.working;
  }

  get events(): readonly SimEvent[] {
    return this.emitted;
  }

  emit(input: EventInput): SimEvent {
    const event = SimEvent.parse({
      visibility: 'public',
      ...input,
      seq: this.working.lastSeq + 1,
      ts: this.now().toISOString(),
      turnId: this.turnId,
    });
    this.working = applyEvent(this.working, event);
    this.emitted.push(event);
    return event;
  }
}
