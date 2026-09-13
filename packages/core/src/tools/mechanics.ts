import {
  Ability,
  Skill,
  applyDamage,
  applyHealing,
  formatModifier,
  resolveAttack,
  resolveCheck,
  rollAttack,
  rollDice,
  spendSlot,
  type Attack,
  type AttackResult,
  type CheckResult,
  type CheckSpec,
  type Combatant,
} from '@cartyx-sim/rules';
import { z } from 'zod';
import type { StateField } from '../events';
import type { EventInput, TurnRecorder } from '../recorder';
import { defineTool, getCombatant, ToolError } from './types';

export const RollModeArg = z.enum(['normal', 'advantage', 'disadvantage']).default('normal');

const DIFF_FIELDS = [
  'hp',
  'tempHp',
  'maxHp',
  'conditions',
  'dead',
  'spellSlots',
  'inventory',
  'level',
] as const satisfies readonly StateField[];

/** Emits one state_change per field that differs between two versions of a combatant. */
export function emitCombatantChanges(
  recorder: TurnRecorder,
  before: Combatant,
  after: Combatant,
  cause: string
): void {
  for (const field of DIFF_FIELDS) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      recorder.emit({
        type: 'state_change',
        entity: before.id,
        field,
        before: before[field],
        after: after[field],
        cause,
      });
    }
  }
}

export function formatHp(combatant: Combatant): string {
  if (combatant.dead) return 'dead';
  const conditions = combatant.conditions.length > 0 ? ` (${combatant.conditions.join(', ')})` : '';
  return `${combatant.hp}/${combatant.maxHp} HP${conditions}`;
}

function attackRollEvents(actor: string, label: string, result: AttackResult): EventInput[] {
  const events: EventInput[] = [
    {
      type: 'roll',
      actor,
      kind: 'attack',
      label,
      expr: `1d20${formatModifier(result.attack.bonus)}`,
      rolls: result.d20.rolls,
      modifier: result.attack.bonus,
      total: result.total,
      target: result.targetAc,
      outcome: result.critical ? 'critical' : result.hit ? 'hit' : 'miss',
    },
  ];
  if (result.damage) {
    events.push({
      type: 'roll',
      actor,
      kind: 'damage',
      label: `${label} damage (${result.attack.damageType})`,
      expr: result.damage.expr,
      rolls: result.damage.rolls,
      modifier: result.damage.modifier,
      total: result.damage.total,
    });
  }
  return events;
}

function checkRollEvent(combatant: Combatant, result: CheckResult, reason: string): EventInput {
  return {
    type: 'roll',
    actor: combatant.id,
    kind: result.spec.type === 'save' ? 'save' : 'check',
    label: `${combatant.name} ${result.label} (${reason})`,
    expr: `1d20${formatModifier(result.modifier)}`,
    rolls: result.d20.rolls,
    modifier: result.modifier,
    total: result.total,
    target: result.dc,
    outcome: result.success ? 'success' : 'failure',
  };
}

export const requestCheck = defineTool({
  name: 'request_check',
  description:
    'Roll an ability check, skill check, or saving throw for a combatant against a DC. The engine rolls; narrate the result afterwards.',
  parameters: z.object({
    combatantId: z.string().min(1).max(200),
    checkType: z.enum(['skill', 'ability', 'save']),
    skill: Skill.optional(),
    ability: Ability.optional(),
    dc: z.number().int().min(1).max(40),
    reason: z.string().trim().min(1).max(2000),
    mode: RollModeArg,
  }),
  run(args, { recorder, rng }) {
    const combatant = getCombatant(recorder.state, args.combatantId);
    let spec: CheckSpec;
    if (args.checkType === 'skill') {
      if (!args.skill) throw new ToolError('checkType "skill" requires skill.');
      spec = { type: 'skill', skill: args.skill };
    } else {
      if (!args.ability) throw new ToolError(`checkType "${args.checkType}" requires ability.`);
      spec =
        args.checkType === 'save'
          ? { type: 'save', ability: args.ability }
          : { type: 'ability', ability: args.ability };
    }
    const result = resolveCheck(combatant, spec, args.dc, rng, args.mode);
    recorder.emit(checkRollEvent(combatant, result, args.reason));
    return {
      result: `${combatant.name} rolled ${result.total} (natural ${result.d20.natural}${formatModifier(result.modifier)}) against DC ${args.dc}: ${result.success ? 'SUCCESS' : 'FAILURE'}.`,
    };
  },
});

export const attack = defineTool({
  name: 'attack',
  description:
    "Make a weapon or natural attack using one of the attacker's listed attacks. Rolls to hit and applies damage.",
  parameters: z.object({
    attackerId: z.string().min(1).max(200),
    targetId: z.string().min(1).max(200),
    attackName: z.string().trim().min(1).max(200),
    mode: RollModeArg,
  }),
  run(args, { recorder, rng }) {
    const attacker = getCombatant(recorder.state, args.attackerId);
    const target = getCombatant(recorder.state, args.targetId);
    if (attacker.dead || attacker.hp === 0) {
      throw new ToolError(`${attacker.name} cannot attack at 0 HP or while dead.`);
    }
    const result = resolveAttack(attacker, target, args.attackName, rng, args.mode);
    const label = `${attacker.name} ${result.attack.name} → ${target.name}`;
    for (const event of attackRollEvents(attacker.id, label, result)) recorder.emit(event);
    emitCombatantChanges(recorder, target, result.target, `attack:${attacker.id}`);
    const verb = result.critical ? 'CRITICALLY HITS' : result.hit ? 'hits' : 'misses';
    const damage = result.damage
      ? ` for ${result.damage.total} ${result.attack.damageType} damage`
      : '';
    return {
      result: `${attacker.name}'s ${result.attack.name} ${verb} ${target.name} (${result.total} vs AC ${result.targetAc})${damage}. ${target.name}: ${formatHp(result.target)}.`,
    };
  },
});

