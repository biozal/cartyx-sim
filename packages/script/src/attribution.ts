import {
  countWords,
  findJsonReply,
  slugify,
  type ChatMessage,
  type ModelClient,
} from '@cartyx-sim/core';
import { z } from 'zod';

/** Part of every cache key: bump it whenever the prompt or the label rules change. */
export const LABEL_PROMPT_VERSION = 1;

/** The `new:` label the rules fallback gives a speaker it cannot name. */
export const UNNAMED_LABEL = 'unnamed';

const MAX_NEW_LABEL = 60;
const REPLY_ATTEMPTS = 2;
// A thinking model sometimes spends its whole budget thinking; retry that once on the same target.
const INCOMPLETE_REPLY_ATTEMPTS = 2;

/** One narration's quotes, as the labeler sees them. */
export interface LabelRequest {
  seq: number;
  /** The cleaned narration with `[[n]]` before each quote. */
  narration: string;
  /** The finished text of each quote; quote n is `quotes[n - 1]`. */
  quotes: string[];
  npcs: { id: string; name: string; description: string }[];
  pcs: { id: string; name: string }[];
  /** `new:` labels already given this session, without the prefix. */
  newLabels: string[];
}

export type SpanLabel =
  | { kind: 'npc'; id: string }
  | { kind: 'new'; label: string }
  | { kind: 'pc'; id: string }
  | { kind: 'none' };

export type LabelResult =
  { labels: SpanLabel[]; source: 'model' | 'cache' } | { labels: null; reason: string };

export interface Labeler {
  label(request: LabelRequest): Promise<LabelResult>;
}

export const LabelReply = z.object({
  labels: z.array(z.object({ quote: z.number().int(), speaker: z.string() })),
});
export type LabelReply = z.infer<typeof LabelReply>;

const SYSTEM_PROMPT = [
  "You label quotations in a Dungeon Master's narration from a tabletop role-playing game.",
  'Each quotation is marked with a number in double brackets, such as [[1]], placed just before it.',
  'For each quotation, give its speaker:',
  '- the id of a known NPC, when that NPC says it;',
  '- "new:<short description>" when a character with no id says it, such as "new:faceless creature"; reuse an earlier new: label when it is the same character;',
  '- the id of a player character, when the narration has that player character say it;',
  '- "none" when it is not speech: a sign, an inscription, a name, a sound, or an emphasized word.',
  'Reply with only a JSON object: {"labels": [{"quote": 1, "speaker": "..."}]}, with one entry per quotation.',
].join('\n');

function listOrNone(items: readonly string[]): string {
  return items.length > 0 ? items.join('\n') : '(none)';
}

