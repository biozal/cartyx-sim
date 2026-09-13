import {
  AbilityScores,
  Attack,
  Combatant,
  formatModifier,
  rollInitiative,
} from '@cartyx-sim/rules';
import { z } from 'zod';
import { isUp, ownEntry } from '../state';
import { slugify } from '../text';
import { defineTool, ToolError } from './types';

const MonsterSpec = z.object({
  name: z.string().trim().min(1).max(200),
  count: z.number().int().min(1).max(12).default(1),
  ac: z.number().int().min(1),
  maxHp: z.number().int().min(1),
  abilities: AbilityScores.partial().default({}),
  attacks: z.array(Attack).min(1),
});

export const startCombat = defineTool({
  name: 'start_combat',
  description:
    'Start combat with the given monsters. The engine adds them, rolls initiative for everyone who can act, and fixes turn order.',
  parameters: z.object({ monsters: z.array(MonsterSpec).min(1) }),
  run(args, { recorder, rng }) {
    const { state } = recorder;
    if (state.combat) throw new ToolError('Combat is already running. Call end_combat first.');

    const monsters: Combatant[] = [];
    // Ids share one namespace across combatants and NPCs, so skip any id either already uses.
    const taken = (id: string) =>
      ownEntry(state.combatants, id) !== undefined ||
      ownEntry(state.npcs, id) !== undefined ||
      monsters.some((m) => m.id === id);
    for (const spec of args.monsters) {
      const base = slugify(spec.name);
      if (!base) throw new ToolError(`Cannot build an id from monster name "${spec.name}"`);
      let suffix = 0;
      for (let n = 1; n <= spec.count; n++) {
        let id: string;
        do {
          suffix++;
          id = `${base}-${suffix}`;
        } while (taken(id));
        monsters.push(
          Combatant.parse({
            id,
            name: spec.count > 1 ? `${spec.name} ${n}` : spec.name,
            kind: 'monster',
            level: 1,
            abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, ...spec.abilities },
            proficiencyBonus: 2,
            ac: spec.ac,
            maxHp: spec.maxHp,
            hp: spec.maxHp,
            attacks: spec.attacks,
          })
        );
      }
    }

    const party = state.partyIds.map((id) => state.combatants[id]).filter(isUp);
    const participants = [...party, ...monsters];
    const order = rollInitiative(participants, rng);

    for (const monster of monsters) recorder.emit({ type: 'combatant_added', combatant: monster });
    for (const combatant of participants) {
      const entry = order.find((e) => e.combatantId === combatant.id)!;
      recorder.emit({
        type: 'roll',
        actor: combatant.id,
        kind: 'initiative',
        label: `${combatant.name} initiative`,
        expr: `1d20${formatModifier(entry.dexMod)}`,
        rolls: [entry.roll],
        modifier: entry.dexMod,
        total: entry.total,
        // Initiative is always a straight d20, so every d20 roll event carries a mode.
        mode: 'normal',
      });
    }
    recorder.emit({ type: 'combat_start', order });

    const names = new Map(participants.map((c) => [c.id, c.name]));
    const summary = order.map((e) => `${names.get(e.combatantId)} (${e.combatantId}) ${e.total}`);
    return { result: `Combat begins. Initiative order: ${summary.join(', ')}.` };
  },
});

export const endCombat = defineTool({
  name: 'end_combat',
  description: 'End combat once the fight is over (enemies defeated, fled, or surrendered).',
  parameters: z.object({}),
  run(_args, { recorder }) {
    if (!recorder.state.combat) throw new ToolError('There is no combat to end.');
    recorder.emit({ type: 'combat_end' });
    return { result: 'Combat ended.' };
  },
});
