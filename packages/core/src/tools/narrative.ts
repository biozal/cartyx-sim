import { z } from 'zod';
import { HandOffTarget } from '../events';
import { ownEntry, selectResponders } from '../state';
import { slugify } from '../text';
import { coercedEmotion, defineTool, SpokenText, ToolError } from './types';

export const LORE_RESULT_LIMIT = 8;

export const narrate = defineTool({
  name: 'narrate',
  description:
    'Speak as the Dungeon Master: describe scenes, events, and outcomes. Never decide what player characters do, say, or feel.',
  parameters: z.object({
    text: z.string().trim().min(1).max(4000),
    emotion: coercedEmotion('neutral'),
  }),
  narrativeText: (args) => args.text,
  run(args, { recorder }) {
    recorder.emit({ type: 'narration', speaker: 'dm', text: args.text, emotion: args.emotion });
    return { result: 'Narrated.' };
  },
});

export const introduceNpc = defineTool({
  name: 'introduce_npc',
  description:
    'Introduce a non-player character before they speak. The engine namespaces their id as ' +
    '"npc-<slug>" (returned in the result) so it can never collide with a player character\'s id. ' +
    'Set loreEntityId when the NPC comes from the lore; set invented to true if you made them up.',
  parameters: z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000),
    invented: z.boolean(),
    loreEntityId: z.string().min(1).max(200).optional(),
  }),
  run(args, { recorder }) {
    const slug = slugify(args.name);
    if (!slug) throw new ToolError(`Cannot build an id from NPC name "${args.name}"`);
    const { state } = recorder;
    const name = args.name.trim().toLowerCase();
    const pc = state.partyIds
      .map((id) => ownEntry(state.combatants, id))
      .find((combatant) => combatant?.name.trim().toLowerCase() === name);
    if (pc) {
      throw new ToolError(
        `"${pc.name}" is a player character's name. Use a distinct name for the NPC.`
      );
    }
    const npcId = `npc-${slug}`;
    if (ownEntry(recorder.state.npcs, npcId)) {
      return { result: `${args.name} is already introduced; use npcId "${npcId}".` };
    }
    if (ownEntry(recorder.state.combatants, npcId)) {
      throw new ToolError(`Id "${npcId}" already names a combatant.`);
    }
    recorder.emit({
      type: 'npc_introduced',
      npcId,
      name: args.name,
      description: args.description,
      invented: args.invented,
      loreEntityId: args.loreEntityId,
    });
    return { result: `Introduced ${args.name} with npcId "${npcId}".` };
  },
});

export const npcSay = defineTool({
  name: 'npc_say',
  description: 'Speak a line of dialogue as an introduced NPC, using their npcId.',
  parameters: z.object({
    npcId: z.string().trim().min(1).max(200),
    text: SpokenText,
    emotion: coercedEmotion('neutral'),
  }),
  narrativeText: (args) => args.text,
  run(args, { recorder }) {
    const npc = ownEntry(recorder.state.npcs, args.npcId);
    if (!npc) {
      const known = Object.keys(recorder.state.npcs).join(', ') || 'none';
      throw new ToolError(
        `Unknown npcId "${args.npcId}". Call introduce_npc first. Known NPCs: ${known}`
      );
    }
    recorder.emit({
      type: 'dialogue',
      speaker: npc.npcId,
      speakerKind: 'npc',
      text: args.text,
      emotion: args.emotion,
    });
    return { result: `${npc.name} spoke.` };
  },
});

export const sceneChange = defineTool({
  name: 'scene_change',
  description:
    'Move the story to a new location or scene. artPrompt describes the scene for an illustrator.',
  parameters: z.object({
    location: z.string().trim().min(1).max(200),
    artPrompt: z.string().trim().min(1).max(2000),
    loreEntityId: z.string().min(1).max(200).optional(),
  }),
  run(args, { recorder }) {
    if (recorder.state.combat) {
      throw new ToolError('Combat is still running. Call end_combat first, then scene_change.');
    }
    recorder.emit({ type: 'scene_change', ...args });
    return { result: `The scene is now ${args.location}.` };
  },
});

export const lookupLore = defineTool({
  name: 'lookup_lore',
  description:
    'Search the Cartyx world lore (people, places, factions, history). Look details up before inventing them.',
  parameters: z.object({ query: z.string().trim().min(3).max(200) }),
  async run(args, { recorder, lore, loreThreshold }) {
    const hits = await lore.search(args.query, LORE_RESULT_LIMIT);
    const used = hits.filter((hit) => hit.score >= loreThreshold);
    recorder.emit({
      type: 'lore_lookup',
      visibility: 'dm',
      query: args.query,
      hits: hits.map(({ chunkId, source, score }) => ({ chunkId, source, score })),
      used: used.map((hit) => hit.chunkId),
    });
    if (used.length === 0) {
      return {
        result:
          'No lore found. If the story needs this detail, invent something consistent with the setting and call record_invention.',
      };
    }
    return {
      result: used
        .map((hit) => `[${hit.chunkId}] ${hit.title} (${hit.source})\n${hit.text}`)
        .join('\n\n'),
    };
  },
});

