import { z } from 'zod';
import { Emotion, HandOffTarget } from '../events';
import { ownEntry, selectResponders } from '../state';
import { slugify } from '../text';
import { defineTool, ToolError } from './types';

export const LORE_RESULT_LIMIT = 8;

export const narrate = defineTool({
  name: 'narrate',
  description:
    'Speak as the Dungeon Master: describe scenes, events, and outcomes. Never decide what player characters do, say, or feel.',
  parameters: z.object({
    text: z.string().trim().min(1).max(4000),
    emotion: Emotion.default('neutral'),
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
    text: z.string().trim().min(1).max(4000),
    emotion: Emotion.default('neutral'),
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
    query: z.string().trim().min(1).max(200).optional(),
  }),
  run(args, { recorder }) {
    recorder.emit({ type: 'lore_invention', visibility: 'dm', ...args });
    return { result: 'Recorded.' };
  },
});

export const handOff = defineTool({
  name: 'hand_off',
  description:
    'End your turn and pass the spotlight: to specific player characters (kind "pcs" with ids), the whole party ("party"), or whoever wants to act ("open"). In combat, initiative decides who acts next.',
  parameters: z.object({ target: HandOffTarget }),
  run(args, { recorder }) {
    const { state } = recorder;
    if (args.target.kind === 'pcs') {
      const unknown = args.target.ids.filter((id) => !state.partyIds.includes(id));
      if (unknown.length > 0) {
        throw new ToolError(
          `Unknown player character ids: ${unknown.join(', ')}. Party ids: ${state.partyIds.join(', ')}`
        );
      }
    }
    const responders = selectResponders(args.target, state);
    recorder.emit({ type: 'hand_off', target: args.target, responders });
    return {
      result: responders.length > 0 ? `Handed off to ${responders.join(', ')}.` : 'Handed off.',
      endsBeat: true,
    };
  },
});
