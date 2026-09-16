import { ownEntry } from '@cartyx-sim/core';
import {
  isVoiced,
  ScriptError,
  type ScriptLine,
  type Speaker,
  type SpeakerOverrides,
} from './schema';

/** Every speaker a script mentions, in the order they were first added. */
export class SpeakerTable {
  private readonly byId = new Map<string, Speaker>();

  constructor(party: readonly { id: string; name: string }[]) {
    this.byId.set('dm', { id: 'dm', name: 'Dungeon Master', kind: 'dm' });
    for (const pc of party) this.byId.set(pc.id, { id: pc.id, name: pc.name, kind: 'pc' });
  }

  /** A player character; one missing from the party is added with its id as its name. */
  pc(id: string): string {
    return this.add({ id, name: id, kind: 'pc' });
  }

  /** An NPC introduced by an `npc_introduced` event. */
  npc(id: string, name: string): string {
    return this.add({ id, name, kind: 'npc' });
  }

  /** An NPC the DM voiced without introducing it. */
  unlisted(id: string, name: string, seq: number): string {
    return this.add({ id, name, kind: 'npc', unlisted: true, firstSeq: seq });
  }

  list(): Speaker[] {
    return [...this.byId.values()].map((speaker) => ({ ...speaker }));
  }

  /**
   * Turns an unlisted NPC into a listed one named `name`, keeping its position in the table.
   * Does nothing if `id` is not an unlisted speaker.
   */
  promote(id: string, name: string): void {
    const speaker = this.byId.get(id);
    if (!speaker?.unlisted) return;
    const entries = [...this.byId.entries()].map(([key, value]): [string, Speaker] =>
      key === id ? [key, { id, name, kind: 'npc' }] : [key, value]
    );
    this.byId.clear();
    for (const [key, value] of entries) this.byId.set(key, value);
  }

  private add(speaker: Speaker): string {
    if (!this.byId.has(speaker.id)) this.byId.set(speaker.id, speaker);
    return speaker.id;
  }
}

function fail(message: string): never {
  throw new ScriptError(`speakers.json: ${message}`);
}

/**
 * Applies `speakers.json`: renames speakers and merges NPCs into other NPCs, moving their lines.
 * Throws a `ScriptError` naming the key for anything it cannot apply.
 */
export function applySpeakerOverrides(
  speakers: readonly Speaker[],
  lines: readonly ScriptLine[],
  overrides: SpeakerOverrides
): { speakers: Speaker[]; lines: ScriptLine[] } {
  const byId = new Map(speakers.map((speaker) => [speaker.id, speaker]));
  const known = () => [...byId.keys()].join(', ');
  const merges = new Map<string, string>();
  const names = new Map<string, string>();
  for (const [key, change] of Object.entries(overrides)) {
    const speaker = byId.get(key);
    if (!speaker) fail(`"${key}" is not a speaker in this script. Speakers: ${known()}`);
    const target = change.id !== undefined && change.id !== key ? change.id : undefined;
    if (target === undefined) {
      if (change.name !== undefined) names.set(key, change.name);
      continue;
    }
    if (change.name !== undefined) {
      fail(`"${key}" sets both "id" and "name"; set the name on "${target}" instead`);
    }
    if (speaker.kind !== 'npc') fail(`"${key}" is a ${speaker.kind}; only NPCs can be merged`);
    const into = byId.get(target);
    if (!into)
      fail(`"${key}" merges into "${target}", which is not a speaker. Speakers: ${known()}`);
    if (into.kind !== 'npc') fail(`"${key}" cannot merge into the ${into.kind} "${target}"`);
    const next = ownEntry(overrides, target)?.id;
    if (next !== undefined && next !== target) {
      fail(
        `"${key}" merges into "${target}", which is itself merged; merge into "${next}" instead`
      );
    }
    merges.set(key, target);
  }

  const merged = speakers
    .filter((speaker) => !merges.has(speaker.id))
    .map((speaker) => {
      const result: Speaker = { ...speaker };
      const name = names.get(speaker.id);
      if (name !== undefined) result.name = name;
      if (result.unlisted) {
        const seqs = speakers
          .filter((other) => other.id === speaker.id || merges.get(other.id) === speaker.id)
          .map((other) => other.firstSeq)
          .filter((seq): seq is number => seq !== undefined);
        if (seqs.length > 0) result.firstSeq = Math.min(...seqs);
      }
      return result;
    });
  const moved = lines.map((line) => {
    if (!isVoiced(line)) return line;
    const speaker = merges.get(line.speaker);
    return speaker === undefined ? line : { ...line, speaker };
  });
  return { speakers: merged, lines: moved };
}
