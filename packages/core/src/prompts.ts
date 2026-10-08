import type { Combatant, DeathSaves } from '@cartyx-sim/rules';
import type { ChatMessage } from './model';
import { renderPremise, type Premise } from './persona';
import type { GameState, NpcRecord } from './state';
import type { PlayerView } from './view';

export interface PromptInput {
  state: GameState;
  transcript: string;
  instruction: string;
  /** The campaign's standing premise, if it has one. */
  premise?: Premise;
}

export interface PlayerPromptInput {
  /** A player-safe view of the game: no monster or NPC stat blocks. */
  view: PlayerView;
  transcript: string;
  instruction: string;
}

export interface PcControlCheckInput {
  /** The player characters' names. */
  party: string[];
  /** What each player said or declared since the DM last had the floor, one line each. */
  declarations: string[];
  /** The DM narration to check. */
  narration: string;
}

/** Builds the messages for each seat. Plan 2C replaces `basicPrompts` with lore- and persona-rich prompts. */
export interface PromptBuilder {
  dm(input: PromptInput): ChatMessage[];
  player(input: PlayerPromptInput): ChatMessage[];
  /** Asks the checker seat which narration sentences play a player character. */
  pcControlCheck(input: PcControlCheckInput): ChatMessage[];
}

const DM_SYSTEM = [
  'You are the Dungeon Master for a Dungeons & Dragons 5e session.',
  'Act only through tools. Narrate with narrate, voice NPCs with npc_say after introduce_npc, and end every turn with hand_off.',
  'All dice, damage, healing, HP, conditions, and spell slots go through tools. Never invent numbers in narration.',
  'A session has room for one fight. Once it is over, resolve later danger in the story: a stand-off, a chase, a surrender, a retreat, or a threat that withdraws.',
  "Narrate the world and the results of what players declared. Never write a player character's dialogue, thoughts, feelings, or choices.",
  'Look up lore with lookup_lore before inventing details, and record anything you invent with record_invention.',
].join('\n');

const PC_CONTROL_SYSTEM = [
  "You check a Dungeons & Dragons Dungeon Master's narration for one rule: the DM must not play the player characters.",
  "The DM may describe a player character carrying out and experiencing the action that player declared, and the world's response to it, including effects on the character.",
  'Describing where a player character is, what their injuries and conditions look like, and what the world does to them is allowed, even when the player did not say it.',
  "The result of another creature's action on a player character is the world acting on them and is allowed: an enemy's blow hitting, missing, wounding, or knocking them back. A miss may be told as the character avoiding it - twisting away, ducking, catching it on a shield - because the dice, not the player, decided the miss. On a monster's turn the players declare nothing, and that is expected. What is still a violation, on any turn, is the DM giving a player character words, thoughts, feelings, or decisions, or an action of their own: attacking, casting, moving off, using an item, or taking up a post.",
  "A violation is the DM inventing a player character's words, thoughts, feelings, or decisions, or having them take an action their player did not declare.",
  'Quote each offending sentence exactly as it appears in the narration.',
  'Reply with JSON only: {"violations": [{"pc": "<name>", "sentence": "<exact sentence>", "why": "<short reason>"}]}. Reply {"violations": []} when there are none.',
].join('\n');

/**
 * A combatant's health in one phrase: dead, dying with its death save tally, stable at 0 HP, or
 * plain hit points. Only a player character is ever dying or stable (spec §6).
 */
function describeHealth(vitals: {
  hp: number;
  maxHp: number;
  dead: boolean;
  deathSaves: DeathSaves;
  stable: boolean;
}): string {
  if (vitals.dead) return 'DEAD';
  if (vitals.stable) return 'STABLE at 0 HP';
  if (vitals.hp === 0) {
    return `DYING (death saves ${vitals.deathSaves.successes}/${vitals.deathSaves.failures})`;
  }
  return `HP ${vitals.hp}/${vitals.maxHp}`;
}