export function buildLabelMessages(request: LabelRequest): ChatMessage[] {
  const count = request.quotes.length;
  const user = [
    'Known NPCs:',
    listOrNone(request.npcs.map((npc) => `- ${npc.id}: ${npc.name} — ${npc.description}`)),
    '',
    'Player characters:',
    listOrNone(request.pcs.map((pc) => `- ${pc.id}: ${pc.name}`)),
    '',
    'Earlier new: labels this session:',
    listOrNone(request.newLabels.map((label) => `- new:${label}`)),
    '',
    `Narration (${count} quotation${count === 1 ? '' : 's'}):`,
    request.narration,
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

function toSpanLabel(speaker: string, request: LabelRequest): SpanLabel | null {
  const value = speaker.trim();
  if (value.toLowerCase() === 'none') return { kind: 'none' };
  const created = /^new:([\s\S]*)$/i.exec(value);
  if (created) {
    const label = created[1]!.trim().toLowerCase();
    const usable = label.length > 0 && label.length <= MAX_NEW_LABEL && slugify(label) !== '';
    return usable ? { kind: 'new', label } : null;
  }
  if (request.npcs.some((npc) => npc.id === value)) return { kind: 'npc', id: value };
  if (request.pcs.some((pc) => pc.id === value)) return { kind: 'pc', id: value };
  return null;
}

/** Checks that every quote is labeled exactly once with a speaker the request allows. */
export function checkLabels(
  reply: LabelReply,
  request: LabelRequest
): { labels: SpanLabel[] } | { error: string } {
  const count = request.quotes.length;
  const found = new Map<number, SpanLabel>();
  for (const entry of reply.labels) {
    if (entry.quote < 1 || entry.quote > count) {
      return { error: `quote ${entry.quote} does not exist; quotes are numbered 1 to ${count}` };
    }
    if (found.has(entry.quote)) return { error: `quote ${entry.quote} is labeled twice` };
    const label = toSpanLabel(entry.speaker, request);
    if (!label) return { error: `quote ${entry.quote}: unknown speaker "${entry.speaker}"` };
    found.set(entry.quote, label);
  }
  const labels: SpanLabel[] = [];
  for (let n = 1; n <= count; n++) {
    const label = found.get(n);
    if (!label) return { error: `quote ${n} has no label` };
    labels.push(label);
  }
  return { labels };
}

/** The labels in a model reply, or what is wrong with it. */
export function parseLabelReply(
  text: string,
  request: LabelRequest
): { labels: SpanLabel[]; reply: LabelReply } | { error: string } {
  const reply = findJsonReply(text, (value) => {
    const parsed = LabelReply.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  if (!reply) {
    return { error: 'no JSON object of the form {"labels": [{"quote": 1, "speaker": "..."}]}' };
  }
  const checked = checkLabels(reply, request);
  return 'error' in checked ? checked : { labels: checked.labels, reply };
}

/**
 * Labels without a model: a quote of fewer than 3 words is not speech; any other quote belongs to
 * the scene's only introduced NPC when there is exactly one, else to an unnamed speaker.
 */
export function fallbackLabels(request: LabelRequest, sceneNpcIds: readonly string[]): SpanLabel[] {
  const only = sceneNpcIds.length === 1 ? sceneNpcIds[0] : undefined;
  return request.quotes.map((text): SpanLabel => {
    if (countWords(text) < 3) return { kind: 'none' };
    return only ? { kind: 'npc', id: only } : { kind: 'new', label: UNNAMED_LABEL };
  });
}

export async function labelCacheKey(modelId: string, request: LabelRequest): Promise<string> {
  const data = new TextEncoder().encode(
    JSON.stringify({ version: LABEL_PROMPT_VERSION, model: modelId, request })
  );
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Stores model replies by key. `get` returns undefined for a miss. */
export interface LabelCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface ModelLabelerOptions {
  model: ModelClient;
  seat: string;
  /** The seat's model id, part of the cache key. */
  modelId: string;
  cache?: LabelCache;
  /** Ignore cached replies (new replies are still cached). */
  refresh?: boolean;
}

/**
 * Labels quotes with a model seat. The reply must pass `checkLabels`; an unusable reply is
 * retried once with the problem stated. A seat failure or a second unusable reply returns
 * `labels: null` with the reason, so the caller can fall back to rules. Never throws for a seat.
 */
export class ModelLabeler implements Labeler {
  constructor(private readonly options: ModelLabelerOptions) {}

  async label(request: LabelRequest): Promise<LabelResult> {
    const { model, seat, modelId, cache, refresh } = this.options;
    const key = await labelCacheKey(modelId, request);
    if (cache && !refresh) {
      const hit = LabelReply.safeParse(await cache.get(key));
      if (hit.success) {
        const checked = checkLabels(hit.data, request);
        if ('labels' in checked) return { labels: checked.labels, source: 'cache' };
      }
    }
    const messages = buildLabelMessages(request);
    let problem = '';
    for (let attempt = 0; attempt < REPLY_ATTEMPTS; attempt++) {
      let text: string;
      try {
        const response = await model.complete({
          seat,
          turnId: `script-${request.seq}`,
          messages,
          tools: [],
          toolChoice: 'auto',
          incompleteReplyAttempts: INCOMPLETE_REPLY_ATTEMPTS,
        });
        text = response.text;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { labels: null, reason: `script seat unavailable (${message})` };
      }
      const parsed = parseLabelReply(text, request);
      if ('labels' in parsed) {
        await cache?.set(key, parsed.reply);
        return { labels: parsed.labels, source: 'model' };
      }
      problem = parsed.error;
      messages.push(
        { role: 'assistant', content: text, toolCalls: [] },
        {
          role: 'user',
          content: `That reply could not be used: ${problem}. Reply again with only the JSON object.`,
        }
      );
    }
    return { labels: null, reason: `model reply unusable (${problem})` };
  }
}