export const recordInvention = defineTool({
  name: 'record_invention',
  description:
    'Record a fact you invented because the lore did not cover it, so the author can review it later.',
  parameters: z.object({
    fact: z.string().trim().min(1).max(2000),
    reason: z.string().trim().min(1).max(2000),
  }),
  run(args, { recorder }) {
    // The query is the engine's own, not the model's: attaching whatever the model last searched
    // for produced a stale query on an invention that had nothing to do with it. `recorder.events`
    // holds only this turn, so a lookup from an earlier turn never lingers here either.
    const lookup = recorder.events.findLast((event) => event.type === 'lore_lookup');
    recorder.emit({
      type: 'lore_invention',
      visibility: 'dm',
      fact: args.fact,
      reason: args.reason,
      ...(lookup ? { query: lookup.query } : {}),
    });
    return { result: 'Recorded.' };
  },
});

/** The id shape used everywhere else: a lowercase-alnum token, hyphens allowed after the first char. */
const ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Accepts the strict `{ kind: ... }` object, or a bare string shorthand a model sends instead.
 * After trimming, "party" or "open" map to those kinds, and a string matching {@link ID_SHAPE} is
 * treated as a single player character id (`{ kind: 'pcs', ids: [string] }`) — an id that names no
 * real party member still errors below with today's message. Any other string (garbled tool-call
 * syntax, a comma-separated list, an empty string) is a shape error, not a list of ids: it never
 * reaches `state.partyIds`, so it can't be misread as an unknown-id problem.
 */
const HandOffTargetArg = z.union([
  z.string().meta({
    description: 'Shorthand: "party", "open", or one player character id such as "kira".',
    examples: ['party', 'open', 'kira'],
  }),
  HandOffTarget,
]);

const HAND_OFF_SHAPE_ERROR =
  'hand_off target must be an object like {"kind": "party"}, {"kind": "open"}, or ' +
  '{"kind": "pcs", "ids": ["kira"]}.';

function normalizeHandOffTarget(target: string | HandOffTarget): HandOffTarget {
  if (typeof target !== 'string') return target;
  const trimmed = target.trim();
  if (trimmed === 'party') return { kind: 'party' };
  if (trimmed === 'open') return { kind: 'open' };
  if (ID_SHAPE.test(trimmed)) return { kind: 'pcs', ids: [trimmed] };
  throw new ToolError(HAND_OFF_SHAPE_ERROR);
}

export const handOff = defineTool({
  name: 'hand_off',
  description:
    'End your turn and pass the spotlight: to specific player characters (kind "pcs" with ids), the whole party ("party"), or whoever wants to act ("open"). In combat, initiative decides who acts next.',
  parameters: z.object({ target: HandOffTargetArg }),
  run(args, { recorder }) {
    const { state } = recorder;
    let target = normalizeHandOffTarget(args.target);
    // A DM in combat hands the spotlight to whoever initiative says is next, monsters included
    // (session 011 did it four times). Initiative already decides that, so a hand-off naming only
    // combatants is taken as a hand-off to the party rather than an error.
    let coerced = '';
    if (target.kind === 'pcs') {
      const unknown = target.ids.filter((id) => !state.partyIds.includes(id));
      if (unknown.length > 0) {
        const combatants = unknown.filter((id) => ownEntry(state.combatants, id) !== undefined);
        // Only when every id is a combatant: a hand-off naming a player character as well means
        // the DM wants that character, so dropping them for the party would lose the instruction.
        if (state.combat && combatants.length === target.ids.length) {
          coerced = ` ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a player character, so initiative decides who acts next.`;
          target = { kind: 'party' };
        } else {
          const others = unknown.filter(
            (id) =>
              ownEntry(state.combatants, id) !== undefined || ownEntry(state.npcs, id) !== undefined
          );
          if (others.length > 0) {
            throw new ToolError(
              `Only player characters take the spotlight, and ${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} not one: act for monsters and NPCs with tools during your own turn. Unknown ids: ${unknown.join(', ')}. Hand off to player characters by id, or to the party with {"kind": "party"}; in combat, initiative picks who acts next. Party ids: ${state.partyIds.join(', ')}`
            );
          }
          throw new ToolError(
            `Unknown player character ids: ${unknown.join(', ')}. Party ids: ${state.partyIds.join(', ')}`
          );
        }
      }
    }
    const responders = selectResponders(target, state);
    recorder.emit({ type: 'hand_off', target, responders });
    let result = 'Handed off.';
    if (responders.length > 0) result = `Handed off to ${responders.join(', ')}.`;
    else if (!state.combat) {
      result =
        'Nobody can respond: no player character you handed off to is able to act. Resolve that in ' +
        'the story (healing, rescue, or a scene change) before handing off again.';
    }
    return { result: result + coerced, endsBeat: true };
  },
});
