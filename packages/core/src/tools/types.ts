import { RulesError, type Combatant, type Rng } from '@cartyx-sim/rules';
import { z } from 'zod';
import type { SimEvent } from '../events';
import type { LoreIndex, ToolCall, ToolSchema } from '../model';
import type { TurnRecorder } from '../recorder';
import { ownEntry, type GameState } from '../state';

/** A tool misuse the model can correct, e.g. an unknown id. Returned to the model as an error result. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ToolContext {
  recorder: TurnRecorder;
  /** Committed events before this turn. */
  history: readonly SimEvent[];
  rng: Rng;
  lore: LoreIndex;
  loreThreshold: number;
  /** "dm" or the acting PC's id. */
  actorId: string;
}

export interface ToolOutcome {
  /** Text returned to the model as the tool result. */
  result: string;
  /** True when the tool ends the DM's beat (hand_off). */
  endsBeat?: boolean;
}

/**
 * Tools must finish every check that can fail before their first `recorder.emit`, so a rejected call
 * never leaves half its events behind.
 */
export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: S;
  /** Spoken or narrated text in the arguments, checked by validators before the tool runs. */
  narrativeText?: (args: z.output<S>) => string | undefined;
  run(args: z.output<S>, context: ToolContext): ToolOutcome | Promise<ToolOutcome>;
}

// Tool lists mix parameter schemas, so they are stored with an erased schema type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any>;

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export function toToolSchema(def: AnyToolDef): ToolSchema {
  return {
    name: def.name,
    description: def.description,
    parameters: z.toJSONSchema(def.parameters, { io: 'input' }) as Record<string, unknown>,
  };
}

export type PreparedCall =
  { ok: true; def: AnyToolDef; args: unknown } | { ok: false; error: string };

export function prepareToolCall(call: ToolCall, tools: readonly AnyToolDef[]): PreparedCall {
  const def = tools.find((tool) => tool.name === call.name);
  if (!def) {
    const names = tools.map((tool) => tool.name).join(', ');
    return { ok: false, error: `Unknown tool "${call.name}". Available tools: ${names}` };
  }
  const parsed = def.parameters.safeParse(call.args);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid arguments for ${call.name}: ${z.prettifyError(parsed.error)}`,
    };
  }
  return { ok: true, def, args: parsed.data };
}

export async function runPreparedCall(
  def: AnyToolDef,
  args: unknown,
  context: ToolContext
): Promise<{ ok: true; outcome: ToolOutcome } | { ok: false; error: string }> {
  const checkpoint = context.recorder.checkpoint();
  try {
    return { ok: true, outcome: await def.run(args, context) };
  } catch (error) {
    if (error instanceof ToolError || error instanceof RulesError) {
      context.recorder.rollback(checkpoint);
      return { ok: false, error: error.message };
    }
    if (error instanceof z.ZodError) {
      context.recorder.rollback(checkpoint);
      return { ok: false, error: `Invalid resulting state: ${z.prettifyError(error)}` };
    }
    throw error;
  }
}

export function getCombatant(state: GameState, id: string): Combatant {
  const combatant = ownEntry(state.combatants, id);
  if (!combatant) {
    const known = Object.keys(state.combatants).join(', ') || 'none';
    throw new ToolError(`Unknown combatant id "${id}". Known ids: ${known}`);
  }
  return combatant;
}
