import {
  AbilityScores,
  Attack,
  Combatant,
  formatModifier,
  rollInitiative,
} from '@cartyx-sim/rules';
import { z } from 'zod';
import { ownEntry } from '../state';
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

/** Fights allowed in one session. The engine refuses `start_combat` past this (spec §5.7). */
export const FIGHTS_PER_SESSION = 1;

export const startCombat = defineTool({
  name: 'start_combat',
  description:
    "Start the session's one fight with the given monsters. The engine adds them, rolls initiative for every living combatant (a party member at 0 HP joins the order and spends their turns rolling death saving throws), and fixes turn order. A session has room for one fight, so once this one is over no other can start.",
  parameters: z.object({ monsters: z.array(MonsterSpec).min(1) }),
  run(args, { recorder, rng, clockPhase }) {
    const { state } = recorder;
    if (state.combat) throw new ToolError('Combat is already running. Call end_combat first.');
    // One fight a session (spec §5.7): the session is a story to read, and a second fight crowds
    // out the talking, searching, and travelling that carry the lore being tested.
    if (state.fightsSoFar >= FIGHTS_PER_SESSION) {
      throw new ToolError(
        'This session has already had its fight, and a session has room for one. Resolve this danger in the story instead: a stand-off, a chase, a surrender, a retreat, or a threat that withdraws.'
      );
    }
    // From the target on, the session ends at the next scene change, so a fight started now
    // would be cut off before its first round (session 008 rolled initiative, then ended).
    const phase = clockPhase();
    if (phase === 'end_at_scene_break' || phase === 'hard_stop') {
      throw new ToolError(
        'Time is up: no new fight can start. Close the scene and call scene_change.'
      );
    }

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

    // Every living party member joins initiative, even at 0 HP: a dying PC's turn is a death
    // saving throw, and a PC healed mid-fight acts again on their next one.
    const party = state.partyIds
      .map((id) => ownEntry(state.combatants, id))
      .filter((pc): pc is Combatant => pc !== undefined && !pc.dead);
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
