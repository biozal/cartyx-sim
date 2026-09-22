import { z } from 'zod';
import { SimEvent, type Visibility } from './events';
import { applyEvent, type GameState } from './state';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the recorder stamps seq, ts, and turnId. Visibility defaults to public. */
export type EventInput = DistributiveOmit<
  z.input<typeof SimEvent>,
  'seq' | 'ts' | 'turnId' | 'visibility'
> & { visibility?: Visibility };

/** A point in the recorder's history that `rollback` can restore. Opaque to callers. */
export interface RecorderCheckpoint {
  readonly state: GameState;
  readonly eventCount: number;
}

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

  /** Captures the current working state and event count, to `rollback` to later. */
  checkpoint(): RecorderCheckpoint {
    return { state: this.working, eventCount: this.emitted.length };
  }

  /** Restores the working state and truncates emitted events back to a prior checkpoint. */
  rollback(checkpoint: RecorderCheckpoint): void {
    this.working = checkpoint.state;
    this.emitted.length = checkpoint.eventCount;
  }

  /**
   * Attaches each invention to the narration it supports. Called once when the turn finishes,
   * before the director appends it: the DM looks lore up, finds a gap, records what it invented,
   * and only then narrates, so the link runs forward and falls back to the last narration before.
   */
  linkInventions(): void {
    for (const [index, event] of this.emitted.entries()) {
      if (event.type !== 'lore_invention' || event.narrationSeq !== undefined) continue;
      const after = this.emitted
        .slice(index + 1)
        .find((candidate) => candidate.type === 'narration');
      const before = this.emitted
        .slice(0, index)
        .findLast((candidate) => candidate.type === 'narration');
      const narration = after ?? before;
      if (narration) this.emitted[index] = { ...event, narrationSeq: narration.seq };
    }
  }
}