function describeCombatant(combatant: Combatant): string {
  const conditions = combatant.conditions.length > 0 ? `, ${combatant.conditions.join(', ')}` : '';
  const attacks = combatant.attacks.map((attack) => attack.name).join(', ') || 'none';
  // Carried items are listed for the same reason as attacks: so the DM works from what a
  // character has instead of inventing it (session 011 spent items nobody was carrying).
  const carrying =
    combatant.inventory
      .map((item) => (item.quantity > 1 ? `${item.quantity} × ${item.name}` : item.name))
      .join(', ') || 'nothing';
  return `- ${combatant.name} (id: ${combatant.id}) ${describeHealth(combatant)}, AC ${combatant.ac}${conditions}, attacks: ${attacks}, carrying: ${carrying}`;
}

// So a description that scrolled out of the transcript window still fits one prompt line.
const NPC_DESCRIPTION_MAX_CHARS = 200;

/** An NPC's DM-facing line: name, id, and its description (if any), collapsed to one line and truncated. */
function describeNpc(npc: NpcRecord): string {
  const base = `- ${npc.name} (npcId: ${npc.npcId})`;
  if (!npc.description) return base;
  const collapsed = npc.description.replace(/\s+/g, ' ').trim();
  const description =
    collapsed.length > NPC_DESCRIPTION_MAX_CHARS
      ? `${collapsed.slice(0, NPC_DESCRIPTION_MAX_CHARS)}…`
      : collapsed;
  return `${base}: ${description}`;
}

export const basicPrompts: PromptBuilder = {
  dm({ state, transcript, instruction, premise }) {
    const party = state.partyIds
      .map((id) => state.combatants[id])
      .filter((combatant) => combatant !== undefined)
      .map(describeCombatant);
    const others = Object.values(state.combatants)
      .filter((combatant) => combatant.kind !== 'pc')
      .map(describeCombatant);
    const npcs = Object.values(state.npcs).map(describeNpc);
    const world = renderPremise(premise);
    return [
      // The premise leads: the model has to know what world it is in before it is told how dice
      // work. Session 014 ran with no premise at all and invented a setting from nothing.
      { role: 'system', content: world === '' ? DM_SYSTEM : `${world}\n\n${DM_SYSTEM}` },
      {
        role: 'user',
        content: [
          `Party:\n${party.join('\n')}`,
          `Other combatants:\n${others.join('\n') || '- none'}`,
          `NPCs:\n${npcs.join('\n') || '- none'}`,
          `Scene: ${state.scene?.location ?? 'not set'}`,
          // Said in the moment as well as in the system rules, since by the time it matters the
          // system message is far up a long prompt.
          state.fightsSoFar > 0
            ? 'This session has had its fight. No new fight can start: resolve any danger from here in the story.'
            : 'This session has not had its fight yet. It has room for one.',
          `Recent events:\n${transcript || '(the session is just starting)'}`,
          instruction,
        ].join('\n\n'),
      },
    ];
  },
  player({ view, transcript, instruction }) {
    const allies = view.allies.map((ally) => {
      const conditions = ally.conditions.length > 0 ? `, ${ally.conditions.join(', ')}` : '';
      return `- ${ally.name} (id: ${ally.id}) ${describeHealth(ally)}${conditions}`;
    });
    const others = view.others.map((other) => `- ${other.name} (id: ${other.id}): ${other.status}`);
    return [
      {
        role: 'system',
        content: [
          `You are playing ${view.pc.name} (id: ${view.pc.id}) in a Dungeons & Dragons 5e session.`,
          'Stay in character. Use speak for dialogue and act to declare what you attempt; use pass if your character does nothing.',
          'Only ever control your own character, and never describe the outcome of your actions: the DM decides what happens.',
          'Use fresh wording: do not reuse phrases or lines you have already said this session.',
          ...(view.inCombat && view.yourTurn
            ? ['Say one short line in character as you act, unless silence fits the moment better.']
            : []),
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
  pcControlCheck({ party, declarations, narration }) {
    const declared = declarations.map((line) => `- ${line}`).join('\n') || '- nothing';
    return [
      { role: 'system', content: PC_CONTROL_SYSTEM },
      {
        role: 'user',
        content: [
          `Player characters: ${party.join(', ')}`,
          `What each player declared or said since the DM last spoke:\n${declared}`,
          `DM narration to check:\n${narration}`,
        ].join('\n\n'),
      },
    ];
  },
};
