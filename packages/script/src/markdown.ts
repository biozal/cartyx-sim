import { countWords, hpTrend } from '@cartyx-sim/core';
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

/** A death save tally as "2 death save successes, 1 failure"; `after` comes from the log as-is. */
function deathSaves(after: unknown): string {
  const tally = after as { successes?: unknown; failures?: unknown } | null;
  const successes = Number(tally?.successes) || 0;
  const failures = Number(tally?.failures) || 0;
  return `${successes} death save success${successes === 1 ? '' : 'es'}, ${failures} failure${failures === 1 ? '' : 's'}`;
}

/**
 * Spec §5.5 of the v1 design: a non-PC's HP numbers never appear, only how it is doing. Returns
 * null for a hidden entity whose HP did not change, so `renderScriptMarkdown` adds no block.
 */
function stateChange({ state }: StateLine): string | null {
  if (state.field === 'dead') return `*${state.name} dies.*`;
  if (state.field === 'conditions') {
    const list = Array.isArray(state.after) ? state.after.map(String).join(', ') : '';
    return `*${state.name} conditions: ${list || 'none'}.*`;
  }
  if (state.field === 'deathSaves') return `*${state.name}: ${deathSaves(state.after)}.*`;
  // Losing stability always comes with a death save failure, which cues itself.
  if (state.field === 'stable') return state.after === true ? `*${state.name} is stable.*` : null;
  if (state.hidden) {
    switch (hpTrend(state.before, state.after)) {
      case 'down':
        return `*${state.name} is down.*`;
      case 'wounded':
        return `*${state.name} is wounded.*`;
      case 'recovers':
        return `*${state.name} recovers.*`;
      case 'unchanged':
        return null;
      case 'unknown':
        return `*${state.name}'s condition changes.*`;
    }
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
    `- Events: \`${script.eventsSha256.slice(0, 12)}\``,
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
      case 'state': {
        const cue = stateChange(line);
        if (cue !== null) blocks.push(cue);
        break;
      }
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