export const castSpell = defineTool({
  name: 'cast_spell',
  description:
    'Resolve a spell. Spends a slot (slotLevel 0 for cantrips) and applies at most one effect: a spell attack, a saving throw, or healing.',
  parameters: z.object({
    casterId: z.string().min(1).max(200),
    spell: z.string().trim().min(1).max(200),
    slotLevel: z.number().int().min(0).max(9),
    targetIds: z.array(z.string().min(1).max(200)).default([]),
    attack: z
      .object({
        bonus: z.number().int(),
        damage: z.string().min(1),
        damageType: z.string().trim().min(1),
      })
      .optional(),
    save: z
      .object({
        ability: Ability,
        dc: z.number().int().min(1),
        damage: z.string().min(1).optional(),
        damageType: z.string().trim().min(1).default('force'),
        halfOnSuccess: z.boolean().default(false),
      })
      .optional(),
    healing: z.string().min(1).optional(),
    mode: RollModeArg,
  }),
  run(args, { recorder, rng }) {
    const { state } = recorder;
    const caster = getCombatant(state, args.casterId);
    const targets = args.targetIds.map((id) => getCombatant(state, id));
    const effects = [args.attack, args.save, args.healing].filter((effect) => effect !== undefined);
    if (effects.length > 1) {
      throw new ToolError('Use only one of attack, save, or healing in a single cast_spell call.');
    }
    if (effects.length === 1 && targets.length === 0) {
      throw new ToolError(`${args.spell} needs at least one targetId.`);
    }
    const deadTarget = targets.find((target) => target.dead);
    if (deadTarget) throw new ToolError(`${deadTarget.name} is dead.`);
    const casterAfterSlot = args.slotLevel > 0 ? spendSlot(caster, args.slotLevel) : caster;

    // Resolve everything before emitting, so a rules error leaves no partial events.
    const label = `${caster.name} casts ${args.spell}`;
    const rolls: EventInput[] = [];
    // Seed with the post-slot caster so an effect that targets the caster diffs from the
    // slot-spent state, not the pre-slot one — otherwise the caster's later diff would
    // revert the slot's state_change.
    const updated = new Map<string, Combatant>([[caster.id, casterAfterSlot]]);
    const summaries: string[] = [];
    const current = (target: Combatant) => updated.get(target.id) ?? target;

    if (args.attack) {
      const spellAttack: Attack = { name: args.spell, ...args.attack };
      for (const target of targets) {
        const result = rollAttack(spellAttack, current(target), rng, args.mode);
        rolls.push(...attackRollEvents(caster.id, `${label} → ${target.name}`, result));
        updated.set(target.id, result.target);
        const verb = result.critical ? 'critically hits' : result.hit ? 'hits' : 'misses';
        const damage = result.damage ? ` for ${result.damage.total} ${spellAttack.damageType}` : '';
        summaries.push(`${verb} ${target.name}${damage}`);
      }
    }
    if (args.save) {
      const save = args.save;
      const damage = save.damage ? rollDice(save.damage, rng) : null;
      if (damage) {
        rolls.push({
          type: 'roll',
          actor: caster.id,
          kind: 'damage',
          label: `${label} damage (${save.damageType})`,
          expr: damage.expr,
          rolls: damage.rolls,
          modifier: damage.modifier,
          total: damage.total,
        });
      }
      for (const target of targets) {
        const check = resolveCheck(
          current(target),
          { type: 'save', ability: save.ability },
          save.dc,
          rng
        );
        rolls.push(checkRollEvent(target, check, `against ${args.spell}`));
        let amount = 0;
        if (damage) {
          amount = check.success
            ? save.halfOnSuccess
              ? Math.floor(damage.total / 2)
              : 0
            : damage.total;
        }
        if (amount > 0) updated.set(target.id, applyDamage(current(target), amount));
        const taken = amount > 0 ? ` and takes ${amount} ${save.damageType}` : '';
        summaries.push(`${target.name} ${check.success ? 'saves' : 'fails'}${taken}`);
      }
    }
    if (args.healing) {
      const healing = rollDice(args.healing, rng);
      rolls.push({
        type: 'roll',
        actor: caster.id,
        kind: 'healing',
        label: `${label} healing`,
        expr: healing.expr,
        rolls: healing.rolls,
        modifier: healing.modifier,
        total: healing.total,
      });
      for (const target of targets) {
        updated.set(target.id, applyHealing(current(target), healing.total));
        summaries.push(`${target.name} regains ${healing.total} HP`);
      }
    }

    emitCombatantChanges(recorder, caster, casterAfterSlot, `spell:${args.spell}`);
    for (const roll of rolls) recorder.emit(roll);
    for (const [id, after] of updated) {
      emitCombatantChanges(recorder, recorder.state.combatants[id]!, after, `spell:${args.spell}`);
    }
    const slot = args.slotLevel > 0 ? ` using a level ${args.slotLevel} slot` : '';
    const outcome = summaries.length > 0 ? `: ${summaries.join('; ')}` : '';
    return { result: `${label}${slot}${outcome}.` };
  },
});
