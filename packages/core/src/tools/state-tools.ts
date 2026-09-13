import {
  Condition,
  addCondition,
  addItem,
  applyDamage,
  applyHealing,
  removeCondition,
  removeItem,
  rollDice,
  type DiceResult,
  type Rng,
} from '@cartyx-sim/rules';
import { z } from 'zod';
import type { TurnRecorder } from '../recorder';
import { emitCombatantChanges, formatHp } from './mechanics';
import { defineTool, getCombatant, ToolError } from './types';

const AmountArgs = {
  amount: z.number().int().min(0).optional(),
  dice: z.string().min(1).optional(),
};

/** Resolves exactly one of a flat amount or a dice expression. Rolls but does not emit. */
function resolveAmount(
  args: { amount?: number; dice?: string },
  kind: 'damage' | 'healing',
  rng: Rng
): { total: number; roll: DiceResult | null } {
  if ((args.amount === undefined) === (args.dice === undefined)) {
    throw new ToolError(`Provide exactly one of amount or dice for ${kind}.`);
  }
  if (args.dice !== undefined) {
    const roll = rollDice(args.dice, rng);
    return { total: roll.total, roll };
  }
  return { total: args.amount!, roll: null };
}

function emitAmountRoll(
  recorder: TurnRecorder,
  targetId: string,
  kind: 'damage' | 'healing',
  label: string,
  roll: DiceResult | null
): void {
  if (!roll) return;
  recorder.emit({
    type: 'roll',
    actor: targetId,
    kind,
    label,
    expr: roll.expr,
    rolls: roll.rolls,
    modifier: roll.modifier,
    total: roll.total,
  });
}

export const applyDamageTool = defineTool({
  name: 'apply_damage',
  description:
    'Apply damage that did not come from attack or cast_spell (traps, falls, hazards). Give a flat amount or dice.',
  parameters: z.object({
    targetId: z.string().min(1),
    ...AmountArgs,
    damageType: z.string().min(1),
    reason: z.string().min(1),
  }),
  run(args, { recorder, rng }) {
    const target = getCombatant(recorder.state, args.targetId);
    const { total, roll } = resolveAmount(args, 'damage', rng);
    const after = applyDamage(target, total);
    emitAmountRoll(recorder, target.id, 'damage', `${args.reason} (${args.damageType})`, roll);
    emitCombatantChanges(recorder, target, after, `damage:${args.reason}`);
    return {
      result: `${target.name} takes ${total} ${args.damageType} damage. ${target.name}: ${formatHp(after)}.`,
    };
  },
});

export const healTool = defineTool({
  name: 'heal',
  description:
    'Restore hit points that did not come from cast_spell (potions, rests). Give a flat amount or dice.',
  parameters: z.object({
    targetId: z.string().min(1),
    ...AmountArgs,
    reason: z.string().min(1),
  }),
  run(args, { recorder, rng }) {
    const target = getCombatant(recorder.state, args.targetId);
    const { total, roll } = resolveAmount(args, 'healing', rng);
    const after = applyHealing(target, total);
    emitAmountRoll(recorder, target.id, 'healing', args.reason, roll);
    emitCombatantChanges(recorder, target, after, `healing:${args.reason}`);
    return {
      result: `${target.name} regains ${after.hp - target.hp} HP. ${target.name}: ${formatHp(after)}.`,
    };
  },
});

export const addConditionTool = defineTool({
  name: 'add_condition',
  description: 'Give a combatant a 5e condition such as poisoned, prone, or frightened.',
  parameters: z.object({
    targetId: z.string().min(1),
    condition: Condition,
    reason: z.string().min(1),
  }),
  run(args, { recorder }) {
    const target = getCombatant(recorder.state, args.targetId);
    emitCombatantChanges(recorder, target, addCondition(target, args.condition), args.reason);
    return { result: `${target.name} is ${args.condition}.` };
  },
});

export const removeConditionTool = defineTool({
  name: 'remove_condition',
  description: 'Remove a condition from a combatant.',
  parameters: z.object({
    targetId: z.string().min(1),
    condition: Condition,
    reason: z.string().min(1),
  }),
  run(args, { recorder }) {
    const target = getCombatant(recorder.state, args.targetId);
    if (!target.conditions.includes(args.condition)) {
      throw new ToolError(`${target.name} is not ${args.condition}.`);
    }
    emitCombatantChanges(recorder, target, removeCondition(target, args.condition), args.reason);
    return { result: `${target.name} is no longer ${args.condition}.` };
  },
});

export const giveItem = defineTool({
  name: 'give_item',
  description: "Add an item to a combatant's inventory.",
  parameters: z.object({
    targetId: z.string().min(1),
    item: z.string().min(1),
    quantity: z.number().int().min(1).default(1),
  }),
  run(args, { recorder }) {
    const target = getCombatant(recorder.state, args.targetId);
    emitCombatantChanges(recorder, target, addItem(target, args.item, args.quantity), 'give_item');
    return { result: `${target.name} receives ${args.quantity} × ${args.item}.` };
  },
});

export const removeItemTool = defineTool({
  name: 'remove_item',
  description: "Remove an item from a combatant's inventory (used, lost, or handed over).",
  parameters: z.object({
    targetId: z.string().min(1),
    item: z.string().min(1),
    quantity: z.number().int().min(1).default(1),
  }),
  run(args, { recorder }) {
    const target = getCombatant(recorder.state, args.targetId);
    const after = removeItem(target, args.item, args.quantity);
    emitCombatantChanges(recorder, target, after, 'remove_item');
    return { result: `${target.name} loses ${args.quantity} × ${args.item}.` };
  },
});
