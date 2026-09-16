import { countWords } from '@cartyx-sim/core';
import {
  isVoiced,
  type CombatLine,
  type RollLine,
  type ScriptFile,
  type StateLine,
  type VoicedLine,
} from './schema';

const WORDS_PER_MINUTE = 150;

type NameOf = (id: string) => string;

function aside(text: string): string {
  return ` *(${text.replace(/[*_]/g, '').replace(/\s+/g, ' ').trim()})*`;
}

function dialogue(line: VoicedLine, nameOf: NameOf): string {
  const name = line.flags ? `DM (as ${nameOf(line.flags.dmWrotePc)})` : nameOf(line.speaker);
  const interrupting = line.overlaps ? ' *(interrupting)*' : '';
  const asides = (line.dropped ?? [])
    .filter((span) => span.reason === 'stage_direction')
    .map((span) => aside(span.text))
    .join('');
  return `**${name}:**${interrupting} ${line.text}${asides}`;
}

function roll({ roll }: RollLine): string {
  const against = roll.kind !== 'attack' && roll.target !== undefined ? ` vs ${roll.target}` : '';
  const outcome = roll.outcome ? ` — ${roll.outcome}` : '';
  return `> 🎲 *${roll.label}:* ${roll.total}${against}${outcome}`;
}

function combat({ combat }: CombatLine): string {
  switch (combat.phase) {
    case 'start': {
      const order = combat.order.map((entry) => `${entry.name} ${entry.total}`).join(', ');
      return `*Combat begins. Initiative: ${order}.*`;
    }
    case 'turn':
      return `*Round ${combat.round}: ${combat.name}'s turn.*`;
    case 'end':
      return '*Combat ends.*';
  }
}

/** Spec §5.5 of the v1 design: a non-PC's HP numbers never appear, only how it is doing. */
function stateChange({ state }: StateLine): string {
  if (state.field === 'dead') return `*${state.name} dies.*`;
  if (state.field === 'conditions') {
    const list = Array.isArray(state.after) ? state.after.map(String).join(', ') : '';
    return `*${state.name} conditions: ${list || 'none'}.*`;
  }
  if (state.hidden) {
    const after = Number(state.after);
    const how = after <= 0 ? 'is down' : after < Number(state.before) ? 'is wounded' : 'recovers';
    return `*${state.name} ${how}.*`;
  }
  return `*${state.name}: HP ${String(state.before)} → ${String(state.after)}.*`;
}

/** The script as a book-style markdown read. Uses only what `script.json` holds. */
export function renderScriptMarkdown(script: ScriptFile): string {
  const names = new Map(script.speakers.map((speaker) => [speaker.id, speaker.name]));
  const nameOf: NameOf = (id) => names.get(id) ?? id;
  const spoken = script.lines.filter(isVoiced);
  const words = spoken.reduce((sum, line) => sum + countWords(line.text), 0);
  const minutes = (words / WORDS_PER_MINUTE).toFixed(1);
  const header = [
    `# ${script.campaign} — Session ${script.session}`,
    '',
    `- Lines: ${spoken.length} spoken, ${script.lines.length - spoken.length} cues · ` +
      `spoken words: ${words} (~${minutes} min)`,
  ];
  const unlisted = script.speakers.filter((speaker) => speaker.unlisted);
  if (unlisted.length > 0) {
    const list = unlisted.map((speaker) => `${speaker.name} (${speaker.id})`).join(', ');
    header.push(`- Unlisted NPC speakers: ${list}`);
  }
  if (script.notes.length > 0) {
    header.push(`- Notes: ${script.notes.length} (listed at the end)`);
  }

  const blocks = [header.join('\n'), '---'];
  let inNarration = false;
  for (const line of script.lines) {
    if (line.kind === 'narration') {
      blocks.push(inNarration ? line.text : `**DM:** ${line.text}`);
      inNarration = true;
      continue;
    }
    inNarration = false;
    switch (line.kind) {
      case 'dialogue':
        blocks.push(dialogue(line, nameOf));
        break;
      case 'action':
        blocks.push(`> *${nameOf(line.speaker)}:* ${line.text}`);
        break;
      case 'roll':
        blocks.push(roll(line));
        break;
      case 'scene':
        blocks.push(`## ${line.scene.location}`);
        break;
      case 'combat':
        blocks.push(combat(line));
        break;
      case 'state':
        blocks.push(stateChange(line));
        break;
      case 'pause':
        blocks.push('---', '*The session paused here and resumed later.*', '---');
        break;
    }
  }
  if (script.notes.length > 0) {
    blocks.push(
      '## Notes',
      script.notes.map((note) => `- Event ${note.seq}: ${note.text}`).join('\n')
    );
  }
  return `${blocks.join('\n\n')}\n`;
}
