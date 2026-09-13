import { scriptedRng, type Rng } from '@cartyx-sim/rules';
import type { SimEvent } from '../src/events';
import type { LoreHit, LoreIndex } from '../src/model';
import { TurnRecorder } from '../src/recorder';
import type { GameState } from '../src/state';
import { StaticLoreIndex } from '../src/testing';
import {
  prepareToolCall,
  runPreparedCall,
  type AnyToolDef,
  type ToolContext,
  type ToolOutcome,
} from '../src/tools/types';
import { now, startedState } from './helpers';

export const SELLA_CHUNK: LoreHit = {
  chunkId: 'avalon#sella-vaunt',
  source: 'kanka-export/markdown/characters/2418574-2418574.md',
  title: 'Professor Sella Vaunt',
  text: 'Professor Sella Vaunt teaches applied crystal engines at Avalon Artificers Academy.',
  score: 0,
};

export interface ToolHarness {
  recorder: TurnRecorder;
  context: ToolContext;
  run(
    tool: AnyToolDef,
    args?: Record<string, unknown>
  ): Promise<{ ok: true; outcome: ToolOutcome } | { ok: false; error: string }>;
}

/** Runs tools directly against a recorder, the way the director does, without any model. */
export function toolHarness(
  options: {
    state?: GameState;
    history?: SimEvent[];
    rng?: Rng;
    lore?: LoreIndex;
    actorId?: string;
    seat?: string;
  } = {}
): ToolHarness {
  const started = options.state
    ? { state: options.state, history: options.history ?? [] }
    : startedState();
  const recorder = new TurnRecorder(started.state, 'turn-1', now);
  const actorId = options.actorId ?? 'dm';
  const context: ToolContext = {
    recorder,
    history: started.history,
    rng: options.rng ?? scriptedRng([]),
    lore: options.lore ?? new StaticLoreIndex([SELLA_CHUNK]),
    loreThreshold: 0.35,
    actorId,
    seat: options.seat ?? actorId,
  };
  return {
    recorder,
    context,
    async run(tool, args = {}) {
      const prepared = prepareToolCall({ id: 'test-call', name: tool.name, args }, [tool]);
      if (!prepared.ok) return prepared;
      return runPreparedCall(prepared.def, prepared.args, context);
    },
  };
}
