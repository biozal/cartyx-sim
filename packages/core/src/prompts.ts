import type { Combatant } from '@cartyx-sim/rules';
import type { ChatMessage } from './model';
import type { GameState } from './state';
import type { PlayerView } from './view';

export interface PromptInput {
  state: GameState;
  transcript: string;
  instruction: string;
}

export interface PlayerPromptInput {
  /** A player-safe view of the game: no monster or NPC stat blocks. */
  view: PlayerView;
  transcript: string;
  instruction: string;
}

/** Builds the messages for each seat. Plan 2C replaces `basicPrompts` with lore- and persona-rich prompts. */
export interface PromptBuilder {
  dm(input: PromptInput): ChatMessage[];
  player(input: PlayerPromptInput): ChatMessage[];
}

const DM_SYSTEM = [
  'You are the Dungeon Master for a Dungeons & Dragons 5e session.',
  'Act only through tools. Narrate with narrate, voice NPCs with npc_say after introduce_npc, and end every turn with hand_off.',
  'All dice, damage, healing, HP, conditions, and spell slots go through tools. Never invent numbers in narration.',
  'Never decide what a player character does, says, thinks, or feels.',
  'Look up lore with lookup_lore before inventing details, and record anything you invent with record_invention.',
].join('\n');

function describeCombatant(combatant: Combatant): string {
  const health = combatant.dead ? 'DEAD' : `HP ${combatant.hp}/${combatant.maxHp}`;
  const conditions = combatant.conditions.length > 0 ? `, ${combatant.conditions.join(', ')}` : '';
  return `- ${combatant.name} (id: ${combatant.id}) ${health}, AC ${combatant.ac}${conditions}`;
}

export const basicPrompts: PromptBuilder = {
  dm({ state, transcript, instruction }) {
    const party = state.partyIds
      .map((id) => state.combatants[id])
      .filter((combatant) => combatant !== undefined)
      .map(describeCombatant);
    const others = Object.values(state.combatants)
      .filter((combatant) => combatant.kind !== 'pc')
      .map(describeCombatant);
    const npcs = Object.values(state.npcs).map((npc) => `- ${npc.name} (npcId: ${npc.npcId})`);
    return [
      { role: 'system', content: DM_SYSTEM },
      {
        role: 'user',
        content: [
          `Party:\n${party.join('\n')}`,
          `Other combatants:\n${others.join('\n') || '- none'}`,
          `NPCs:\n${npcs.join('\n') || '- none'}`,
          `Scene: ${state.scene?.location ?? 'not set'}`,
          `Recent events:\n${transcript || '(the session is just starting)'}`,
          instruction,
        ].join('\n\n'),
      },
    ];
  },
  player({ view, transcript, instruction }) {
    const allies = view.allies.map((ally) => {
      const health = ally.dead ? 'DEAD' : `HP ${ally.hp}/${ally.maxHp}`;
      const conditions = ally.conditions.length > 0 ? `, ${ally.conditions.join(', ')}` : '';
      return `- ${ally.name} (id: ${ally.id}) ${health}${conditions}`;
    });
    const others = view.others.map((other) => `- ${other.name} (id: ${other.id}): ${other.status}`);
    return [
      {
        role: 'system',
        content: [
          `You are playing ${view.pc.name} (id: ${view.pc.id}) in a Dungeons & Dragons 5e session.`,
          'Stay in character. Use speak for dialogue and act to declare what you attempt; use pass if your character does nothing.',
          'Only ever control your own character, and never describe the outcome of your actions: the DM decides what happens.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Your character:\n${describeCombatant(view.pc)}`,
          `Party:\n${allies.join('\n') || '- just you'}`,
          `Others here:\n${others.join('\n') || '- none'}`,
          `Scene: ${view.scene ?? 'not set'}`,
          `Recent events:\n${transcript || '(nothing yet)'}`,
          instruction,
        ].join('\n\n'),
      },
    ];
  },
};
