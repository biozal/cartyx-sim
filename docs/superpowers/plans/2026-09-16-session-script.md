# Session Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run sim -- script --campaign <id> --session <n>` turns a session's `events.jsonl` into `script.json` (speaker-attributed, TTS-ready lines plus silent cues) and `script.md` (a book-style read), without ever inventing text.

**Architecture:** A new pure package `packages/script` (no Node APIs, typechecked like `core`) holds the schema, text passes (a character `Mask` over each source text), quote attribution (a `Labeler` interface plus a `ModelLabeler` that returns labels only), the build, invariant checks, and the markdown renderer. `apps/cli` adds the `script` command: file I/O, the session lock, `speakers.json`, a file-backed label cache, and a model client for the `script` seat (defaulting to `checker`).

**Tech Stack:** TypeScript (Node ≥ 22), zod 4, vitest, commander, npm workspaces. Model calls go through `@cartyx-sim/models` (`OpenAICompatibleModelClient`).

**Spec:** `docs/superpowers/specs/2026-09-16-session-script-design.md`

## Global Constraints

- The event log is never modified. Post-processing only drops spans, splits text into lines, attributes speakers, and applies the normalizations in `normalize.ts`; a voiced line's `text` must equal `finishLine(<concatenated source slices>)`.
- The model returns labels only, never text.
- `packages/script` uses no Node APIs (`node:*`, `Buffer`, `process`); it is typechecked with `lib: ["ES2023", "DOM"]`, `types: []`.
- Config and data files are JSON, never YAML.
- Every commit passes `npm run typecheck`, `npm test`, and `npm run format:check` (Prettier: single quotes, semicolons, width 100, `trailingComma: "es5"`). Run `npx prettier --write <files>` before committing.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```
- Do not push or merge.
- Match the surrounding code: doc comments on exported functions, `ownEntry` for config-supplied keys, `ScriptError` for user-facing errors.

## Deviations from the spec (apply in Task 2's spec edit)

The plan refines several spec details; Task 2 updates the spec so it stays accurate:

1. **§4.1 rule 3 → "Double quote marks are removed from PC and NPC speech, action text, and narration."** Quote marks carry no sound, and keeping only some of them needed fragile rules.
2. **§4.1 rule 4 → a general line ending:** after whitespace is collapsed, a line ending in `,` `;` or `:` ends in `.` instead, and a line with no ending punctuation gets a `.`. This covers the "comma before a closing quote" case and bullet items, and it keeps the invariant a single function (`finishLine`).
3. **Headings and bullet items are their own narration lines** (§5.2 step 4), so bullet periods stay reproducible.
4. **`flags.dmWrotePc`** (camelCase, like the other JSON fields) instead of `dm_wrote_pc`.
5. **Rules fallback:** a quote of fewer than 3 words is labeled `none`; others go to the single NPC introduced since the last scene change, else to `npc-unnamed`.
6. **Notes can carry `dropped` spans** for an event that produced no line.
7. **`session_paused` is DM-only in real logs**, so pauses are detected regardless of visibility.

## File map

| File                                                            | Responsibility                                                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/json-reply.ts` (new)                         | `findJsonReply`: bounded search for the first JSON object in a model reply (moved out of `pc-control.ts`)                           |
| `packages/core/src/pc-control.ts` (modify)                      | `parseCheckerReply` uses `findJsonReply`                                                                                            |
| `packages/script/package.json`, `tsconfig.json` (new)           | workspace package, Node-free typecheck                                                                                              |
| `packages/script/src/schema.ts`                                 | zod schemas: `ScriptFile`, `ScriptLine`, `Speaker`, `SpeakerOverrides`; `ScriptError`                                               |
| `packages/script/src/normalize.ts`                              | `Mask`, `finishLine`, `removeEmphasis`, `removeMarkdown`, `removeQuotes`, `pairQuotes`, `sourceLines`, `hasWords`, `BULLET`         |
| `packages/script/src/speech.ts`                                 | `splitSpeech`, `cleanAction`                                                                                                        |
| `packages/script/src/narration.ts`                              | `segmentNarration`, `narrationPieces`                                                                                               |
| `packages/script/src/attribution.ts`                            | `Labeler`, `LabelRequest`, `SpanLabel`, prompt, `parseLabelReply`, `checkLabels`, `fallbackLabels`, `ModelLabeler`, `labelCacheKey` |
| `packages/script/src/speakers.ts`                               | `SpeakerTable`, `applySpeakerOverrides`                                                                                             |
| `packages/script/src/build.ts`                                  | `buildScript`                                                                                                                       |
| `packages/script/src/invariants.ts`                             | `invariantViolations`                                                                                                               |
| `packages/script/src/markdown.ts`                               | `renderScriptMarkdown`                                                                                                              |
| `packages/script/src/index.ts`                                  | re-exports                                                                                                                          |
| `packages/script/test/*.test.ts`, `test/helpers.ts`             | tests; `helpers.ts` builds event logs with core's `TurnRecorder`                                                                    |
| `apps/cli/src/campaign.ts` (modify)                             | optional `seats.script`; `Campaign.scriptSeat`                                                                                      |
| `apps/cli/src/label-cache.ts` (new)                             | `FileLabelCache`                                                                                                                    |
| `apps/cli/src/script.ts` (new)                                  | `makeScript`, `formatScriptSummary`, `loadSpeakerOverrides`                                                                         |
| `apps/cli/src/main.ts` (modify)                                 | `script` command                                                                                                                    |
| `docs/running-a-session.md`, `docs/status.md`, roadmap (modify) | docs                                                                                                                                |

---

### Task 1: Move reply JSON extraction into `core/json-reply.ts`

`ModelLabeler` (Task 5) must read JSON from a thinking model's reply exactly as the checker does. Extract the bounded search so both use it.

**Files:**

- Create: `packages/core/src/json-reply.ts`
- Modify: `packages/core/src/pc-control.ts` (the constants `THINK_BLOCK`, `MAX_PARSE_ATTEMPTS`, `MAX_PARSE_CHARS`, `WHITESPACE`, the helpers `skipWhitespace`, `canOpenJsonObject`, `readCandidate`, and `parseCheckerReply`, around lines 46–130)
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/json-reply.test.ts`

**Interfaces:**

- Produces: `findJsonReply<T>(text: string, read: (value: unknown) => T | null): T | null`, exported from `@cartyx-sim/core`.

- [ ] **Step 1: Write the failing test**

````ts
// packages/core/test/json-reply.test.ts
import { describe, expect, it } from 'vitest';
import { findJsonReply } from '../src/json-reply';

const readLabels = (value: unknown): string[] | null =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { labels?: unknown }).labels)
    ? (value as { labels: string[] }).labels
    : null;

describe('findJsonReply', () => {
  it('reads an object wrapped in prose and a code fence', () => {
    const reply = 'Sure.\n```json\n{"labels": ["a", "b"]}\n```\nDone.';
    expect(findJsonReply(reply, readLabels)).toEqual(['a', 'b']);
  });

  it('ignores closed think blocks, even with braces inside', () => {
    const reply = '<think>maybe {"labels": ["wrong"]}</think>{"labels": ["right"]}';
    expect(findJsonReply(reply, readLabels)).toEqual(['right']);
  });

  it('skips objects the reader rejects and returns the first accepted one', () => {
    const reply = '{"other": 1} then {"labels": ["x"]}';
    expect(findJsonReply(reply, readLabels)).toEqual(['x']);
  });

  it('returns null when nothing is accepted', () => {
    expect(findJsonReply('no json here', readLabels)).toBeNull();
    expect(findJsonReply('{"other": 1}', readLabels)).toBeNull();
  });

  it('gives up quickly on a degenerate brace-heavy reply', () => {
    const reply = '{"'.repeat(5000) + '}'.repeat(5000);
    const started = Date.now();
    expect(findJsonReply(reply, readLabels)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/json-reply.test.ts`
Expected: FAIL, `Cannot find module '../src/json-reply'` (or similar).

- [ ] **Step 3: Create `json-reply.ts`**

Move the constants and helpers verbatim from `pc-control.ts` (keep their comments), and generalize the search:

```ts
// packages/core/src/json-reply.ts

/** Closed thinking blocks some models leak into their reply; they may hold braces of their own. */
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;

// A brace-heavy reply can offer thousands of "{"..."}" candidates; each JSON.parse attempt is
// cheap on its own, but trying every one is not (a probe of two nested 10,000-character brace
// runs took ~2s with no cap). The search gives up once it has made this many parse attempts, so a
// degenerate reply is read as unreadable quickly instead of exhaustively.
const MAX_PARSE_ATTEMPTS = 2000;

// Caps the total characters handed to JSON.parse across all attempts, since each attempt alone can
// be as long as the whole reply.
const MAX_PARSE_CHARS = 20_000_000;

const WHITESPACE = /\s/;

/** The index of the first non-whitespace character in `text` at or after `from`. */
function skipWhitespace(text: string, from: number): number {
  let at = from;
  while (at < text.length && WHITESPACE.test(text[at]!)) at++;
  return at;
}

/**
 * Whether a "{" at `start` in `reply` could possibly open valid JSON: skipping whitespace, the
 * next character is a `"` (an object with a key) or a `}` (an object that closes at once). This
 * depends only on `start`, never on which "}" would end the candidate, so it is decided once per
 * start and a start that fails it is skipped entirely — no `}` end is ever tried against it.
 */
function canOpenJsonObject(reply: string, start: number): boolean {
  const char = reply[skipWhitespace(reply, start + 1)];
  return char === '"' || char === '}';
}

/**
 * The first JSON object in a model reply that `read` accepts (returns non-null for), or null.
 * Closed `<think>` blocks are ignored first. Then each "{" is tried, in order, against each later
 * "}" from last to first, so code fences, surrounding text, stray braces, and a second object are
 * all fine, and the first (leftmost, then widest) candidate that parses and is accepted wins. A
 * start that could not possibly open JSON is skipped, and at most `MAX_PARSE_ATTEMPTS` candidates,
 * totaling at most `MAX_PARSE_CHARS` characters, are ever parsed, so a degenerate brace-heavy
 * reply returns null quickly instead of trying every pair.
 */
export function findJsonReply<T>(text: string, read: (value: unknown) => T | null): T | null {
  const reply = text.replace(THINK_BLOCK, '');
  const closeBraces: number[] = [];
  for (let end = reply.indexOf('}'); end !== -1; end = reply.indexOf('}', end + 1)) {
    closeBraces.push(end);
  }
  let attempts = 0;
  let charsParsed = 0;
  for (let start = reply.indexOf('{'); start !== -1; start = reply.indexOf('{', start + 1)) {
    if (!canOpenJsonObject(reply, start)) continue;
    for (let i = closeBraces.length - 1; i >= 0; i--) {
      const end = closeBraces[i]!;
      if (end <= start) break; // closeBraces is ascending, so nothing before this is > start either
      if (attempts >= MAX_PARSE_ATTEMPTS) return null;
      const length = end + 1 - start;
      if (charsParsed + length > MAX_PARSE_CHARS) return null;
      attempts++;
      charsParsed += length;
      let value: unknown;
      try {
        value = JSON.parse(reply.slice(start, end + 1));
      } catch {
        continue;
      }
      const found = read(value);
      if (found !== null) return found;
    }
  }
  return null;
}
```

- [ ] **Step 4: Make `pc-control.ts` use it**

In `packages/core/src/pc-control.ts`, delete `THINK_BLOCK`, `MAX_PARSE_ATTEMPTS`, `MAX_PARSE_CHARS`, `WHITESPACE` (only if nothing else in the file uses it — check with `grep -n WHITESPACE packages/core/src/pc-control.ts`), `skipWhitespace`, `canOpenJsonObject`, and `readCandidate`, and replace `parseCheckerReply` with:

```ts
import { findJsonReply } from './json-reply';

/**
 * The checker's findings, or null when its reply holds no readable `{ "violations": [...] }`
 * object. See `findJsonReply` for how the object is found.
 */
export function parseCheckerReply(text: string): PcControlFinding[] | null {
  return findJsonReply(text, (value) => {
    const parsed = CheckerReply.safeParse(value);
    return parsed.success ? parsed.data.violations : null;
  });
}
```

Add `export * from './json-reply';` to `packages/core/src/index.ts` (alphabetical, after `./hand-off-prose`).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/core`
Expected: PASS, including every existing `pc-control.test.ts` case.

- [ ] **Step 6: Check and commit**

```bash
npx prettier --write packages/core/src/json-reply.ts packages/core/src/pc-control.ts packages/core/src/index.ts packages/core/test/json-reply.test.ts
npm run typecheck && npm test && npm run format:check
git add packages/core
git commit -m "refactor(core): move reply JSON extraction into json-reply for reuse

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Scaffold `packages/script` with its schema and text normalization

**Files:**

- Create: `packages/script/package.json`, `packages/script/tsconfig.json`, `packages/script/src/index.ts`, `packages/script/src/schema.ts`, `packages/script/src/normalize.ts`
- Modify: root `package.json` (`typecheck` script), `package-lock.json` (via `npm install`)
- Modify: `docs/superpowers/specs/2026-09-16-session-script-design.md` (the deviations listed at the top of this plan)
- Test: `packages/script/test/normalize.test.ts`, `packages/script/test/schema.test.ts`

**Interfaces:**

- Produces (`schema.ts`): `SCRIPT_SCHEMA_VERSION`, `ScriptError`, zod schemas and types `Speaker`, `TextSource`, `DroppedSpan`, `DropReason`, `VoicedLine`, `RollLine`, `SceneLine`, `CombatLine`, `StateLine`, `PauseLine`, `ScriptLine`, `LineKind`, `Note`, `ScriptFile`, `SpeakerOverrides`; `DistributiveOmit<T, K>`; `LineDraft = DistributiveOmit<ScriptLine, 'id'>`.
- Produces (`normalize.ts`): `Range`, `Mask` (`raw`, `remove(start, end)`, `isRemoved(i)`, `kept(start, end): Range[]`, `keptText(start, end)`), `sliceText(raw, ranges)`, `finishLine(text)`, `hasWords(mask, ranges)`, `sourceLines(raw)`, `BULLET`, `removeEmphasis(mask)`, `removeQuotes(mask, start?, end?)`, `removeMarkdown(mask): Set<number>`, `QuoteSpan`, `pairQuotes(mask, start, end)`, `isQuoteMark(char)`.

- [ ] **Step 1: Create the package**

```json
// packages/script/package.json
{
  "name": "@cartyx-sim/script",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@cartyx-sim/core": "*",
    "@cartyx-sim/rules": "*",
    "zod": "^4.6.4"
  }
}
```

```json
// packages/script/tsconfig.json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM"],
    "types": []
  },
  "include": ["src"]
}
```

In the root `package.json`, append `&& tsc -p packages/script/tsconfig.json` to the `typecheck` script. Then run `npm install` so the workspace is linked and `package-lock.json` gains the new package.

- [ ] **Step 2: Write `schema.ts`**

```ts
// packages/script/src/schema.ts
import { Emotion } from '@cartyx-sim/core';
import { z } from 'zod';

/** Bumped whenever `script.json` changes incompatibly. */
export const SCRIPT_SCHEMA_VERSION = 1;

/** A problem the user can fix (a bad `speakers.json`, a log that cannot be scripted). */
export class ScriptError extends Error {
  override name = 'ScriptError';
}

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const Speaker = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['dm', 'pc', 'npc']),
  /** An NPC the DM voiced without an `npc_introduced` event. */
  unlisted: z.boolean().optional(),
  /** The seq of the event where an unlisted NPC first speaks. */
  firstSeq: z.number().int().min(0).optional(),
});
export type Speaker = z.infer<typeof Speaker>;

/** Character offsets `[start, end)` into an event's text (`text`, or `intent` for actions). */
export const TextSource = z.object({
  seq: z.number().int().min(0),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});
export type TextSource = z.infer<typeof TextSource>;

export const DropReason = z.enum(['stage_direction', 'hand_off', 'dm_prefix']);
export type DropReason = z.infer<typeof DropReason>;

export const DroppedSpan = TextSource.extend({ reason: DropReason, text: z.string() });
export type DroppedSpan = z.infer<typeof DroppedSpan>;

const EventSource = z.object({ seq: z.number().int().min(0) });
const LineId = z.string().regex(/^L\d{4,}$/);

export const VoicedLine = z.object({
  id: LineId,
  kind: z.enum(['narration', 'dialogue', 'action']),
  speaker: z.string().min(1),
  text: z.string().min(1),
  emotion: Emotion,
  sources: z.array(TextSource).min(1),
  dropped: z.array(DroppedSpan).optional(),
  /** The id of the line this interjection talks over. */
  overlaps: LineId.optional(),
  /** Set when the DM wrote this player character's words; the line stays in the DM's voice. */
  flags: z.object({ dmWrotePc: z.string().min(1) }).optional(),
});
export type VoicedLine = z.infer<typeof VoicedLine>;

export const RollLine = z.object({
  id: LineId,
  kind: z.literal('roll'),
  sources: z.array(EventSource).length(1),
  roll: z.object({
    actor: z.string(),
    actorName: z.string(),
    kind: z.enum(['check', 'save', 'attack', 'damage', 'healing', 'initiative']),
    label: z.string(),
    total: z.number().int(),
    target: z.number().int().optional(),
    outcome: z.enum(['success', 'failure', 'hit', 'miss', 'critical']).optional(),
    mode: z.enum(['normal', 'advantage', 'disadvantage']).optional(),
    subject: z.string().optional(),
    subjectName: z.string().optional(),
  }),
});
export type RollLine = z.infer<typeof RollLine>;

export const SceneLine = z.object({
  id: LineId,
  kind: z.literal('scene'),
  sources: z.array(EventSource).length(1),
  scene: z.object({
    location: z.string(),
    artPrompt: z.string(),
    loreEntityId: z.string().optional(),
  }),
});
export type SceneLine = z.infer<typeof SceneLine>;

export const CombatLine = z.object({
  id: LineId,
  kind: z.literal('combat'),
  sources: z.array(EventSource).length(1),
  combat: z.discriminatedUnion('phase', [
    z.object({
      phase: z.literal('start'),
      order: z.array(z.object({ combatantId: z.string(), name: z.string(), total: z.number() })),
    }),
    z.object({
      phase: z.literal('turn'),
      round: z.number().int(),
      combatantId: z.string(),
      name: z.string(),
    }),
    z.object({ phase: z.literal('end') }),
  ]),
});
export type CombatLine = z.infer<typeof CombatLine>;

export const StateLine = z.object({
  id: LineId,
  kind: z.literal('state'),
  sources: z.array(EventSource).length(1),
  state: z.object({
    entity: z.string(),
    name: z.string(),
    field: z.enum(['hp', 'conditions', 'dead']),
    before: z.unknown(),
    after: z.unknown(),
    /** True for anyone but a player character: the book hides their HP numbers. */
    hidden: z.boolean(),
  }),
});
export type StateLine = z.infer<typeof StateLine>;

export const PauseLine = z.object({
  id: LineId,
  kind: z.literal('pause'),
  sources: z.array(EventSource).length(1),
  pause: z.object({ reason: z.string() }),
});
export type PauseLine = z.infer<typeof PauseLine>;

export const ScriptLine = z.union([
  VoicedLine,
  RollLine,
  SceneLine,
  CombatLine,
  StateLine,
  PauseLine,
]);
export type ScriptLine = z.infer<typeof ScriptLine>;
export type LineKind = ScriptLine['kind'];
export type LineDraft = DistributiveOmit<ScriptLine, 'id'>;

export const VOICED_KINDS: readonly LineKind[] = ['narration', 'dialogue', 'action'];

export function isVoiced(line: ScriptLine): line is VoicedLine {
  return VOICED_KINDS.includes(line.kind);
}

export const Note = z.object({
  seq: z.number().int().min(0),
  text: z.string().min(1),
  /** Spans dropped from an event that produced no line to attach them to. */
  dropped: z.array(DroppedSpan).optional(),
});
export type Note = z.infer<typeof Note>;

export const ScriptFile = z.object({
  scriptSchemaVersion: z.literal(SCRIPT_SCHEMA_VERSION),
  campaign: z.string().min(1),
  session: z.number().int().min(1),
  eventsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  speakers: z.array(Speaker),
  lines: z.array(ScriptLine),
  notes: z.array(Note),
});
export type ScriptFile = z.infer<typeof ScriptFile>;

/** `speakers.json`: per speaker id, an optional merge target and an optional display name. */
export const SpeakerOverrides = z.record(
  z.string().min(1),
  z.object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() }).strict()
);
export type SpeakerOverrides = z.infer<typeof SpeakerOverrides>;
```

- [ ] **Step 3: Write the normalization tests**

```ts
// packages/script/test/normalize.test.ts
import { describe, expect, it } from 'vitest';
import {
  finishLine,
  hasWords,
  Mask,
  pairQuotes,
  removeEmphasis,
  removeMarkdown,
  removeQuotes,
  sliceText,
  sourceLines,
} from '../src/normalize';

describe('Mask', () => {
  it('reports kept runs and text with source offsets', () => {
    const mask = new Mask('ab**cd**ef');
    mask.remove(2, 4);
    mask.remove(6, 8);
    expect(mask.kept(0, 10)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
      { start: 8, end: 10 },
    ]);
    expect(mask.keptText(0, 10)).toBe('abcdef');
    expect(sliceText(mask.raw, mask.kept(0, 10))).toBe('abcdef');
    expect(mask.isRemoved(2)).toBe(true);
    expect(mask.isRemoved(4)).toBe(false);
  });

  it('clamps removals to the text', () => {
    const mask = new Mask('abc');
    mask.remove(-5, 1);
    mask.remove(2, 99);
    expect(mask.keptText(0, 3)).toBe('b');
  });
});

describe('finishLine', () => {
  it('collapses whitespace and trims', () => {
    expect(finishLine('  Stay\n  close.  ')).toBe('Stay close.');
  });

  it('ends a line that ends in a comma, semicolon, or colon with a period', () => {
    expect(finishLine('You... opened... the door,')).toBe('You... opened... the door.');
    expect(finishLine('She whispers:')).toBe('She whispers.');
  });

  it('adds a period when there is no ending punctuation', () => {
    expect(finishLine('Iron door')).toBe('Iron door.');
  });

  it('keeps existing endings, including dashes, ellipses, and closing brackets', () => {
    for (const text of ['Run!', 'Why?', 'Wait...', 'I think—', 'Wait…', "the 'owners'", '(soft)']) {
      expect(finishLine(text)).toBe(text);
    }
  });

  it('returns empty for text with no letters or digits', () => {
    expect(finishLine(' , ... ')).toBe('');
  });
});

describe('removeEmphasis', () => {
  it('removes asterisks and word-edge underscores but not inner underscores', () => {
    const mask = new Mask('**Bold** and *soft* and _lean_ snake_case');
    removeEmphasis(mask);
    expect(mask.keptText(0, mask.raw.length)).toBe('Bold and soft and lean snake_case');
  });
});

describe('removeQuotes', () => {
  it('removes straight and curly double quotes but keeps apostrophes and single quotes', () => {
    const mask = new Mask("\"Kira's\" “take” on 'owners'");
    removeQuotes(mask);
    expect(mask.keptText(0, mask.raw.length)).toBe("Kira's take on 'owners'");
  });
});

describe('removeMarkdown', () => {
  it('removes heading, bullet, and rule markers and reports standalone lines', () => {
    const raw = '## The Hall\nIntro line.\n- first item\n2. second item\n---\n**Hand** it over.';
    const mask = new Mask(raw);
    const standalone = removeMarkdown(mask);
    const lines = sourceLines(raw);
    expect([...standalone].sort((a, b) => a - b)).toEqual([
      lines[0]!.start,
      lines[2]!.start,
      lines[3]!.start,
    ]);
    expect(mask.keptText(0, raw.length)).toBe(
      'The Hall\nIntro line.\nfirst item\nsecond item\n\nHand it over.'
    );
  });
});

describe('sourceLines', () => {
  it('returns each line without its newline', () => {
    expect(sourceLines('a\nbc\n')).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 4 },
      { start: 5, end: 5 },
    ]);
  });
});

describe('pairQuotes', () => {
  it('pairs quote marks in order and leaves an odd one open to the end', () => {
    const raw = '"A" said "B" and "C';
    const spans = pairQuotes(new Mask(raw), 0, raw.length);
    expect(spans).toEqual([
      { open: 0, close: 2 },
      { open: 9, close: 11 },
      { open: 17, close: null },
    ]);
  });

  it('ignores marks already removed and marks outside the range', () => {
    const raw = '"A" "B"';
    const mask = new Mask(raw);
    mask.remove(0, 1);
    expect(pairQuotes(mask, 0, 3)).toEqual([{ open: 2, close: null }]);
  });
});

describe('hasWords', () => {
  it('is true only when kept text in the ranges has a letter or digit', () => {
    const mask = new Mask('**, ab');
    removeEmphasis(mask);
    expect(hasWords(mask, [{ start: 0, end: 4 }])).toBe(false);
    expect(hasWords(mask, [{ start: 0, end: 6 }])).toBe(true);
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run packages/script`
Expected: FAIL, module `../src/normalize` not found.

- [ ] **Step 5: Write `normalize.ts`**

```ts
// packages/script/src/normalize.ts

/** A half-open range `[start, end)` of character offsets into a source text. */
export interface Range {
  start: number;
  end: number;
}

/**
 * A source text with some characters marked removed. Every offset refers to the source text, so
 * the kept runs are exactly the `sources` a script line records.
 */
export class Mask {
  private readonly removed: Uint8Array;

  constructor(readonly raw: string) {
    this.removed = new Uint8Array(raw.length);
  }

  remove(start: number, end: number): void {
    const from = Math.max(0, start);
    const to = Math.min(end, this.raw.length);
    if (to > from) this.removed.fill(1, from, to);
  }

  isRemoved(index: number): boolean {
    return this.removed[index] === 1;
  }

  /** The maximal runs of kept characters in `[start, end)`. */
  kept(start: number, end: number): Range[] {
    const ranges: Range[] = [];
    let open = -1;
    for (let i = start; i < end; i++) {
      if (this.removed[i] === 1) {
        if (open !== -1) ranges.push({ start: open, end: i });
        open = -1;
      } else if (open === -1) {
        open = i;
      }
    }
    if (open !== -1) ranges.push({ start: open, end });
    return ranges;
  }

  keptText(start: number, end: number): string {
    return sliceText(this.raw, this.kept(start, end));
  }
}

/** The source text of each range, concatenated with nothing between them. */
export function sliceText(raw: string, ranges: readonly Range[]): string {
  return ranges.map((range) => raw.slice(range.start, range.end)).join('');
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const ENDING = /[.!?…—–\-'’)\]]$/;

/**
 * The spoken form of a line's kept text: whitespace collapsed and trimmed, a trailing `,` `;` or
 * `:` turned into a period, and a period added when the line has no ending punctuation. Text with
 * no letters or digits becomes empty (no line). This is the only transformation between a line's
 * source slices and its `text`.
 */
export function finishLine(text: string): string {
  let line = text.replace(/\s+/g, ' ').trim();
  if (!LETTER_OR_DIGIT.test(line)) return '';
  line = line.replace(/[,;:]+$/, '.');
  if (!ENDING.test(line)) line += '.';
  return line;
}

/** Whether the kept text in `ranges` has at least one letter or digit. */
export function hasWords(mask: Mask, ranges: readonly Range[]): boolean {
  return ranges.some((range) => LETTER_OR_DIGIT.test(mask.keptText(range.start, range.end)));
}

/** Each line of `raw` as `[start, end)`, without its newline. */
export function sourceLines(raw: string): Range[] {
  const lines: Range[] = [];
  let start = 0;
  for (;;) {
    const newline = raw.indexOf('\n', start);
    const end = newline === -1 ? raw.length : newline;
    lines.push({ start, end });
    if (newline === -1) return lines;
    start = newline + 1;
  }
}

const EMPHASIS = /\*+|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu;
const QUOTE_MARK = /["“”]/;
const HEADING = /^[ \t]*#{1,6}[ \t]+/;
/** A bullet or numbered-list marker at the start of a line. */
export const BULLET = /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+/;
const RULE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;

export function isQuoteMark(char: string | undefined): boolean {
  return char !== undefined && QUOTE_MARK.test(char);
}

/** Removes markdown emphasis: every `*`, and `_` runs at the edge of a word. */
export function removeEmphasis(mask: Mask): void {
  for (const match of mask.raw.matchAll(EMPHASIS)) {
    mask.remove(match.index, match.index + match[0].length);
  }
}

/** Removes every straight or curly double quote mark in `[start, end)`. */
export function removeQuotes(mask: Mask, start = 0, end = mask.raw.length): void {
  for (let i = start; i < end; i++) {
    if (isQuoteMark(mask.raw[i])) mask.remove(i, i + 1);
  }
}

/**
 * Removes markdown from narration: horizontal rules, heading and list markers, and emphasis.
 * Returns the start offsets of heading and list-item lines, which become lines of their own.
 */
export function removeMarkdown(mask: Mask): Set<number> {
  const standalone = new Set<number>();
  for (const line of sourceLines(mask.raw)) {
    const text = mask.raw.slice(line.start, line.end);
    if (RULE.test(text)) {
      mask.remove(line.start, line.end);
      continue;
    }
    const marker = HEADING.exec(text) ?? BULLET.exec(text);
    if (marker) {
      mask.remove(line.start, line.start + marker[0].length);
      standalone.add(line.start);
    }
  }
  removeEmphasis(mask);
  return standalone;
}

/** A pair of double quote marks; `close` is null for an odd one out, open to the range end. */
export interface QuoteSpan {
  open: number;
  close: number | null;
}

/** The kept double quote marks in `[start, end)`, paired in order: first with second, and so on. */
export function pairQuotes(mask: Mask, start: number, end: number): QuoteSpan[] {
  const marks: number[] = [];
  for (let i = start; i < end; i++) {
    if (!mask.isRemoved(i) && isQuoteMark(mask.raw[i])) marks.push(i);
  }
  const spans: QuoteSpan[] = [];
  for (let i = 0; i < marks.length; i += 2) {
    spans.push({ open: marks[i]!, close: marks[i + 1] ?? null });
  }
  return spans;
}
```

- [ ] **Step 6: Write the schema test**

```ts
// packages/script/test/schema.test.ts
import { describe, expect, it } from 'vitest';
import { ScriptFile, SpeakerOverrides } from '../src/schema';

describe('ScriptFile', () => {
  it('accepts a minimal script with a voiced line and a cue', () => {
    const parsed = ScriptFile.safeParse({
      scriptSchemaVersion: 1,
      campaign: 'avalon',
      session: 3,
      eventsSha256: 'a'.repeat(64),
      speakers: [{ id: 'dm', name: 'Dungeon Master', kind: 'dm' }],
      lines: [
        {
          id: 'L0001',
          kind: 'narration',
          speaker: 'dm',
          text: 'Mist.',
          emotion: 'neutral',
          sources: [{ seq: 2, start: 0, end: 5 }],
        },
        {
          id: 'L0002',
          kind: 'scene',
          sources: [{ seq: 1 }],
          scene: { location: 'Road', artPrompt: 'A road' },
        },
      ],
      notes: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown schema version', () => {
    expect(
      ScriptFile.safeParse({
        scriptSchemaVersion: 2,
        campaign: 'a',
        session: 1,
        eventsSha256: 'a'.repeat(64),
        speakers: [],
        lines: [],
        notes: [],
      }).success
    ).toBe(false);
  });
});

describe('SpeakerOverrides', () => {
  it('accepts ids and names and rejects unknown fields', () => {
    expect(SpeakerOverrides.safeParse({ 'npc-a': { id: 'npc-b', name: 'B' } }).success).toBe(true);
    expect(SpeakerOverrides.safeParse({ 'npc-a': { voice: 'x' } }).success).toBe(false);
  });
});
```

- [ ] **Step 7: Write `index.ts`**

```ts
// packages/script/src/index.ts
export * from './normalize';
export * from './schema';
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run packages/script`
Expected: PASS.

- [ ] **Step 9: Update the spec with the plan's deviations**

In `docs/superpowers/specs/2026-09-16-session-script-design.md`:

- Replace §4.1 rules 3 and 4 with: "3. Remove every double quote mark (straight or curly) from PC and NPC speech, action text, and narration. 4. After whitespace is collapsed, a line ending in `,` `;` or `:` ends in `.` instead, and a line with no ending punctuation (`. ! ? … — – - ' ’ ) ]`) gets a `.`; text with no letters or digits produces no line." Drop "A bullet item's text becomes its own sentence: a terminal period is added when it has no terminal punctuation." from rule 1 and add to §5.2 step 4: "Heading and list-item lines are paragraphs of their own."
- Replace `dm_wrote_pc` with `dmWrotePc` in §4.2, §5.3, and §6, and write the flag as `flags: { dmWrotePc: <id> }`.
- In §5.3's fallback sentence, write: "the **rules fallback** labels a quote of fewer than 3 words `none`, and every other quote as the single NPC introduced since the last `scene_change` if there is exactly one, else `npc-unnamed`."
- In §4.2 after `notes` mention: "A note may carry `dropped` spans for an event that produced no line."
- In §5.5's `session_paused` row, add: "(detected regardless of visibility; the engine logs pauses as DM-only)".

- [ ] **Step 10: Check and commit**

```bash
npx prettier --write packages/script package.json docs/superpowers/specs/2026-09-16-session-script-design.md
npm run typecheck && npm test && npm run format:check
git add packages/script package.json package-lock.json docs/superpowers/specs/2026-09-16-session-script-design.md
git commit -m "feat(script): add the script package with its schema and text normalization

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Split PC and NPC speech; clean action text

Real input (Kira in avalon 003 #7): `"Holding its breath, you say. Or holding us for it." I keep my voice low, eyes drifting along the tree line before settling on the archway. "Whatever made this place empty, it's not in a hurry. So neither should we be."` The quoted parts are spoken; the text between them is a stage direction.

**Files:**

- Create: `packages/script/src/speech.ts`
- Modify: `packages/script/src/index.ts` (add `export * from './speech';`)
- Test: `packages/script/test/speech.test.ts`

**Interfaces:**

- Consumes: `Mask`, `Range`, `removeEmphasis`, `removeQuotes`, `pairQuotes`, `hasWords`, `QuoteSpan` from `normalize.ts`.
- Produces: `SpeechSplit { mask: Mask; lines: Range[][]; directions: Range[] }`, `splitSpeech(raw: string): SpeechSplit`, `cleanAction(raw: string): { mask: Mask; ranges: Range[] }`.

**Rule (split mode):** the text is split into quoted lines plus dropped stage directions only when all of these hold: it has at least one quote span, its first kept non-space character is a quote mark, the text outside quotes has words, and the quoted text is at least half of the non-space characters. Otherwise the whole text is one line. Every double quote mark is removed either way.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/script/test/speech.test.ts
import { describe, expect, it } from 'vitest';
import { finishLine, sliceText, type Range } from '../src/normalize';
import { cleanAction, splitSpeech } from '../src/speech';

function spoken(raw: string): { lines: string[]; directions: string[] } {
  const split = splitSpeech(raw);
  return {
    lines: split.lines.map((ranges) => finishLine(sliceText(raw, ranges))),
    directions: split.directions.map((range: Range) => raw.slice(range.start, range.end)),
  };
}

describe('splitSpeech', () => {
  it('splits quoted speech from a stage direction between quotes (Kira, avalon 003 #7)', () => {
    const raw =
      '"Holding its breath, you say. Or holding us for it." I keep my voice low, eyes drifting ' +
      'along the tree line before settling on the archway. "Whatever made this place empty, ' +
      'it\'s not in a hurry. So neither should we be."';
    expect(spoken(raw)).toEqual({
      lines: [
        'Holding its breath, you say. Or holding us for it.',
        "Whatever made this place empty, it's not in a hurry. So neither should we be.",
      ],
      directions: [
        'I keep my voice low, eyes drifting along the tree line before settling on the archway.',
      ],
    });
  });

  it('drops a trailing stage direction and ends a comma-final quote with a period', () => {
    expect(spoken('"No blood means they didn\'t feed here," I say quietly.')).toEqual({
      lines: ["No blood means they didn't feed here."],
      directions: ['I say quietly.'],
    });
  });

  it('keeps unquoted speech whole and removes a stray trailing quote (Kira, avalon 004 #7)', () => {
    const raw =
      "Heavy, maybe. But heavy things can be traps as easily as treasures. I'd rather know " +
      'what we\'re walking into before we walk in."';
    expect(spoken(raw)).toEqual({
      lines: [
        "Heavy, maybe. But heavy things can be traps as easily as treasures. I'd rather know " +
          "what we're walking into before we walk in.",
      ],
      directions: [],
    });
  });

  it('removes wrapping and doubled quotes', () => {
    expect(spoken('"Agreed, Bram. That light is pulsing."”').lines).toEqual([
      'Agreed, Bram. That light is pulsing.',
    ]);
  });

  it('keeps a self-correction slip as spoken, without emphasis marks', () => {
    expect(spoken("Kira's — I mean, *my* — take is this: we wait.").lines).toEqual([
      "Kira's — I mean, my — take is this: we wait.",
    ]);
  });

  it('keeps a line with a scare-quoted word whole', () => {
    expect(spoken('The "door" it\'s talking about is the seal.').lines).toEqual([
      "The door it's talking about is the seal.",
    ]);
  });

  it('keeps a line whole when a leading quote covers only a small part of it', () => {
    expect(spoken('"Door" is the wrong word for what this thing guards, friend.').lines).toEqual([
      'Door is the wrong word for what this thing guards, friend.',
    ]);
  });

  it('returns no lines for text with no words', () => {
    expect(spoken('"..."')).toEqual({ lines: [], directions: [] });
  });

  it('records source ranges that reproduce each line', () => {
    const raw = '"Stay close." I raise my lantern. "And quiet."';
    const split = splitSpeech(raw);
    expect(split.lines.map((ranges) => sliceText(raw, ranges))).toEqual([
      'Stay close.',
      'And quiet.',
    ]);
    for (const range of split.directions) {
      expect(split.mask.keptText(range.start, range.end)).toBe('');
    }
  });
});

describe('cleanAction', () => {
  it('removes emphasis and quote marks', () => {
    const raw = 'Edge toward the *crumbling* archway, "carefully"';
    const { ranges } = cleanAction(raw);
    expect(finishLine(sliceText(raw, ranges))).toBe(
      'Edge toward the crumbling archway, carefully.'
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/script/test/speech.test.ts`
Expected: FAIL, module `../src/speech` not found.

- [ ] **Step 3: Write `speech.ts`**

```ts
// packages/script/src/speech.ts
import {
  hasWords,
  Mask,
  pairQuotes,
  removeEmphasis,
  removeQuotes,
  type QuoteSpan,
  type Range,
} from './normalize';

export interface SpeechSplit {
  mask: Mask;
  /** The kept source ranges of each spoken line, in order. */
  lines: Range[][];
  /** Stage directions dropped from between the quotes, trimmed, in order. */
  directions: Range[];
}

const SPACE = /\s/;

/** The text outside the quote spans (quote marks excluded), as ranges. */
function gaps(length: number, spans: readonly QuoteSpan[]): Range[] {
  const result: Range[] = [];
  let cursor = 0;
  for (const span of spans) {
    result.push({ start: cursor, end: span.open });
    if (span.close === null) return result;
    cursor = span.close + 1;
  }
  result.push({ start: cursor, end: length });
  return result;
}

function trimRange(raw: string, range: Range): Range {
  let { start, end } = range;
  while (start < end && SPACE.test(raw[start]!)) start++;
  while (end > start && SPACE.test(raw[end - 1]!)) end--;
  return { start, end };
}

/** Kept, non-space characters in the ranges. */
function countKept(mask: Mask, ranges: readonly Range[]): number {
  let count = 0;
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i++) {
      if (!mask.isRemoved(i) && !SPACE.test(mask.raw[i]!)) count++;
    }
  }
  return count;
}

function firstKeptIndex(mask: Mask): number {
  for (let i = 0; i < mask.raw.length; i++) {
    if (!mask.isRemoved(i) && !SPACE.test(mask.raw[i]!)) return i;
  }
  return -1;
}

/**
 * Splits a PC's or NPC's spoken text into lines. When the text opens with a quote, has words
 * outside its quotes, and is mostly quoted (Kira's `"…" I keep my voice low… "…"`), each quoted
 * part is a line and the text between is a dropped stage direction. Otherwise the whole text is
 * one line. Emphasis and every double quote mark are removed either way.
 */
export function splitSpeech(raw: string): SpeechSplit {
  const mask = new Mask(raw);
  removeEmphasis(mask);
  const spans = pairQuotes(mask, 0, raw.length);
  const opensWithQuote = spans.length > 0 && firstKeptIndex(mask) === spans[0]!.open;
  removeQuotes(mask);

  const quoted = spans.map((span) => ({ start: span.open + 1, end: span.close ?? raw.length }));
  const outside = gaps(raw.length, spans);
  const whole = mask.kept(0, raw.length);
  const split =
    opensWithQuote &&
    hasWords(mask, outside) &&
    countKept(mask, quoted) * 2 >= countKept(mask, [{ start: 0, end: raw.length }]);
  if (!split) {
    return { mask, lines: hasWords(mask, whole) ? [whole] : [], directions: [] };
  }

  const lines = quoted
    .map((range) => mask.kept(range.start, range.end))
    .filter((ranges) => hasWords(mask, ranges));
  const directions = outside
    .map((range) => trimRange(raw, range))
    .filter((range) => range.end > range.start && hasWords(mask, [range]));
  for (const range of directions) mask.remove(range.start, range.end);
  return { mask, lines, directions };
}

/** A declared action's text with emphasis and double quote marks removed. */
export function cleanAction(raw: string): { mask: Mask; ranges: Range[] } {
  const mask = new Mask(raw);
  removeEmphasis(mask);
  removeQuotes(mask);
  return { mask, ranges: mask.kept(0, raw.length) };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/script`
Expected: PASS.

- [ ] **Step 5: Check and commit**

```bash
npx prettier --write packages/script
npm run typecheck && npm test && npm run format:check
git add packages/script
git commit -m "feat(script): split spoken lines from stage directions

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Segment DM narration and apply quote labels

Real input (avalon 003 #73, trimmed): paragraphs of prose, `*"You... opened... the door,"* it rasps, …`, and a trailing `**Hand off.**`.

**Files:**

- Create: `packages/script/src/narration.ts`
- Modify: `packages/script/src/index.ts` (add `export * from './narration';`)
- Test: `packages/script/test/narration.test.ts`

**Interfaces:**

- Consumes: `extractHandOffProse(text, party)` from `@cartyx-sim/core` (returns `{ text, lines: string[], target }`; `lines` are the removed lines, trimmed); `Mask`, `Range`, `finishLine`, `hasWords`, `isQuoteMark`, `pairQuotes`, `removeMarkdown`, `removeQuotes`, `sliceText`, `sourceLines` from `normalize.ts`.
- Produces:
  - `NarrationQuote { n: number; block: number; open: number; close: number | null; text: string }` (`n` counts from 1; `text` is the finished inner text)
  - `NarrationDrop = Range & { reason: 'hand_off' | 'dm_prefix' }`
  - `SegmentedNarration { mask: Mask; blocks: Range[]; quotes: NarrationQuote[]; dropped: NarrationDrop[]; promptText: string }`
  - `segmentNarration(raw: string, party: readonly { id: string; name: string }[]): SegmentedNarration`
  - `QuoteLabel = { kind: 'narration' } | { kind: 'speech'; speaker: string; dmWrotePc?: string }`
  - `NarrationPiece { kind: 'narration' | 'dialogue'; speaker: string; ranges: Range[]; dmWrotePc?: string }`
  - `narrationPieces(segmented: SegmentedNarration, labels: readonly QuoteLabel[]): NarrationPiece[]` (throws `Error` when `labels.length !== quotes.length`)

**Steps inside `segmentNarration`:** (1) remove whole hand-off lines found by `extractHandOffProse`, recorded as `hand_off`; (2) remove a `DM:` prefix at the start of any other line (`**DM:**`, `**DM**:` too), recorded as `dm_prefix`; (3) `removeMarkdown`; (4) group lines into blocks: a line with no words ends a block, and a heading or list line is a block of its own; (5) pair quotes within each block, numbering those whose inner text has words; (6) build `promptText`: each block's kept text with its quote marks kept and `[[n]]` before each numbered quote, spaces collapsed, blocks joined by a blank line; (7) remove every quote mark.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/script/test/narration.test.ts
import { describe, expect, it } from 'vitest';
import { finishLine, sliceText } from '../src/normalize';
import {
  narrationPieces,
  segmentNarration,
  type NarrationPiece,
  type QuoteLabel,
  type SegmentedNarration,
} from '../src/narration';

const PARTY = [
  { id: 'kira', name: 'Kira Vale' },
  { id: 'tomas', name: 'Tomas Reed' },
];

const CREATURE =
  'The slit opens.\n\n' +
  '*"You... opened... the door,"* it rasps, the voice sounding like grinding stones.\n\n' +
  'The creature takes a step forward.\n\n' +
  '**Hand off.**';

function texts(segmented: SegmentedNarration, pieces: NarrationPiece[]) {
  return pieces.map((piece) => ({
    kind: piece.kind,
    speaker: piece.speaker,
    text: finishLine(sliceText(segmented.mask.raw, piece.ranges)),
    ...(piece.dmWrotePc ? { dmWrotePc: piece.dmWrotePc } : {}),
  }));
}

describe('segmentNarration', () => {
  it('drops the hand-off line, finds the quote, and numbers it for the prompt', () => {
    const segmented = segmentNarration(CREATURE, PARTY);
    expect(segmented.blocks).toHaveLength(3);
    expect(segmented.dropped).toHaveLength(1);
    const drop = segmented.dropped[0]!;
    expect(drop.reason).toBe('hand_off');
    expect(CREATURE.slice(drop.start, drop.end)).toBe('**Hand off.**');
    expect(segmented.quotes.map((quote) => quote.text)).toEqual(['You... opened... the door.']);
    expect(segmented.promptText).toBe(
      'The slit opens.\n\n' +
        '[[1]]"You... opened... the door," it rasps, the voice sounding like grinding stones.\n\n' +
        'The creature takes a step forward.'
    );
  });

  it('drops DM prefixes and joins consecutive lines into one block', () => {
    const raw = 'DM: The mist clears.\n**DM:** Silence.';
    const segmented = segmentNarration(raw, PARTY);
    expect(segmented.dropped.map((drop) => [drop.reason, raw.slice(drop.start, drop.end)])).toEqual(
      [
        ['dm_prefix', 'DM:'],
        ['dm_prefix', '**DM:**'],
      ]
    );
    expect(texts(segmented, narrationPieces(segmented, []))).toEqual([
      { kind: 'narration', speaker: 'dm', text: 'The mist clears. Silence.' },
    ]);
  });

  it('makes each list item its own narration line', () => {
    const segmented = segmentNarration('You see:\n- a rusted gate\n- **two** statues', PARTY);
    expect(texts(segmented, narrationPieces(segmented, [])).map((piece) => piece.text)).toEqual([
      'You see.',
      'a rusted gate.',
      'two statues.',
    ]);
  });

  it('removes a hand-off line naming a party member but keeps one naming a stranger', () => {
    const segmented = segmentNarration('Dust falls.\nHand off to Kira Vale.', PARTY);
    expect(segmented.dropped.map((drop) => drop.reason)).toEqual(['hand_off']);
    const kept = segmentNarration('Dust falls.\nHand off to Zed.', PARTY);
    expect(kept.dropped).toEqual([]);
  });

  it('skips quotes with no words', () => {
    expect(segmentNarration('A sound: "..." then nothing.', PARTY).quotes).toEqual([]);
  });
});

describe('narrationPieces', () => {
  it('splits a quote labeled as speech into its own dialogue line', () => {
    const segmented = segmentNarration(CREATURE, PARTY);
    const labels: QuoteLabel[] = [{ kind: 'speech', speaker: 'npc-faceless-creature' }];
    expect(texts(segmented, narrationPieces(segmented, labels))).toEqual([
      { kind: 'narration', speaker: 'dm', text: 'The slit opens.' },
      { kind: 'dialogue', speaker: 'npc-faceless-creature', text: 'You... opened... the door.' },
      {
        kind: 'narration',
        speaker: 'dm',
        text: 'it rasps, the voice sounding like grinding stones.',
      },
      { kind: 'narration', speaker: 'dm', text: 'The creature takes a step forward.' },
    ]);
  });

  it('leaves a quote labeled as narration inside the narration, without quote marks', () => {
    const segmented = segmentNarration(CREATURE, PARTY);
    const pieces = texts(segmented, narrationPieces(segmented, [{ kind: 'narration' }]));
    expect(pieces.map((piece) => piece.text)).toEqual([
      'The slit opens.',
      'You... opened... the door, it rasps, the voice sounding like grinding stones.',
      'The creature takes a step forward.',
    ]);
  });

  it('keeps DM-written PC dialogue in the DM voice with a flag', () => {
    const segmented = segmentNarration('Kira nods. "We go now," she says.', PARTY);
    const pieces = narrationPieces(segmented, [
      { kind: 'speech', speaker: 'dm', dmWrotePc: 'kira' },
    ]);
    expect(texts(segmented, pieces)).toEqual([
      { kind: 'narration', speaker: 'dm', text: 'Kira nods.' },
      { kind: 'dialogue', speaker: 'dm', text: 'We go now.', dmWrotePc: 'kira' },
      { kind: 'narration', speaker: 'dm', text: 'she says.' },
    ]);
  });

  it('runs an unclosed quote to the end of its block', () => {
    const segmented = segmentNarration('She hisses "Leave now and never return.', PARTY);
    const pieces = narrationPieces(segmented, [{ kind: 'speech', speaker: 'npc-hag' }]);
    expect(texts(segmented, pieces).map((piece) => piece.text)).toEqual([
      'She hisses.',
      'Leave now and never return.',
    ]);
  });

  it('throws when the label count does not match the quotes', () => {
    const segmented = segmentNarration(CREATURE, PARTY);
    expect(() => narrationPieces(segmented, [])).toThrow(/1 quote/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/script/test/narration.test.ts`
Expected: FAIL, module `../src/narration` not found.

- [ ] **Step 3: Write `narration.ts`**

```ts
// packages/script/src/narration.ts
import { extractHandOffProse } from '@cartyx-sim/core';
import {
  finishLine,
  hasWords,
  isQuoteMark,
  Mask,
  pairQuotes,
  removeMarkdown,
  removeQuotes,
  sliceText,
  sourceLines,
  type Range,
} from './normalize';

export interface NarrationQuote {
  /** Numbered from 1 across the whole narration, as shown to the labeler. */
  n: number;
  block: number;
  open: number;
  /** Null for a quote left open, which runs to the end of its block. */
  close: number | null;
  /** The finished inner text. */
  text: string;
}

export type NarrationDrop = Range & { reason: 'hand_off' | 'dm_prefix' };

export interface SegmentedNarration {
  mask: Mask;
  /** Paragraphs, plus heading and list lines on their own, in order. */
  blocks: Range[];
  quotes: NarrationQuote[];
  dropped: NarrationDrop[];
  /** The cleaned narration with `[[n]]` before each numbered quote, for the labeling prompt. */
  promptText: string;
}

const DM_PREFIX = /^[ \t]*(?:\*\*|__)?DM(?:\*\*|__)?:(?:\*\*|__)?[ \t]*/;

function dropLinePrefixes(
  mask: Mask,
  party: readonly { id: string; name: string }[]
): NarrationDrop[] {
  const raw = mask.raw;
  const dropped: NarrationDrop[] = [];
  const pending = [...extractHandOffProse(raw, party).lines];
  for (const line of sourceLines(raw)) {
    const text = raw.slice(line.start, line.end);
    const trimmed = text.trim();
    const handOff = trimmed.length > 0 ? pending.indexOf(trimmed) : -1;
    if (handOff !== -1) {
      pending.splice(handOff, 1);
      const start = line.start + text.indexOf(trimmed);
      mask.remove(line.start, line.end);
      dropped.push({ start, end: start + trimmed.length, reason: 'hand_off' });
      continue;
    }
    const prefix = DM_PREFIX.exec(text);
    if (prefix) {
      const start = line.start + (prefix[0].length - prefix[0].trimStart().length);
      mask.remove(line.start, line.start + prefix[0].length);
      dropped.push({ start, end: line.start + prefix[0].trimEnd().length, reason: 'dm_prefix' });
    }
  }
  return dropped;
}

function toBlocks(mask: Mask, standalone: ReadonlySet<number>): Range[] {
  const blocks: Range[] = [];
  let current: Range | undefined;
  for (const line of sourceLines(mask.raw)) {
    if (!hasWords(mask, [line])) {
      if (current) blocks.push(current);
      current = undefined;
    } else if (standalone.has(line.start)) {
      if (current) blocks.push(current);
      current = undefined;
      blocks.push({ ...line });
    } else if (current) {
      current.end = line.end;
    } else {
      current = { ...line };
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function renderPrompt(mask: Mask, blocks: readonly Range[], quotes: readonly NarrationQuote[]) {
  const numbers = new Map(quotes.map((quote) => [quote.open, quote.n]));
  return blocks
    .map((block) => {
      let text = '';
      for (let i = block.start; i < block.end; i++) {
        const n = numbers.get(i);
        if (n !== undefined) text += `[[${n}]]`;
        if (!mask.isRemoved(i) || isQuoteMark(mask.raw[i])) text += mask.raw[i];
      }
      return text.replace(/\s+/g, ' ').trim();
    })
    .join('\n\n');
}

/**
 * Cleans a DM narration and finds the quotes that may be speech: hand-off lines and `DM:`
 * prefixes are dropped, markdown is removed, the text is grouped into blocks, and quotes with
 * words are numbered. Quote marks are removed from the mask last, after the prompt is built.
 */
export function segmentNarration(
  raw: string,
  party: readonly { id: string; name: string }[]
): SegmentedNarration {
  const mask = new Mask(raw);
  const dropped = dropLinePrefixes(mask, party);
  const standalone = removeMarkdown(mask);
  const blocks = toBlocks(mask, standalone);
  const quotes: NarrationQuote[] = [];
  blocks.forEach((block, index) => {
    for (const span of pairQuotes(mask, block.start, block.end)) {
      const inner = mask.kept(span.open + 1, span.close ?? block.end);
      if (!hasWords(mask, inner)) continue;
      quotes.push({
        n: quotes.length + 1,
        block: index,
        open: span.open,
        close: span.close,
        text: finishLine(sliceText(raw, inner)),
      });
    }
  });
  const promptText = renderPrompt(mask, blocks, quotes);
  removeQuotes(mask);
  return { mask, blocks, quotes, dropped, promptText };
}

export type QuoteLabel =
  { kind: 'narration' } | { kind: 'speech'; speaker: string; dmWrotePc?: string };

export interface NarrationPiece {
  kind: 'narration' | 'dialogue';
  speaker: string;
  ranges: Range[];
  dmWrotePc?: string;
}

/**
 * The narration as lines: each quote labeled as speech becomes a dialogue line, with the text
 * before and after it as narration; quotes labeled as narration stay in the surrounding text.
 * `labels[i]` labels quote `i + 1`. Pieces with no words are skipped.
 */
export function narrationPieces(
  segmented: SegmentedNarration,
  labels: readonly QuoteLabel[]
): NarrationPiece[] {
  const { mask, blocks, quotes } = segmented;
  if (labels.length !== quotes.length) {
    throw new Error(`Expected ${quotes.length} quote label(s), got ${labels.length}.`);
  }
  const pieces: NarrationPiece[] = [];
  blocks.forEach((block, index) => {
    let cursor = block.start;
    const addNarration = (end: number) => {
      const ranges = mask.kept(cursor, end);
      if (hasWords(mask, ranges)) pieces.push({ kind: 'narration', speaker: 'dm', ranges });
    };
    for (const quote of quotes) {
      const label = labels[quote.n - 1]!;
      if (quote.block !== index || label.kind === 'narration') continue;
      addNarration(quote.open);
      const end = quote.close ?? block.end;
      pieces.push({
        kind: 'dialogue',
        speaker: label.speaker,
        ranges: mask.kept(quote.open + 1, end),
        ...(label.dmWrotePc ? { dmWrotePc: label.dmWrotePc } : {}),
      });
      cursor = quote.close === null ? block.end : quote.close + 1;
    }
    addNarration(block.end);
  });
  return pieces;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/script`
Expected: PASS. If the hand-off test for "Hand off to Kira Vale." fails, read `resolvePhraseTarget` in `packages/core/src/hand-off-prose.ts` and use a phrase it resolves (the test is about wiring, not the resolver).

- [ ] **Step 5: Check and commit**

```bash
npx prettier --write packages/script
npm run typecheck && npm test && npm run format:check
git add packages/script
git commit -m "feat(script): segment DM narration and split labeled quotes into lines

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Quote attribution — prompt, reply checks, rules fallback, `ModelLabeler`

The model only says who speaks each numbered quote. Everything it returns is checked; an unusable reply gets one retry, then the build falls back to rules. Answers are cached by content hash.

**Files:**

- Create: `packages/script/src/attribution.ts`
- Modify: `packages/script/src/index.ts` (add `export * from './attribution';`)
- Test: `packages/script/test/attribution.test.ts`

**Interfaces:**

- Consumes: `findJsonReply`, `slugify`, `countWords`, types `ChatMessage`, `ModelClient` from `@cartyx-sim/core`; `ScriptedModelClient` from `@cartyx-sim/core/testing` (tests; `new ScriptedModelClient({ seat: [responses] })`, a response is `{ text, toolCalls: [] }` or `{ throw: 'message' }`, `.requests` records calls, `.remaining(seat)`).
- Produces:
  - `LABEL_PROMPT_VERSION = 1`, `UNNAMED_LABEL = 'unnamed'`
  - `LabelRequest { seq: number; narration: string; quotes: string[]; npcs: { id: string; name: string; description: string }[]; pcs: { id: string; name: string }[]; newLabels: string[] }`
  - `SpanLabel = { kind: 'npc'; id: string } | { kind: 'new'; label: string } | { kind: 'pc'; id: string } | { kind: 'none' }` (`label` is trimmed and lowercased)
  - `LabelResult = { labels: SpanLabel[]; source: 'model' | 'cache' } | { labels: null; reason: string }`
  - `interface Labeler { label(request: LabelRequest): Promise<LabelResult> }`
  - `LabelReply` (zod) `{ labels: { quote: number; speaker: string }[] }`
  - `buildLabelMessages(request): ChatMessage[]`
  - `checkLabels(reply: LabelReply, request): { labels: SpanLabel[] } | { error: string }`
  - `parseLabelReply(text, request): { labels: SpanLabel[]; reply: LabelReply } | { error: string }`
  - `fallbackLabels(request, sceneNpcIds: readonly string[]): SpanLabel[]`
  - `labelCacheKey(modelId: string, request: LabelRequest): Promise<string>` (64 hex chars)
  - `interface LabelCache { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }`
  - `class ModelLabeler implements Labeler`, `constructor(options: { model: ModelClient; seat: string; modelId: string; cache?: LabelCache; refresh?: boolean })`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/script/test/attribution.test.ts
import { ScriptedModelClient } from '@cartyx-sim/core/testing';
import { describe, expect, it } from 'vitest';
import {
  buildLabelMessages,
  fallbackLabels,
  labelCacheKey,
  ModelLabeler,
  parseLabelReply,
  type LabelCache,
  type LabelRequest,
} from '../src/attribution';

const REQUEST: LabelRequest = {
  seq: 73,
  narration: 'The slit opens. [[1]]"You... opened... the door," it rasps. [[2]]"Hm."',
  quotes: ['You... opened... the door.', 'Hm.'],
  npcs: [{ id: 'npc-warden', name: 'The Warden', description: 'A stone guardian' }],
  pcs: [{ id: 'kira', name: 'Kira Vale' }],
  newLabels: ['faceless creature'],
};

class MemoryCache implements LabelCache {
  readonly entries = new Map<string, unknown>();
  async get(key: string) {
    return this.entries.get(key);
  }
  async set(key: string, value: unknown) {
    this.entries.set(key, value);
  }
}

const reply = (labels: { quote: number; speaker: string }[]) => ({
  text: JSON.stringify({ labels }),
  toolCalls: [],
});

describe('buildLabelMessages', () => {
  it('lists NPCs, PCs, earlier labels, and the numbered narration', () => {
    const [system, user] = buildLabelMessages(REQUEST);
    expect(system?.role).toBe('system');
    expect(system && 'content' in system ? system.content : '').toContain('"new:');
    const content = user && 'content' in user ? user.content : '';
    expect(content).toContain('- npc-warden: The Warden — A stone guardian');
    expect(content).toContain('- kira: Kira Vale');
    expect(content).toContain('- new:faceless creature');
    expect(content).toContain('Narration (2 quotations):');
    expect(content).toContain(REQUEST.narration);
  });

  it('writes (none) for empty lists', () => {
    const [, user] = buildLabelMessages({ ...REQUEST, npcs: [], newLabels: [] });
    const content = user && 'content' in user ? user.content : '';
    expect(content).toContain('Known NPCs:\n(none)');
    expect(content).toContain('Earlier new: labels this session:\n(none)');
  });
});

describe('parseLabelReply', () => {
  it('maps every speaker form, ignoring think blocks and surrounding text', () => {
    const text =
      '<think>{"labels": []}</think>Here: {"labels": [' +
      '{"quote": 2, "speaker": "none"}, {"quote": 1, "speaker": "new:  Faceless Creature "}]}';
    const parsed = parseLabelReply(text, REQUEST);
    expect('labels' in parsed && parsed.labels).toEqual([
      { kind: 'new', label: 'faceless creature' },
      { kind: 'none' },
    ]);
  });

  it('accepts known NPC and PC ids', () => {
    const parsed = parseLabelReply(
      JSON.stringify({
        labels: [
          { quote: 1, speaker: 'npc-warden' },
          { quote: 2, speaker: 'kira' },
        ],
      }),
      REQUEST
    );
    expect('labels' in parsed && parsed.labels).toEqual([
      { kind: 'npc', id: 'npc-warden' },
      { kind: 'pc', id: 'kira' },
    ]);
  });

  it.each([
    ['no JSON', 'I think quote 1 is the creature.', /no JSON object/],
    [
      'a missing quote',
      JSON.stringify({ labels: [{ quote: 1, speaker: 'none' }] }),
      /quote 2 has no label/,
    ],
    [
      'a duplicate quote',
      JSON.stringify({
        labels: [
          { quote: 1, speaker: 'none' },
          { quote: 1, speaker: 'none' },
        ],
      }),
      /quote 1 is labeled twice/,
    ],
    [
      'an out-of-range quote',
      JSON.stringify({ labels: [{ quote: 3, speaker: 'none' }] }),
      /quote 3 does not exist/,
    ],
    [
      'an unknown speaker',
      JSON.stringify({ labels: [{ quote: 1, speaker: 'npc-ghost' }] }),
      /unknown speaker "npc-ghost"/,
    ],
    [
      'an empty new label',
      JSON.stringify({ labels: [{ quote: 1, speaker: 'new: ' }] }),
      /unknown speaker/,
    ],
  ])('rejects %s', (_name, text, error) => {
    const parsed = parseLabelReply(text, REQUEST);
    expect('error' in parsed && parsed.error).toMatch(error);
  });
});

describe('fallbackLabels', () => {
  it('labels short quotes as not speech and others as the only scene NPC', () => {
    expect(fallbackLabels(REQUEST, ['npc-warden'])).toEqual([
      { kind: 'npc', id: 'npc-warden' },
      { kind: 'none' },
    ]);
  });

  it('uses the unnamed speaker when the scene has no single NPC', () => {
    expect(fallbackLabels(REQUEST, [])[0]).toEqual({ kind: 'new', label: 'unnamed' });
    expect(fallbackLabels(REQUEST, ['npc-a', 'npc-b'])[0]).toEqual({
      kind: 'new',
      label: 'unnamed',
    });
  });
});

describe('labelCacheKey', () => {
  it('is a sha-256 hex digest that depends on the model and the request', async () => {
    const key = await labelCacheKey('glm', REQUEST);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await labelCacheKey('glm', REQUEST)).toBe(key);
    expect(await labelCacheKey('qwen', REQUEST)).not.toBe(key);
    expect(await labelCacheKey('glm', { ...REQUEST, seq: 74 })).not.toBe(key);
  });
});

describe('ModelLabeler', () => {
  const good = [
    { quote: 1, speaker: 'new:faceless creature' },
    { quote: 2, speaker: 'none' },
  ];

  it('asks the seat once, returns the labels, and caches the reply', async () => {
    const model = new ScriptedModelClient({ script: [reply(good)] });
    const cache = new MemoryCache();
    const labeler = new ModelLabeler({ model, seat: 'script', modelId: 'glm', cache });
    const result = await labeler.label(REQUEST);
    expect(result).toEqual({
      labels: [{ kind: 'new', label: 'faceless creature' }, { kind: 'none' }],
      source: 'model',
    });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toMatchObject({ seat: 'script', tools: [], toolChoice: 'auto' });
    expect([...cache.entries.values()]).toEqual([{ labels: good }]);
  });

  it('retries once with the problem, then succeeds', async () => {
    const model = new ScriptedModelClient({
      script: [{ text: 'no idea', toolCalls: [] }, reply(good)],
    });
    const result = await new ModelLabeler({ model, seat: 'script', modelId: 'glm' }).label(REQUEST);
    expect(result.labels).not.toBeNull();
    expect(model.requests).toHaveLength(2);
    const retry = model.requests[1]!.messages.at(-1);
    expect(retry && 'content' in retry ? retry.content : '').toMatch(/could not be used/);
  });

  it('gives up after two unusable replies', async () => {
    const model = new ScriptedModelClient({
      script: [
        { text: 'no idea', toolCalls: [] },
        { text: 'still no idea', toolCalls: [] },
      ],
    });
    const result = await new ModelLabeler({ model, seat: 'script', modelId: 'glm' }).label(REQUEST);
    expect(result).toEqual({ labels: null, reason: expect.stringMatching(/model reply unusable/) });
  });

  it('reports an unavailable seat without throwing', async () => {
    const model = new ScriptedModelClient({ script: [{ throw: 'Every endpoint failed' }] });
    const result = await new ModelLabeler({ model, seat: 'script', modelId: 'glm' }).label(REQUEST);
    expect(result).toEqual({
      labels: null,
      reason: expect.stringMatching(/script seat unavailable \(Every endpoint failed\)/),
    });
  });

  it('answers from the cache without calling the seat, unless refreshing', async () => {
    const cache = new MemoryCache();
    cache.entries.set(await labelCacheKey('glm', REQUEST), { labels: good });
    const model = new ScriptedModelClient({ script: [reply(good)] });
    const cached = await new ModelLabeler({ model, seat: 'script', modelId: 'glm', cache }).label(
      REQUEST
    );
    expect(cached.labels && cached.source).toBe('cache');
    expect(model.remaining('script')).toBe(1);

    const refreshed = await new ModelLabeler({
      model,
      seat: 'script',
      modelId: 'glm',
      cache,
      refresh: true,
    }).label(REQUEST);
    expect(refreshed.labels && refreshed.source).toBe('model');
    expect(model.remaining('script')).toBe(0);
  });

  it('ignores a cached value that no longer checks out', async () => {
    const cache = new MemoryCache();
    cache.entries.set(await labelCacheKey('glm', REQUEST), {
      labels: [{ quote: 1, speaker: 'x' }],
    });
    const model = new ScriptedModelClient({ script: [reply(good)] });
    const result = await new ModelLabeler({ model, seat: 'script', modelId: 'glm', cache }).label(
      REQUEST
    );
    expect(result.labels && result.source).toBe('model');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/script/test/attribution.test.ts`
Expected: FAIL, module `../src/attribution` not found.

- [ ] **Step 3: Write `attribution.ts`**

```ts
// packages/script/src/attribution.ts
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/script`
Expected: PASS.

- [ ] **Step 5: Check and commit**

```bash
npx prettier --write packages/script
npm run typecheck && npm test && npm run format:check
git add packages/script
git commit -m "feat(script): label narration quotes with a checked, cached model reply

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Speaker table and `speakers.json` overrides

**Files:**

- Create: `packages/script/src/speakers.ts`
- Modify: `packages/script/src/index.ts` (add `export * from './speakers';`)
- Test: `packages/script/test/speakers.test.ts`

**Interfaces:**

- Consumes: `ownEntry` from `@cartyx-sim/core`; `ScriptError`, `Speaker`, `ScriptLine`, `SpeakerOverrides`, `isVoiced` from `schema.ts`.
- Produces:
  - `class SpeakerTable` — `constructor(party: readonly { id: string; name: string }[])` (adds `dm` then each PC); `pc(id): string`; `npc(id, name): string`; `unlisted(id, name, seq): string` (each adds the speaker if missing and returns the id; an existing entry is never changed); `list(): Speaker[]` (insertion order).
  - `applySpeakerOverrides(speakers: readonly Speaker[], lines: readonly ScriptLine[], overrides: SpeakerOverrides): { speakers: Speaker[]; lines: ScriptLine[] }` — throws `ScriptError` with messages starting `speakers.json: `.

**Override rules:** a key must be a speaker in the script. `name` renames. `id` (different from the key) merges an NPC into another NPC: the merged speaker disappears, its lines move, and an unlisted target keeps the earliest `firstSeq`. Errors: unknown key; merging a PC or the DM; merging into an unknown speaker or a non-NPC; a key with both a different `id` and a `name`; merging into a speaker that is itself merged.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/script/test/speakers.test.ts
import { describe, expect, it } from 'vitest';
import type { ScriptLine, Speaker } from '../src/schema';
import { applySpeakerOverrides, SpeakerTable } from '../src/speakers';

const PARTY = [
  { id: 'kira', name: 'Kira Vale' },
  { id: 'tomas', name: 'Tomas Reed' },
];

function table(): Speaker[] {
  const speakers = new SpeakerTable(PARTY);
  speakers.unlisted('npc-thing', 'Thing', 40);
  speakers.unlisted('npc-faceless-creature', 'Faceless creature', 73);
  speakers.npc('npc-warden', 'The Warden');
  return speakers.list();
}

function line(id: string, speaker: string): ScriptLine {
  return {
    id,
    kind: 'dialogue',
    speaker,
    text: 'Hm.',
    emotion: 'neutral',
    sources: [{ seq: 1, start: 0, end: 3 }],
  };
}

describe('SpeakerTable', () => {
  it('starts with the DM and the party and adds NPCs once, in order', () => {
    const speakers = new SpeakerTable(PARTY);
    expect(speakers.npc('npc-warden', 'The Warden')).toBe('npc-warden');
    expect(speakers.npc('npc-warden', 'Someone Else')).toBe('npc-warden');
    expect(speakers.unlisted('npc-thing', 'Thing', 12)).toBe('npc-thing');
    expect(speakers.unlisted('npc-thing', 'Other', 99)).toBe('npc-thing');
    expect(speakers.pc('bram')).toBe('bram');
    expect(speakers.list()).toEqual([
      { id: 'dm', name: 'Dungeon Master', kind: 'dm' },
      { id: 'kira', name: 'Kira Vale', kind: 'pc' },
      { id: 'tomas', name: 'Tomas Reed', kind: 'pc' },
      { id: 'npc-warden', name: 'The Warden', kind: 'npc' },
      { id: 'npc-thing', name: 'Thing', kind: 'npc', unlisted: true, firstSeq: 12 },
      { id: 'bram', name: 'bram', kind: 'pc' },
    ]);
  });
});

describe('applySpeakerOverrides', () => {
  it('renames a speaker', () => {
    const result = applySpeakerOverrides(table(), [], {
      'npc-faceless-creature': { name: 'The Faceless One' },
      kira: { id: 'kira', name: 'Kira' },
    });
    expect(result.speakers.find((s) => s.id === 'npc-faceless-creature')?.name).toBe(
      'The Faceless One'
    );
    expect(result.speakers.find((s) => s.id === 'kira')?.name).toBe('Kira');
  });

  it('merges an NPC into another, moving its lines and keeping the earliest first seq', () => {
    const result = applySpeakerOverrides(
      table(),
      [line('L0001', 'npc-thing'), line('L0002', 'kira')],
      { 'npc-thing': { id: 'npc-faceless-creature' } }
    );
    expect(result.speakers.map((s) => s.id)).toEqual([
      'dm',
      'kira',
      'tomas',
      'npc-faceless-creature',
      'npc-warden',
    ]);
    expect(result.speakers.find((s) => s.id === 'npc-faceless-creature')?.firstSeq).toBe(40);
    expect(result.lines.map((l) => ('speaker' in l ? l.speaker : ''))).toEqual([
      'npc-faceless-creature',
      'kira',
    ]);
  });

  it.each([
    ['an unknown key', { 'npc-ghost': { name: 'Ghost' } }, /"npc-ghost" is not a speaker/],
    ['merging a PC', { kira: { id: 'npc-warden' } }, /"kira" is a pc; only NPCs can be merged/],
    [
      'merging into an unknown speaker',
      { 'npc-thing': { id: 'npc-ghost' } },
      /merges into "npc-ghost", which is not a speaker/,
    ],
    ['merging into the DM', { 'npc-thing': { id: 'dm' } }, /cannot merge into the dm "dm"/],
    [
      'setting both a merge and a name',
      { 'npc-thing': { id: 'npc-warden', name: 'X' } },
      /sets both "id" and "name"/,
    ],
    [
      'merging into a merged speaker',
      {
        'npc-thing': { id: 'npc-faceless-creature' },
        'npc-faceless-creature': { id: 'npc-warden' },
      },
      /which is itself merged; merge into "npc-warden" instead/,
    ],
  ])('rejects %s', (_name, overrides, message) => {
    expect(() => applySpeakerOverrides(table(), [], overrides)).toThrow(message);
    expect(() => applySpeakerOverrides(table(), [], overrides)).toThrow(/^speakers\.json: /);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/script/test/speakers.test.ts`
Expected: FAIL, module `../src/speakers` not found.

- [ ] **Step 3: Write `speakers.ts`**

```ts
// packages/script/src/speakers.ts
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/script`
Expected: PASS.

- [ ] **Step 5: Check and commit**

```bash
npx prettier --write packages/script
npm run typecheck && npm test && npm run format:check
git add packages/script
git commit -m "feat(script): track speakers and apply speakers.json renames and merges

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Build the script from the event log, with invariant checks

**Files:**

- Create: `packages/script/src/build.ts`, `packages/script/src/invariants.ts`, `packages/script/test/helpers.ts`
- Modify: `packages/script/src/index.ts` (add `export * from './build';` and `export * from './invariants';`)
- Test: `packages/script/test/build.test.ts`, `packages/script/test/invariants.test.ts`

**Interfaces:**

- Consumes: `applyEvent`, `countWords`, `initialState`, `ownEntry`, `slugify`, types `GameState`, `SimEvent`, `EventInput`, class `TurnRecorder` (tests) from `@cartyx-sim/core`; `makeCombatant` from `@cartyx-sim/rules/testing` (tests); everything from Tasks 2–6.
- Produces:
  - `BuildInput { campaign: string; session: number; eventsSha256: string; events: readonly SimEvent[]; labeler?: Labeler; speakers?: SpeakerOverrides }`
  - `BuildStats { lines: Partial<Record<LineKind, number>>; labels: { model: number; cache: number; fallback: number }; stageDirections: number; spokenWords: number; unlisted: string[] }`
  - `buildScript(input: BuildInput): Promise<{ script: ScriptFile; stats: BuildStats }>` — throws `ScriptError` for a log that does not begin with `session_start` and for bad overrides; throws `Error` if its own output breaks an invariant (a bug).
  - `invariantViolations(script: ScriptFile, events: readonly SimEvent[]): string[]`

**Build rules (spec §5):**

- `applyEvent` folds every event (for names); `npc_introduced` records descriptions and the scene's NPCs; `scene_change` resets the scene's NPCs.
- `session_paused` (any visibility) followed by any later event adds one `pause` line sourced at the pause.
- Only public events make lines: `dialogue` → `splitSpeech`; `action` → `cleanAction` (speaker: the PC, or an NPC for anyone else); `narration` → `segmentNarration` + labels + `narrationPieces` (dialogue pieces take emotion `neutral`, narration pieces the event's); `roll`, `scene_change`, `combat_start`/`combat_turn`/`combat_end`, and `state_change` on `hp`, `conditions`, or `dead` becoming true → cues. Everything else is skipped.
- Labels: the labeler when given; if it returns `labels: null`, the rules fallback plus a note `Quotes attributed by rules: <reason>.`; with no labeler, the rules fallback and no note. `new:<label>` → `npc-<slug>`: an introduced NPC with that id is used as is, otherwise an unlisted NPC named with the label capitalized. A PC label → a DM-voiced dialogue line with `flags.dmWrotePc`.
- Dropped spans attach to the last line of the same event that starts at or before them (or its first line); with no line, they go on a note `Dropped text from an event that produced no line.`
- Line ids are `L0001`… in order; an interjection's `overlaps` seq maps to the first line of that event.

- [ ] **Step 1: Write the test helper**

```ts
// packages/script/test/helpers.ts
import { initialState, TurnRecorder, type EventInput, type SimEvent } from '@cartyx-sim/core';
import type { Combatant } from '@cartyx-sim/rules';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import type { Labeler, LabelRequest, LabelResult } from '../src/attribution';

export const KIRA = makeCombatant({ id: 'kira', name: 'Kira Vale' });
export const TOMAS = makeCombatant({ id: 'tomas', name: 'Tomas Reed' });
export const SHA = 'a'.repeat(64);

const NOW = () => new Date('2026-09-16T12:00:00.000Z');

/** A valid log: `session_start` (seq 0) with the party, then `inputs` as seq 1, 2, … */
export function eventLog(inputs: EventInput[], party: Combatant[] = [KIRA, TOMAS]): SimEvent[] {
  const recorder = new TurnRecorder(initialState(), 'test-turn', NOW);
  recorder.emit({
    type: 'session_start',
    session: 1,
    loreCommit: 'test',
    targetMinutes: 60,
    party,
  });
  for (const input of inputs) recorder.emit(input);
  return [...recorder.events];
}

export function narration(text: string): EventInput {
  return { type: 'narration', speaker: 'dm', text, emotion: 'neutral' };
}

/** A labeler that records requests and answers with `answer`. */
export class FakeLabeler implements Labeler {
  readonly requests: LabelRequest[] = [];

  constructor(private readonly answer: (request: LabelRequest) => LabelResult) {}

  async label(request: LabelRequest): Promise<LabelResult> {
    this.requests.push(request);
    return this.answer(request);
  }
}
```

- [ ] **Step 2: Write the failing build tests**

```ts
// packages/script/test/build.test.ts
import { makeCombatant } from '@cartyx-sim/rules/testing';
import { describe, expect, it } from 'vitest';
import { buildScript } from '../src/build';
import { ScriptError, type ScriptFile } from '../src/schema';
import { eventLog, FakeLabeler, KIRA, narration, SHA, TOMAS } from './helpers';

const CREATURE = 'The slit opens.\n\n*"You... opened... the door,"* it rasps.\n\n**Hand off.**';

const TABLE_LOG = eventLog([
  { type: 'scene_change', location: 'Eldergrove gate', artPrompt: 'A ruined arch' }, // 1
  narration(CREATURE), // 2
  {
    type: 'dialogue',
    speaker: 'kira',
    speakerKind: 'pc',
    emotion: 'whisper',
    text: '"Holding its breath." I keep my voice low. "Or holding us."',
  }, // 3
  {
    type: 'dialogue',
    speaker: 'tomas',
    speakerKind: 'pc',
    emotion: 'afraid',
    text: 'Not now!',
    overlaps: 3,
  }, // 4
  { type: 'action', actor: 'tomas', intent: 'Raise my *shield*' }, // 5
  {
    type: 'roll',
    actor: 'tomas',
    kind: 'check',
    label: 'Tomas Reed Athletics check',
    expr: '1d20+3',
    rolls: [12],
    modifier: 3,
    total: 15,
    target: 12,
    outcome: 'success',
    mode: 'normal',
  }, // 6
  { type: 'ooc_note', visibility: 'dm', text: 'Checker reply: {}' }, // 7
  {
    type: 'npc_introduced',
    npcId: 'npc-warden',
    name: 'The Warden',
    description: 'A stone guardian',
    invented: true,
  }, // 8
  {
    type: 'dialogue',
    speaker: 'npc-warden',
    speakerKind: 'npc',
    emotion: 'angry',
    text: 'Leave.',
  }, // 9
]);

const creatureLabeler = () =>
  new FakeLabeler(() => ({
    labels: [{ kind: 'new', label: 'faceless creature' }],
    source: 'model',
  }));

function build(events = TABLE_LOG, extra: Partial<Parameters<typeof buildScript>[0]> = {}) {
  return buildScript({ campaign: 'avalon', session: 3, eventsSha256: SHA, events, ...extra });
}

function summary(script: ScriptFile) {
  return script.lines.map((line) =>
    'text' in line ? [line.id, line.kind, line.speaker, line.text] : [line.id, line.kind]
  );
}

describe('buildScript', () => {
  it('turns a table exchange into ordered, attributed lines and cues', async () => {
    const labeler = creatureLabeler();
    const { script, stats } = await build(TABLE_LOG, { labeler });

    expect(summary(script)).toEqual([
      ['L0001', 'scene'],
      ['L0002', 'narration', 'dm', 'The slit opens.'],
      ['L0003', 'dialogue', 'npc-faceless-creature', 'You... opened... the door.'],
      ['L0004', 'narration', 'dm', 'it rasps.'],
      ['L0005', 'dialogue', 'kira', 'Holding its breath.'],
      ['L0006', 'dialogue', 'kira', 'Or holding us.'],
      ['L0007', 'dialogue', 'tomas', 'Not now!'],
      ['L0008', 'action', 'tomas', 'Raise my shield.'],
      ['L0009', 'roll'],
      ['L0010', 'dialogue', 'npc-warden', 'Leave.'],
    ]);
    expect(script).toMatchObject({
      scriptSchemaVersion: 1,
      campaign: 'avalon',
      session: 3,
      eventsSha256: SHA,
      notes: [],
    });
    expect(script.speakers).toEqual([
      { id: 'dm', name: 'Dungeon Master', kind: 'dm' },
      { id: 'kira', name: 'Kira Vale', kind: 'pc' },
      { id: 'tomas', name: 'Tomas Reed', kind: 'pc' },
      {
        id: 'npc-faceless-creature',
        name: 'Faceless creature',
        kind: 'npc',
        unlisted: true,
        firstSeq: 2,
      },
      { id: 'npc-warden', name: 'The Warden', kind: 'npc' },
    ]);

    const [, , dialogue, rasps, kira, , tomas] = script.lines;
    expect(dialogue).toMatchObject({ emotion: 'neutral' });
    expect(rasps).toMatchObject({
      emotion: 'neutral',
      dropped: [{ seq: 2, reason: 'hand_off', text: '**Hand off.**' }],
    });
    expect(kira).toMatchObject({
      emotion: 'whisper',
      dropped: [{ seq: 3, reason: 'stage_direction', text: 'I keep my voice low.' }],
    });
    expect(tomas).toMatchObject({ overlaps: 'L0005' });
    expect(script.lines[8]).toMatchObject({
      sources: [{ seq: 6 }],
      roll: { actor: 'tomas', actorName: 'Tomas Reed', total: 15, target: 12, outcome: 'success' },
    });

    expect(stats).toEqual({
      lines: { scene: 1, narration: 2, dialogue: 5, action: 1, roll: 1 },
      labels: { model: 1, cache: 0, fallback: 0 },
      stageDirections: 1,
      spokenWords: 21,
      unlisted: ['npc-faceless-creature'],
    });
    expect(labeler.requests).toEqual([
      {
        seq: 2,
        narration: 'The slit opens.\n\n[[1]]"You... opened... the door," it rasps.',
        quotes: ['You... opened... the door.'],
        npcs: [],
        pcs: [
          { id: 'kira', name: 'Kira Vale' },
          { id: 'tomas', name: 'Tomas Reed' },
        ],
        newLabels: [],
      },
    ]);
  });

  it('adds cues for combat, visible state changes, and a resumed pause', async () => {
    const goblin = makeCombatant({
      id: 'goblin-1',
      name: 'Goblin',
      kind: 'monster',
      hp: 7,
      maxHp: 7,
    });
    const events = eventLog([
      { type: 'combatant_added', combatant: goblin },
      {
        type: 'combat_start',
        order: [
          { combatantId: 'goblin-1', roll: 15, dexMod: 2, total: 17 },
          { combatantId: 'kira', roll: 10, dexMod: 0, total: 10 },
          { combatantId: 'tomas', roll: 6, dexMod: 0, total: 6 },
        ],
      },
      { type: 'combat_turn', round: 1, turnIndex: 0, combatantId: 'goblin-1' },
      { type: 'state_change', entity: 'goblin-1', field: 'hp', before: 7, after: 3, cause: 'hit' },
      { type: 'state_change', entity: 'kira', field: 'tempHp', before: 0, after: 2, cause: 'x' },
      { type: 'session_paused', visibility: 'dm', seat: 'dm', reason: 'Seat failed', kind: 'seat' },
      { type: 'ooc_note', visibility: 'dm', text: 'Session resumed.' },
      { type: 'combat_end' },
    ]);
    const { script } = await build(events);
    expect(script.lines).toEqual([
      {
        id: 'L0001',
        kind: 'combat',
        sources: [{ seq: 2 }],
        combat: {
          phase: 'start',
          order: [
            { combatantId: 'goblin-1', name: 'Goblin', total: 17 },
            { combatantId: 'kira', name: 'Kira Vale', total: 10 },
            { combatantId: 'tomas', name: 'Tomas Reed', total: 6 },
          ],
        },
      },
      {
        id: 'L0002',
        kind: 'combat',
        sources: [{ seq: 3 }],
        combat: { phase: 'turn', round: 1, combatantId: 'goblin-1', name: 'Goblin' },
      },
      {
        id: 'L0003',
        kind: 'state',
        sources: [{ seq: 4 }],
        state: {
          entity: 'goblin-1',
          name: 'Goblin',
          field: 'hp',
          before: 7,
          after: 3,
          hidden: true,
        },
      },
      { id: 'L0004', kind: 'pause', sources: [{ seq: 6 }], pause: { reason: 'Seat failed' } },
      { id: 'L0005', kind: 'combat', sources: [{ seq: 8 }], combat: { phase: 'end' } },
    ]);
  });

  it('attributes quotes by rules without a labeler, and says why when the labeler fails', async () => {
    const { script, stats } = await build();
    expect(script.lines[2]).toMatchObject({ speaker: 'npc-unnamed' });
    expect(script.speakers).toContainEqual({
      id: 'npc-unnamed',
      name: 'Unnamed',
      kind: 'npc',
      unlisted: true,
      firstSeq: 2,
    });
    expect(stats.labels).toEqual({ model: 0, cache: 0, fallback: 1 });
    expect(script.notes).toEqual([]);

    const failing = new FakeLabeler(() => ({
      labels: null,
      reason: 'script seat unavailable (down)',
    }));
    const failed = await build(TABLE_LOG, { labeler: failing });
    expect(failed.script.notes).toEqual([
      { seq: 2, text: 'Quotes attributed by rules: script seat unavailable (down).' },
    ]);
  });

  it('gives a quote to the only NPC in the scene when rules decide', async () => {
    const events = eventLog([
      { type: 'scene_change', location: 'Hall', artPrompt: 'A hall' },
      {
        type: 'npc_introduced',
        npcId: 'npc-warden',
        name: 'The Warden',
        description: 'A stone guardian',
        invented: true,
      },
      narration('It turns. "You should not be here."'),
    ]);
    const { script } = await build(events);
    expect(summary(script)).toContainEqual([
      'L0003',
      'dialogue',
      'npc-warden',
      'You should not be here.',
    ]);
  });

  it('uses an introduced NPC when a new label matches its id, and shares earlier labels', async () => {
    const events = eventLog([
      {
        type: 'npc_introduced',
        npcId: 'npc-faceless-creature',
        name: 'The Faceless',
        description: 'No face',
        invented: true,
      },
      narration('"Leave this place," it says.'),
      narration('"Now," it says again.'),
    ]);
    const labeler = new FakeLabeler((request) => ({
      labels: request.quotes.map(() => ({ kind: 'new', label: 'faceless creature' })),
      source: 'cache',
    }));
    const { script, stats } = await build(events, { labeler });
    expect(script.speakers.at(-1)).toEqual({
      id: 'npc-faceless-creature',
      name: 'The Faceless',
      kind: 'npc',
    });
    expect(labeler.requests[0]!.npcs).toEqual([
      { id: 'npc-faceless-creature', name: 'The Faceless', description: 'No face' },
    ]);
    expect(labeler.requests[1]!.newLabels).toEqual(['faceless creature']);
    expect(stats.labels.cache).toBe(2);
  });

  it('keeps DM-written PC dialogue in the DM voice with a flag', async () => {
    const events = eventLog([narration('Kira nods. "We go now," she says.')]);
    const labeler = new FakeLabeler(() => ({
      labels: [{ kind: 'pc', id: 'kira' }],
      source: 'model',
    }));
    const { script } = await build(events, { labeler });
    expect(script.lines[1]).toMatchObject({
      kind: 'dialogue',
      speaker: 'dm',
      text: 'We go now.',
      flags: { dmWrotePc: 'kira' },
    });
  });

  it('applies speakers.json overrides', async () => {
    const { script } = await build(TABLE_LOG, {
      labeler: creatureLabeler(),
      speakers: { 'npc-faceless-creature': { id: 'npc-warden' } },
    });
    expect(script.lines[2]).toMatchObject({ speaker: 'npc-warden' });
    expect(script.speakers.map((speaker) => speaker.id)).not.toContain('npc-faceless-creature');
    await expect(
      build(TABLE_LOG, { speakers: { 'npc-ghost': { name: 'Ghost' } } })
    ).rejects.toThrow(ScriptError);
  });

  it('keeps text dropped from an event with no line on a note', async () => {
    const { script } = await build(eventLog([narration('**Hand off.**')]));
    expect(script.lines).toEqual([]);
    expect(script.notes).toEqual([
      {
        seq: 1,
        text: 'Dropped text from an event that produced no line.',
        dropped: [{ seq: 1, start: 0, end: 13, reason: 'hand_off', text: '**Hand off.**' }],
      },
    ]);
  });

  it('refuses a log that does not begin with session_start', async () => {
    const events = eventLog([narration('Mist.')]).slice(1);
    await expect(build(events)).rejects.toThrow(ScriptError);
  });

  it('keeps party speakers in session_start order', async () => {
    const { script } = await build(eventLog([], [TOMAS, KIRA]));
    expect(script.speakers.map((speaker) => speaker.id)).toEqual(['dm', 'tomas', 'kira']);
  });
});
```

- [ ] **Step 3: Write the failing invariant tests**

```ts
// packages/script/test/invariants.test.ts
import { describe, expect, it } from 'vitest';
import { buildScript } from '../src/build';
import { invariantViolations } from '../src/invariants';
import type { ScriptFile, VoicedLine } from '../src/schema';
import { eventLog, narration, SHA } from './helpers';

const EVENTS = eventLog([
  narration('## The Hall\nDM: Dust.\n- a gate\n\n"Who goes there?" a voice asks.\n\nHand off.'),
  {
    type: 'dialogue',
    speaker: 'kira',
    speakerKind: 'pc',
    emotion: 'neutral',
    text: '"Me." I step forward. "Kira."',
  },
]);

async function built(): Promise<ScriptFile> {
  return (await buildScript({ campaign: 'a', session: 1, eventsSha256: SHA, events: EVENTS }))
    .script;
}

describe('invariantViolations', () => {
  it('finds nothing wrong with a built script', async () => {
    expect(invariantViolations(await built(), EVENTS)).toEqual([]);
  });

  it('reports a line whose text does not come from its sources', async () => {
    const script = await built();
    (script.lines[0] as VoicedLine).text = 'Invented words.';
    expect(invariantViolations(script, EVENTS)).toEqual([
      expect.stringMatching(/^L0001: text "Invented words\." does not match its sources/),
    ]);
  });

  it('reports source text that ends up in no line and was not dropped', async () => {
    const script = await built();
    script.lines.splice(-1, 1);
    expect(invariantViolations(script, EVENTS)).toEqual([
      expect.stringMatching(/^seq 2: .* is in no line and was not dropped$/),
    ]);
  });

  it('reports ids out of sequence and sources outside a spoken event', async () => {
    const script = await built();
    const line = script.lines[0] as VoicedLine;
    line.id = 'L0009';
    line.sources = [{ seq: 0, start: 0, end: 3 }];
    const problems = invariantViolations(script, EVENTS);
    expect(problems).toContain('L0009: expected id L0001');
    expect(problems).toContain('L0009: source 0:0-3 is not in a spoken event');
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run packages/script/test/build.test.ts packages/script/test/invariants.test.ts`
Expected: FAIL, modules `../src/build` and `../src/invariants` not found.

- [ ] **Step 5: Write `invariants.ts`**

```ts
// packages/script/src/invariants.ts
import type { SimEvent } from '@cartyx-sim/core';
import { BULLET, finishLine, sourceLines } from './normalize';
import { isVoiced, type ScriptFile } from './schema';

const IGNORABLE = /[\s\p{P}\p{S}]/u;

/** The text a voiced line's sources point into, or undefined for any other event. */
function sourceText(event: SimEvent | undefined): string | undefined {
  if (event?.type === 'narration' || event?.type === 'dialogue') return event.text;
  if (event?.type === 'action') return event.intent;
  return undefined;
}

/** Offsets of list markers at line starts, which markdown removal drops without a record. */
function markerOffsets(text: string): Set<number> {
  const offsets = new Set<number>();
  for (const line of sourceLines(text)) {
    const marker = BULLET.exec(text.slice(line.start, line.end));
    for (let i = 0; marker && i < marker[0].length; i++) offsets.add(line.start + i);
  }
  return offsets;
}

/**
 * Everything wrong with a script against its log (empty when it is sound): ids must run L0001,
 * L0002, … and lines follow log order; every voiced line's text must equal `finishLine` of its
 * source slices; and every letter or digit of a public spoken event must be in some line or a
 * dropped span.
 */
export function invariantViolations(script: ScriptFile, events: readonly SimEvent[]): string[] {
  const problems: string[] = [];
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const covered = new Map<number, Uint8Array>();
  const cover = (seq: number, start: number, end: number) => {
    const text = sourceText(bySeq.get(seq));
    if (text === undefined) return;
    let marks = covered.get(seq);
    if (!marks) {
      marks = new Uint8Array(text.length);
      covered.set(seq, marks);
    }
    marks.fill(1, start, end);
  };

  let lastSeq = -1;
  script.lines.forEach((line, index) => {
    const expectedId = `L${String(index + 1).padStart(4, '0')}`;
    if (line.id !== expectedId) problems.push(`${line.id}: expected id ${expectedId}`);
    const seq = line.sources[0]!.seq;
    if (seq < lastSeq) problems.push(`${line.id}: out of log order`);
    lastSeq = Math.max(lastSeq, seq);
    if (!isVoiced(line)) return;
    const pieces: string[] = [];
    for (const source of line.sources) {
      const text = sourceText(bySeq.get(source.seq));
      if (text === undefined || source.start > source.end || source.end > text.length) {
        problems.push(
          `${line.id}: source ${source.seq}:${source.start}-${source.end} is not in a spoken event`
        );
        return;
      }
      pieces.push(text.slice(source.start, source.end));
      cover(source.seq, source.start, source.end);
    }
    const expected = finishLine(pieces.join(''));
    if (expected !== line.text) {
      problems.push(
        `${line.id}: text ${JSON.stringify(line.text)} does not match its sources ` +
          JSON.stringify(expected)
      );
    }
    for (const span of line.dropped ?? []) cover(span.seq, span.start, span.end);
  });
  for (const note of script.notes) {
    for (const span of note.dropped ?? []) cover(span.seq, span.start, span.end);
  }

  for (const event of events) {
    const text = sourceText(event);
    if (event.visibility !== 'public' || text === undefined) continue;
    const marks = covered.get(event.seq);
    const markers = markerOffsets(text);
    for (let i = 0; i < text.length; i++) {
      if (marks?.[i] === 1 || markers.has(i) || IGNORABLE.test(text[i]!)) continue;
      const context = JSON.stringify(text.slice(Math.max(0, i - 10), i + 10));
      problems.push(`seq ${event.seq}: ${context} is in no line and was not dropped`);
      break;
    }
  }
  return problems;
}
```

- [ ] **Step 6: Write `build.ts`**

```ts
// packages/script/src/build.ts
import {
  applyEvent,
  countWords,
  initialState,
  ownEntry,
  slugify,
  type GameState,
  type SimEvent,
} from '@cartyx-sim/core';
import { fallbackLabels, type Labeler, type LabelRequest, type SpanLabel } from './attribution';
import { invariantViolations } from './invariants';
import { narrationPieces, segmentNarration, type QuoteLabel } from './narration';
import { finishLine, sliceText, type Range } from './normalize';
import {
  isVoiced,
  SCRIPT_SCHEMA_VERSION,
  ScriptError,
  ScriptFile,
  type DroppedSpan,
  type DropReason,
  type LineDraft,
  type LineKind,
  type Note,
  type ScriptLine,
  type SpeakerOverrides,
  type VoicedLine,
} from './schema';
import { applySpeakerOverrides, SpeakerTable } from './speakers';
import { cleanAction, splitSpeech } from './speech';

export interface BuildInput {
  campaign: string;
  session: number;
  eventsSha256: string;
  events: readonly SimEvent[];
  /** Attributes quotes in narration; without one, rules decide. */
  labeler?: Labeler;
  speakers?: SpeakerOverrides;
}

export interface BuildStats {
  lines: Partial<Record<LineKind, number>>;
  /** Quotes labeled by each source. */
  labels: { model: number; cache: number; fallback: number };
  stageDirections: number;
  spokenWords: number;
  /** Ids of NPC speakers with no `npc_introduced` event. */
  unlisted: string[];
}

type VoicedDraft = Omit<VoicedLine, 'id'>;
type SessionStart = Extract<SimEvent, { type: 'session_start' }>;
type Narration = Extract<SimEvent, { type: 'narration' }>;
type Dialogue = Extract<SimEvent, { type: 'dialogue' }>;
type Action = Extract<SimEvent, { type: 'action' }>;

interface Draft {
  line: LineDraft;
  /** The seq of the event an interjection talks over. */
  overlapsSeq?: number;
}

const NO_LINE_NOTE = 'Dropped text from an event that produced no line.';

function nameOf(state: GameState, id: string): string {
  return ownEntry(state.combatants, id)?.name ?? ownEntry(state.npcs, id)?.name ?? id;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function voiced(
  kind: VoicedLine['kind'],
  speaker: string,
  seq: number,
  raw: string,
  ranges: readonly Range[],
  emotion: VoicedLine['emotion']
): VoicedDraft | null {
  const text = finishLine(sliceText(raw, ranges));
  if (text === '') return null;
  const sources = ranges.map((range) => ({ seq, start: range.start, end: range.end }));
  return { kind, speaker, text, emotion, sources };
}

function isDraft(line: VoicedDraft | null): line is VoicedDraft {
  return line !== null;
}

function toDropped(seq: number, raw: string, range: Range, reason: DropReason): DroppedSpan {
  const { start, end } = range;
  return { seq, start, end, reason, text: raw.slice(start, end) };
}

class ScriptBuilder {
  readonly drafts: Draft[] = [];
  readonly notes: Note[] = [];
  readonly speakers: SpeakerTable;
  readonly counts = { model: 0, cache: 0, fallback: 0, stageDirections: 0 };
  private state: GameState = initialState();
  private readonly party: { id: string; name: string }[];
  private readonly descriptions = new Map<string, string>();
  private sceneNpcs: string[] = [];
  private readonly newLabels: string[] = [];

  constructor(
    private readonly input: BuildInput,
    start: SessionStart
  ) {
    this.party = start.party.map((pc) => ({ id: pc.id, name: pc.name }));
    this.speakers = new SpeakerTable(this.party);
  }

  async run(): Promise<void> {
    let pause: { seq: number; reason: string } | undefined;
    for (const event of this.input.events) {
      this.state = applyEvent(this.state, event);
      if (event.type === 'session_paused') {
        pause = { seq: event.seq, reason: event.reason };
        continue;
      }
      if (pause) {
        this.push({
          kind: 'pause',
          sources: [{ seq: pause.seq }],
          pause: { reason: pause.reason },
        });
        pause = undefined;
      }
      if (event.type === 'scene_change') this.sceneNpcs = [];
      if (event.type === 'npc_introduced') {
        this.descriptions.set(event.npcId, event.description);
        if (!this.sceneNpcs.includes(event.npcId)) this.sceneNpcs.push(event.npcId);
      }
      if (event.visibility === 'public') await this.add(event);
    }
  }

  private push(line: LineDraft, overlapsSeq?: number): void {
    this.drafts.push(overlapsSeq === undefined ? { line } : { line, overlapsSeq });
  }

  private async add(event: SimEvent): Promise<void> {
    const seq = event.seq;
    switch (event.type) {
      case 'dialogue':
        return this.addSpeech(event);
      case 'action':
        return this.addAction(event);
      case 'narration':
        return this.addNarration(event);
      case 'roll':
        return this.push({
          kind: 'roll',
          sources: [{ seq }],
          roll: {
            actor: event.actor,
            actorName: nameOf(this.state, event.actor),
            kind: event.kind,
            label: event.label,
            total: event.total,
            target: event.target,
            outcome: event.outcome,
            mode: event.mode,
            subject: event.subject,
            subjectName:
              event.subject === undefined ? undefined : nameOf(this.state, event.subject),
          },
        });
      case 'scene_change':
        return this.push({
          kind: 'scene',
          sources: [{ seq }],
          scene: {
            location: event.location,
            artPrompt: event.artPrompt,
            loreEntityId: event.loreEntityId,
          },
        });
      case 'combat_start':
        return this.push({
          kind: 'combat',
          sources: [{ seq }],
          combat: {
            phase: 'start',
            order: event.order.map((entry) => ({
              combatantId: entry.combatantId,
              name: nameOf(this.state, entry.combatantId),
              total: entry.total,
            })),
          },
        });
      case 'combat_turn':
        return this.push({
          kind: 'combat',
          sources: [{ seq }],
          combat: {
            phase: 'turn',
            round: event.round,
            combatantId: event.combatantId,
            name: nameOf(this.state, event.combatantId),
          },
        });
      case 'combat_end':
        return this.push({ kind: 'combat', sources: [{ seq }], combat: { phase: 'end' } });
      case 'state_change': {
        const shown =
          event.field === 'hp' ||
          event.field === 'conditions' ||
          (event.field === 'dead' && event.after === true);
        if (!shown) return;
        return this.push({
          kind: 'state',
          sources: [{ seq }],
          state: {
            entity: event.entity,
            name: nameOf(this.state, event.entity),
            field: event.field,
            before: event.before,
            after: event.after,
            hidden: ownEntry(this.state.combatants, event.entity)?.kind !== 'pc',
          },
        });
      }
      default:
        return;
    }
  }

  private addSpeech(event: Dialogue): void {
    const split = splitSpeech(event.text);
    const speaker =
      event.speakerKind === 'pc'
        ? this.speakers.pc(event.speaker)
        : this.speakers.npc(event.speaker, nameOf(this.state, event.speaker));
    const lines = split.lines
      .map((ranges) => voiced('dialogue', speaker, event.seq, event.text, ranges, event.emotion))
      .filter(isDraft);
    const dropped = split.directions.map((range) =>
      toDropped(event.seq, event.text, range, 'stage_direction')
    );
    this.counts.stageDirections += dropped.length;
    this.pushEvent(event.seq, lines, dropped, event.overlaps);
  }

  private addAction(event: Action): void {
    const { ranges } = cleanAction(event.intent);
    const speaker =
      ownEntry(this.state.combatants, event.actor)?.kind === 'pc'
        ? this.speakers.pc(event.actor)
        : this.speakers.npc(event.actor, nameOf(this.state, event.actor));
    const line = voiced('action', speaker, event.seq, event.intent, ranges, 'neutral');
    this.pushEvent(event.seq, line ? [line] : [], []);
  }

  private async addNarration(event: Narration): Promise<void> {
    const segmented = segmentNarration(event.text, this.party);
    const labels =
      segmented.quotes.length === 0 ? [] : await this.labelQuotes(event.seq, segmented);
    const lines = narrationPieces(segmented, labels)
      .map((piece) => {
        const emotion = piece.kind === 'dialogue' ? 'neutral' : event.emotion;
        const line = voiced(
          piece.kind,
          piece.speaker,
          event.seq,
          event.text,
          piece.ranges,
          emotion
        );
        if (line && piece.dmWrotePc) line.flags = { dmWrotePc: piece.dmWrotePc };
        return line;
      })
      .filter(isDraft);
    const dropped = segmented.dropped.map((span) =>
      toDropped(event.seq, event.text, span, span.reason)
    );
    this.pushEvent(event.seq, lines, dropped);
  }

  private async labelQuotes(
    seq: number,
    segmented: ReturnType<typeof segmentNarration>
  ): Promise<QuoteLabel[]> {
    const request: LabelRequest = {
      seq,
      narration: segmented.promptText,
      quotes: segmented.quotes.map((quote) => quote.text),
      npcs: Object.values(this.state.npcs).map((npc) => ({
        id: npc.npcId,
        name: npc.name,
        description: this.descriptions.get(npc.npcId) ?? '',
      })),
      pcs: this.party.map((pc) => ({ ...pc })),
      newLabels: [...this.newLabels],
    };
    const result = this.input.labeler ? await this.input.labeler.label(request) : undefined;
    let labels: SpanLabel[];
    if (result?.labels) {
      labels = result.labels;
      this.counts[result.source] += labels.length;
    } else {
      labels = fallbackLabels(request, this.sceneNpcs);
      this.counts.fallback += labels.length;
      if (result) this.notes.push({ seq, text: `Quotes attributed by rules: ${result.reason}.` });
    }
    return labels.map((label) => this.toQuoteLabel(label, seq));
  }

  private toQuoteLabel(label: SpanLabel, seq: number): QuoteLabel {
    switch (label.kind) {
      case 'none':
        return { kind: 'narration' };
      case 'pc':
        return { kind: 'speech', speaker: 'dm', dmWrotePc: label.id };
      case 'npc':
        return {
          kind: 'speech',
          speaker: this.speakers.npc(label.id, nameOf(this.state, label.id)),
        };
      case 'new': {
        if (!this.newLabels.includes(label.label)) this.newLabels.push(label.label);
        const id = `npc-${slugify(label.label)}`;
        const speaker = ownEntry(this.state.npcs, id)
          ? this.speakers.npc(id, nameOf(this.state, id))
          : this.speakers.unlisted(id, capitalize(label.label), seq);
        return { kind: 'speech', speaker };
      }
    }
  }

  /**
   * Adds one event's lines. Each dropped span goes on the last of those lines that starts at or
   * before it (else the first); with no line, the spans go on a note.
   */
  private pushEvent(
    seq: number,
    lines: VoicedDraft[],
    dropped: DroppedSpan[],
    overlapsSeq?: number
  ): void {
    if (lines.length === 0) {
      if (dropped.length > 0) this.notes.push({ seq, text: NO_LINE_NOTE, dropped });
      return;
    }
    for (const span of dropped) {
      const owner = lines.findLast((line) => line.sources[0]!.start <= span.start) ?? lines[0]!;
      (owner.dropped ??= []).push(span);
    }
    lines.forEach((line, index) => this.push(line, index === 0 ? overlapsSeq : undefined));
  }
}

function assignIds(drafts: readonly Draft[]): ScriptLine[] {
  const firstLine = new Map<number, string>();
  const lines = drafts.map((draft, index) => {
    const id = `L${String(index + 1).padStart(4, '0')}`;
    const seq = draft.line.sources[0]!.seq;
    if (!firstLine.has(seq)) firstLine.set(seq, id);
    return { ...draft.line, id } as ScriptLine;
  });
  drafts.forEach((draft, index) => {
    const line = lines[index]!;
    if (draft.overlapsSeq === undefined || !isVoiced(line)) return;
    const target = firstLine.get(draft.overlapsSeq);
    if (target !== undefined && target !== line.id) line.overlaps = target;
  });
  return lines;
}

function summarize(script: ScriptFile, counts: ScriptBuilder['counts']): BuildStats {
  const lines: Partial<Record<LineKind, number>> = {};
  let spokenWords = 0;
  for (const line of script.lines) {
    lines[line.kind] = (lines[line.kind] ?? 0) + 1;
    if (isVoiced(line)) spokenWords += countWords(line.text);
  }
  return {
    lines,
    labels: { model: counts.model, cache: counts.cache, fallback: counts.fallback },
    stageDirections: counts.stageDirections,
    spokenWords,
    unlisted: script.speakers.filter((speaker) => speaker.unlisted).map((speaker) => speaker.id),
  };
}

/**
 * Turns an event log into a script. Text only ever comes from the log: the build drops, splits,
 * and attributes it, and checks its own output with `invariantViolations` before returning.
 */
export async function buildScript(
  input: BuildInput
): Promise<{ script: ScriptFile; stats: BuildStats }> {
  const start = input.events[0];
  if (!start || start.type !== 'session_start') {
    throw new ScriptError('The event log does not begin with session_start.');
  }
  const builder = new ScriptBuilder(input, start);
  await builder.run();
  let lines = assignIds(builder.drafts);
  let speakers = builder.speakers.list();
  if (input.speakers) {
    ({ speakers, lines } = applySpeakerOverrides(speakers, lines, input.speakers));
  }
  const script = ScriptFile.parse({
    scriptSchemaVersion: SCRIPT_SCHEMA_VERSION,
    campaign: input.campaign,
    session: input.session,
    eventsSha256: input.eventsSha256,
    speakers,
    lines,
    notes: builder.notes,
  });
  const violations = invariantViolations(script, input.events);
  if (violations.length > 0) {
    throw new Error(`The script build broke its own rules (a bug):\n${violations.join('\n')}`);
  }
  return { script, stats: summarize(script, builder.counts) };
}
```

Notes for the implementer:

- `Array.prototype.findLast` is ES2023, which the tsconfig `lib` includes.
- Optional fields set to `undefined` (for example `roll.target`) are fine: zod accepts them and `JSON.stringify` drops them. If `toEqual` in a test trips on an `undefined` key, compare with `toMatchObject` or strip `undefined` in `push`; do not change the expected data.
- If `applyEvent` rejects an event sequence in a test (for example `combat_turn` before `combat_start`), fix the test log, not `applyEvent`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run packages/script`
Expected: PASS. If an expected value in `build.test.ts` is off because of a rule in an earlier task (for example word counts), recheck the rule against the spec before changing either side, and say which in the task report.

- [ ] **Step 8: Check and commit**

```bash
npx prettier --write packages/script
npm run typecheck && npm test && npm run format:check
git add packages/script
git commit -m "feat(script): build scripts from event logs and check they invent nothing

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Render `script.md`

**Files:**

- Create: `packages/script/src/markdown.ts`
- Modify: `packages/script/src/index.ts` (add `export * from './markdown';`)
- Test: `packages/script/test/markdown.test.ts`

**Interfaces:**

- Consumes: `countWords` from `@cartyx-sim/core`; `ScriptFile`, `isVoiced`, line types from `schema.ts`.
- Produces: `renderScriptMarkdown(script: ScriptFile): string` (ends with one newline).

**Format (spec §6):** a title and a short header list, then `---`; blocks separated by one blank line. A run of consecutive narration lines starts with `**DM:**` once. Dialogue is `**Name:** text` (`**DM (as Name):**` for `dmWrotePc`, ` *(interrupting)*` after the label for an overlap), followed by each dropped stage direction as ` *(text)*` (whitespace collapsed, `*` and `_` removed). Actions are `> *Name:* text`. Rolls are `> 🎲 *label:* total[ vs target][ — outcome]`, with the target never shown for attacks. Scenes are `## location`. Combat, state, and pause cues are italic lines; a hidden entity's HP shows as "is wounded", "is down", or "recovers". Notes are listed at the end.

- [ ] **Step 1: Write the failing test**

```ts
// packages/script/test/markdown.test.ts
import { describe, expect, it } from 'vitest';
import { renderScriptMarkdown } from '../src/markdown';
import type { ScriptFile } from '../src/schema';

const at = (seq: number, start: number, end: number) => [{ seq, start, end }];

const SCRIPT: ScriptFile = {
  scriptSchemaVersion: 1,
  campaign: 'avalon',
  session: 3,
  eventsSha256: 'a'.repeat(64),
  speakers: [
    { id: 'dm', name: 'Dungeon Master', kind: 'dm' },
    { id: 'kira', name: 'Kira Vale', kind: 'pc' },
    { id: 'tomas', name: 'Tomas Reed', kind: 'pc' },
    {
      id: 'npc-faceless-creature',
      name: 'Faceless creature',
      kind: 'npc',
      unlisted: true,
      firstSeq: 2,
    },
  ],
  lines: [
    {
      id: 'L0001',
      kind: 'scene',
      sources: [{ seq: 1 }],
      scene: { location: 'Eldergrove gate', artPrompt: 'Arch' },
    },
    {
      id: 'L0002',
      kind: 'narration',
      speaker: 'dm',
      text: 'The slit opens.',
      emotion: 'neutral',
      sources: at(2, 0, 15),
    },
    {
      id: 'L0003',
      kind: 'narration',
      speaker: 'dm',
      text: 'It waits.',
      emotion: 'neutral',
      sources: at(2, 17, 26),
    },
    {
      id: 'L0004',
      kind: 'dialogue',
      speaker: 'npc-faceless-creature',
      text: 'You... opened... the door.',
      emotion: 'neutral',
      sources: at(2, 30, 55),
    },
    {
      id: 'L0005',
      kind: 'narration',
      speaker: 'dm',
      text: 'it rasps.',
      emotion: 'neutral',
      sources: at(2, 57, 66),
    },
    {
      id: 'L0006',
      kind: 'dialogue',
      speaker: 'kira',
      text: 'Holding its breath.',
      emotion: 'whisper',
      sources: at(3, 1, 20),
      dropped: [
        { seq: 3, start: 22, end: 45, reason: 'stage_direction', text: 'I keep my *voice*\n low.' },
      ],
    },
    {
      id: 'L0007',
      kind: 'dialogue',
      speaker: 'tomas',
      text: 'Not now!',
      emotion: 'afraid',
      sources: at(4, 0, 8),
      overlaps: 'L0006',
    },
    {
      id: 'L0008',
      kind: 'action',
      speaker: 'tomas',
      text: 'Raise my shield.',
      emotion: 'neutral',
      sources: at(5, 0, 17),
    },
    {
      id: 'L0009',
      kind: 'roll',
      sources: [{ seq: 6 }],
      roll: {
        actor: 'tomas',
        actorName: 'Tomas Reed',
        kind: 'check',
        label: 'Tomas Reed Athletics check',
        total: 15,
        target: 12,
        outcome: 'success',
      },
    },
    {
      id: 'L0010',
      kind: 'roll',
      sources: [{ seq: 7 }],
      roll: {
        actor: 'tomas',
        actorName: 'Tomas Reed',
        kind: 'attack',
        label: 'Tomas Reed Longsword attack',
        total: 18,
        target: 13,
        outcome: 'hit',
      },
    },
    {
      id: 'L0011',
      kind: 'dialogue',
      speaker: 'dm',
      text: 'We go now.',
      emotion: 'neutral',
      sources: at(8, 12, 22),
      flags: { dmWrotePc: 'kira' },
    },
    {
      id: 'L0012',
      kind: 'combat',
      sources: [{ seq: 9 }],
      combat: {
        phase: 'start',
        order: [
          { combatantId: 'goblin-1', name: 'Goblin', total: 17 },
          { combatantId: 'kira', name: 'Kira Vale', total: 10 },
        ],
      },
    },
    {
      id: 'L0013',
      kind: 'combat',
      sources: [{ seq: 10 }],
      combat: { phase: 'turn', round: 1, combatantId: 'goblin-1', name: 'Goblin' },
    },
    {
      id: 'L0014',
      kind: 'state',
      sources: [{ seq: 11 }],
      state: { entity: 'goblin-1', name: 'Goblin', field: 'hp', before: 7, after: 3, hidden: true },
    },
    {
      id: 'L0015',
      kind: 'state',
      sources: [{ seq: 12 }],
      state: {
        entity: 'kira',
        name: 'Kira Vale',
        field: 'hp',
        before: 10,
        after: 4,
        hidden: false,
      },
    },
    {
      id: 'L0016',
      kind: 'state',
      sources: [{ seq: 13 }],
      state: {
        entity: 'kira',
        name: 'Kira Vale',
        field: 'conditions',
        before: [],
        after: ['prone'],
        hidden: false,
      },
    },
    {
      id: 'L0017',
      kind: 'state',
      sources: [{ seq: 14 }],
      state: {
        entity: 'goblin-1',
        name: 'Goblin',
        field: 'dead',
        before: false,
        after: true,
        hidden: true,
      },
    },
    { id: 'L0018', kind: 'pause', sources: [{ seq: 15 }], pause: { reason: 'Seat failed' } },
    { id: 'L0019', kind: 'combat', sources: [{ seq: 17 }], combat: { phase: 'end' } },
  ],
  notes: [{ seq: 2, text: 'Quotes attributed by rules: model reply unusable (x).' }],
};

describe('renderScriptMarkdown', () => {
  it('renders a script as a book-style read', () => {
    expect(renderScriptMarkdown(SCRIPT)).toBe(
      [
        '# avalon — Session 3',
        '',
        '- Lines: 8 spoken, 11 cues · spoken words: 22 (~0.1 min)',
        '- Unlisted NPC speakers: Faceless creature (npc-faceless-creature)',
        '- Notes: 1 (listed at the end)',
        '',
        '---',
        '',
        '## Eldergrove gate',
        '',
        '**DM:** The slit opens.',
        '',
        'It waits.',
        '',
        '**Faceless creature:** You... opened... the door.',
        '',
        '**DM:** it rasps.',
        '',
        '**Kira Vale:** Holding its breath. *(I keep my voice low.)*',
        '',
        '**Tomas Reed:** *(interrupting)* Not now!',
        '',
        '> *Tomas Reed:* Raise my shield.',
        '',
        '> 🎲 *Tomas Reed Athletics check:* 15 vs 12 — success',
        '',
        '> 🎲 *Tomas Reed Longsword attack:* 18 — hit',
        '',
        '**DM (as Kira Vale):** We go now.',
        '',
        '*Combat begins. Initiative: Goblin 17, Kira Vale 10.*',
        '',
        "*Round 1: Goblin's turn.*",
        '',
        '*Goblin is wounded.*',
        '',
        '*Kira Vale: HP 10 → 4.*',
        '',
        '*Kira Vale conditions: prone.*',
        '',
        '*Goblin dies.*',
        '',
        '---',
        '',
        '*The session paused here and resumed later.*',
        '',
        '---',
        '',
        '*Combat ends.*',
        '',
        '## Notes',
        '',
        '- Event 2: Quotes attributed by rules: model reply unusable (x).',
        '',
      ].join('\n')
    );
  });

  it('shows a downed or recovering hidden entity without numbers', () => {
    const state = (before: number, after: number) =>
      renderScriptMarkdown({
        ...SCRIPT,
        speakers: [],
        notes: [],
        lines: [
          {
            id: 'L0001',
            kind: 'state',
            sources: [{ seq: 1 }],
            state: { entity: 'g', name: 'Goblin', field: 'hp', before, after, hidden: true },
          },
        ],
      });
    expect(state(3, 0)).toContain('*Goblin is down.*');
    expect(state(0, 4)).toContain('*Goblin recovers.*');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/script/test/markdown.test.ts`
Expected: FAIL, module `../src/markdown` not found.

- [ ] **Step 3: Write `markdown.ts`**

```ts
// packages/script/src/markdown.ts
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
```

TypeScript note: inside the `switch`, `line` is a `ScriptLine` whose `kind` is not `narration`; `dialogue`/`action` narrow to `VoicedLine` only if TS can discriminate. `VoicedLine.kind` is a three-value enum, so the `case 'dialogue'` narrowing works on the union. If the compiler does not narrow, use `isVoiced(line)` guards and keep the output identical.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/script`
Expected: PASS.

- [ ] **Step 5: Check and commit**

```bash
npx prettier --write packages/script
npm run typecheck && npm test && npm run format:check
git add packages/script
git commit -m "feat(script): render scripts as book-style markdown

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The `sim script` command

**Files:**

- Modify: `apps/cli/package.json` (add `"@cartyx-sim/script": "*"` to `dependencies`, then `npm install`)
- Modify: `apps/cli/src/campaign.ts` (optional `seats.script`; `SCRIPT_SEAT`; `Campaign.scriptSeat`)
- Create: `apps/cli/src/label-cache.ts`, `apps/cli/src/script.ts`
- Modify: `apps/cli/src/main.ts` (the `script` command)
- Test: `apps/cli/test/campaign.test.ts` (new cases), `apps/cli/test/label-cache.test.ts`, `apps/cli/test/script.test.ts`

**Interfaces:**

- Consumes: `buildScript`, `renderScriptMarkdown`, `ModelLabeler`, `SpeakerOverrides`, `ScriptFile`, types `BuildStats`, `Labeler`, `LabelCache`, `Note` from `@cartyx-sim/script`; `OpenAICompatibleModelClient` from `@cartyx-sim/models`; `startFakeOpenAIServer` from `@cartyx-sim/models/testing` (tests; the handler returns `{ text }` or `{ status }`, and `fake.requests` records calls with `model`); `JsonlFileSink` (`exists`, `acquireLock` — throws "another run may be active" when a live process holds `<events>.lock` — `readAll`, `tornTail`, `releaseLock`); `sessionDir`; `loadCampaign`.
- Produces:
  - `Campaign.scriptSeat?: string` — `'script'` when `seats.script` is set, else `'checker'` when `seats.checker` is set, else absent. `campaign.models.script` is set from `seats.script` (so `sim bench` checks it too).
  - `class FileLabelCache implements LabelCache` — `constructor(dir: string)`; one `<key>.json` per key; unreadable entries are misses; keys must be 64 hex chars.
  - `ScriptOptions { campaignsDir: string; campaign: string; session: number; useModel: boolean; refresh: boolean; log?: (line: string) => void }`
  - `ScriptResult { scriptPath: string; markdownPath: string; stats: BuildStats; notes: Note[]; labelSeat?: string }`
  - `makeScript(options: ScriptOptions): Promise<ScriptResult>`
  - `formatScriptSummary(result: ScriptResult): string[]`

**Behavior:** fail with `No event log at <path>.` when the log is missing; load the campaign (only when `useModel`) and `speakers.json` before taking the session lock; hold the lock while reading and building (a running session makes this fail); log a torn final line; hash the log file with SHA-256; write `script.json` (2-space JSON plus newline) and `script.md` through a temp file and rename; release the lock in `finally`.

- [ ] **Step 1: Add the script seat to the campaign loader, test first**

Add these cases inside `describe('loadCampaign', …)` in `apps/cli/test/campaign.test.ts`, which already has `config()`, `writeCampaign(campaign, characters)`, and `character(overrides)`:

```ts
it('uses a script seat for quote labels when one is configured', async () => {
  const campaign = config();
  Object.assign(campaign.seats, {
    checker: { endpoint: 'ampere', model: 'checker-model' },
    script: { endpoint: 'studio', model: 'script-model' },
  });
  await writeCampaign(campaign, { 'kira.json': character({}) });
  const loaded = await loadCampaign(campaignsDir, 'test');
  expect(loaded.scriptSeat).toBe('script');
  expect(loaded.models.script).toMatchObject({ model: 'script-model' });
  expect(loaded.seats).not.toHaveProperty('script');
});

it('falls back to the checker seat for quote labels', async () => {
  const campaign = config();
  Object.assign(campaign.seats, { checker: { endpoint: 'ampere', model: 'checker-model' } });
  await writeCampaign(campaign, { 'kira.json': character({}) });
  expect((await loadCampaign(campaignsDir, 'test')).scriptSeat).toBe('checker');
});

it('has no quote-label seat without a script or checker seat', async () => {
  await writeCampaign(config(), { 'kira.json': character({}) });
  expect((await loadCampaign(campaignsDir, 'test')).scriptSeat).toBeUndefined();
});

it('rejects a script seat with an unknown endpoint', async () => {
  const campaign = config();
  Object.assign(campaign.seats, { script: { endpoint: 'nowhere', model: 'x' } });
  await writeCampaign(campaign, { 'kira.json': character({}) });
  await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow(
    'seats.script uses unknown endpoint "nowhere"'
  );
});
```

Run `npx vitest run apps/cli/test/campaign.test.ts` and confirm the new cases fail. Then in `apps/cli/src/campaign.ts`:

```ts
// in CampaignFile.seats, after checker:
    /** Optional: labels who speaks quotes in DM narration for `sim script`. Defaults to `checker`. */
    script: SeatRef.optional(),

// next to CHECKER_SEAT:
export const SCRIPT_SEAT = 'script';

// in interface Campaign, after seats:
  /** The seat `sim script` labels quotes with: `script`, else `checker`, else none. */
  scriptSeat?: string;

// after the checker models line in loadCampaign:
  if (file.seats.script) models[SCRIPT_SEAT] = resolve(file.seats.script, 'seats.script');
  const scriptSeat = file.seats.script
    ? SCRIPT_SEAT
    : file.seats.checker
      ? CHECKER_SEAT
      : undefined;

// in the returned object, after models:
    ...(scriptSeat ? { scriptSeat } : {}),
```

Run the campaign tests again; expected PASS.

- [ ] **Step 2: Write the label cache, test first**

```ts
// apps/cli/test/label-cache.test.ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileLabelCache } from '../src/label-cache';

const KEY = 'b'.repeat(64);

describe('FileLabelCache', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cartyx-sim-cache-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('misses, then returns what was stored, creating its folder', async () => {
    const cache = new FileLabelCache(join(dir, '.script-cache'));
    expect(await cache.get(KEY)).toBeUndefined();
    await cache.set(KEY, { labels: [{ quote: 1, speaker: 'none' }] });
    expect(await cache.get(KEY)).toEqual({ labels: [{ quote: 1, speaker: 'none' }] });
  });

  it('treats an unreadable entry as a miss', async () => {
    await mkdir(join(dir, 'c'), { recursive: true });
    await writeFile(join(dir, 'c', `${KEY}.json`), '{ not json');
    expect(await new FileLabelCache(join(dir, 'c')).get(KEY)).toBeUndefined();
  });

  it('refuses a key that is not a hex digest', async () => {
    await expect(new FileLabelCache(dir).set('../escape', {})).rejects.toThrow(
      'Invalid label cache key'
    );
  });
});
```

```ts
// apps/cli/src/label-cache.ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LabelCache } from '@cartyx-sim/script';

const KEY = /^[0-9a-f]{64}$/;

/** Model label replies, one JSON file per cache key. An unreadable entry counts as a miss. */
export class FileLabelCache implements LabelCache {
  constructor(readonly dir: string) {}

  async get(key: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.path(key), 'utf8'));
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    const path = this.path(key);
    await mkdir(this.dir, { recursive: true });
    const temp = `${path}.tmp-${process.pid}`;
    await writeFile(temp, `${JSON.stringify(value)}\n`);
    await rename(temp, path);
  }

  private path(key: string): string {
    if (!KEY.test(key)) throw new Error(`Invalid label cache key "${key}"`);
    return join(this.dir, `${key}.json`);
  }
}
```

Run `npx vitest run apps/cli/test/label-cache.test.ts`; expected PASS.

- [ ] **Step 3: Write the failing `makeScript` tests**

```ts
// apps/cli/test/script.test.ts
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, TurnRecorder } from '@cartyx-sim/core';
import { startFakeOpenAIServer, type FakeOpenAIServer } from '@cartyx-sim/models/testing';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import { ScriptFile } from '@cartyx-sim/script';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFileSink } from '../src/jsonl-sink';
import { formatScriptSummary, makeScript, type ScriptOptions } from '../src/script';

const KIRA_FILE = {
  id: 'kira',
  name: 'Kira Vale',
  kind: 'pc',
  level: 3,
  abilities: { str: 10, dex: 14, con: 12, int: 16, wis: 12, cha: 10 },
  proficiencyBonus: 2,
  ac: 15,
  maxHp: 24,
  hp: 24,
};

const LABELS = '{"labels": [{"quote": 1, "speaker": "new:faceless creature"}]}';

function sessionEvents() {
  const recorder = new TurnRecorder(
    initialState(),
    'turn-1',
    () => new Date('2026-09-16T12:00:00Z')
  );
  recorder.emit({
    type: 'session_start',
    session: 1,
    loreCommit: 'test',
    targetMinutes: 10,
    party: [makeCombatant({ id: 'kira', name: 'Kira Vale' })],
  });
  recorder.emit({
    type: 'narration',
    speaker: 'dm',
    emotion: 'neutral',
    text: 'The slit opens. *"You... opened... the door,"* it rasps.',
  });
  recorder.emit({
    type: 'dialogue',
    speaker: 'kira',
    speakerKind: 'pc',
    emotion: 'neutral',
    text: '"Not us." I back away. "Not ever."',
  });
  return [...recorder.events];
}

describe('makeScript', () => {
  let campaignsDir: string;
  let sessionPath: string;
  let fake: FakeOpenAIServer;
  let reply: () => { text?: string; status?: number };

  async function writeCampaignJson(seats: Record<string, unknown>) {
    await writeFile(
      join(campaignsDir, 'live', 'campaign.json'),
      JSON.stringify({
        name: 'Live',
        targetMinutes: 10,
        endpoints: { local: { baseURL: fake.baseURL } },
        seats: {
          dm: { endpoint: 'local', model: 'dm-model' },
          players: { kira: { endpoint: 'local', model: 'player-model' } },
          ...seats,
        },
      })
    );
  }

  function options(overrides: Partial<ScriptOptions> = {}): ScriptOptions {
    return {
      campaignsDir,
      campaign: 'live',
      session: 1,
      useModel: true,
      refresh: false,
      ...overrides,
    };
  }

  beforeEach(async () => {
    campaignsDir = await mkdtemp(join(tmpdir(), 'cartyx-sim-script-'));
    reply = () => ({ text: LABELS });
    fake = await startFakeOpenAIServer(() => reply());
    const dir = join(campaignsDir, 'live');
    await mkdir(join(dir, 'characters'), { recursive: true });
    await writeFile(join(dir, 'characters', 'kira.json'), JSON.stringify(KIRA_FILE));
    await writeCampaignJson({ checker: { endpoint: 'local', model: 'checker-model' } });
    sessionPath = join(dir, 'sessions', '001');
    await new JsonlFileSink(join(sessionPath, 'events.jsonl')).append(sessionEvents());
  });

  afterEach(async () => {
    await fake.close();
    await rm(campaignsDir, { recursive: true, force: true });
  });

  it('writes script.json and script.md, labeling quotes with the checker seat', async () => {
    const result = await makeScript(options());

    expect(result.scriptPath).toBe(join(sessionPath, 'script.json'));
    expect(result.markdownPath).toBe(join(sessionPath, 'script.md'));
    expect(result.labelSeat).toBe('checker');
    expect(result.stats.labels).toEqual({ model: 1, cache: 0, fallback: 0 });
    expect(fake.requests.map((request) => request.model)).toEqual(['checker-model']);

    const script = ScriptFile.parse(JSON.parse(await readFile(result.scriptPath, 'utf8')));
    const bytes = await readFile(join(sessionPath, 'events.jsonl'));
    expect(script.eventsSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(script.lines.map((line) => ('text' in line ? line.text : line.kind))).toEqual([
      'The slit opens.',
      'You... opened... the door.',
      'it rasps.',
      'Not us.',
      'Not ever.',
    ]);
    const book = await readFile(result.markdownPath, 'utf8');
    expect(book).toContain('**Faceless creature:** You... opened... the door.');
    expect(book).toContain('**Kira Vale:** Not us. *(I back away.)*');
    await expect(stat(join(sessionPath, 'events.jsonl.lock'))).rejects.toThrow();
  });

  it('answers from the cache on a second run, and asks again with refresh', async () => {
    await makeScript(options());
    const cached = await makeScript(options());
    expect(cached.stats.labels).toEqual({ model: 0, cache: 1, fallback: 0 });
    expect(fake.requests).toHaveLength(1);
    const refreshed = await makeScript(options({ refresh: true }));
    expect(refreshed.stats.labels.model).toBe(1);
    expect(fake.requests).toHaveLength(2);
  });

  it('prefers a script seat over the checker', async () => {
    await writeCampaignJson({
      checker: { endpoint: 'local', model: 'checker-model' },
      script: { endpoint: 'local', model: 'script-model' },
    });
    const result = await makeScript(options());
    expect(result.labelSeat).toBe('script');
    expect(fake.requests.map((request) => request.model)).toEqual(['script-model']);
  });

  it('uses rules only without the model, and never reads the campaign', async () => {
    await rm(join(campaignsDir, 'live', 'campaign.json'));
    const result = await makeScript(options({ useModel: false }));
    expect(result.stats.labels).toEqual({ model: 0, cache: 0, fallback: 1 });
    expect(result.labelSeat).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  it('says so when the campaign has no seat to label with', async () => {
    await writeCampaignJson({});
    const lines: string[] = [];
    const result = await makeScript(options({ log: (line) => lines.push(line) }));
    expect(lines).toContain(
      'No script or checker seat in campaign.json; attributing quotes by rules only.'
    );
    expect(result.stats.labels.fallback).toBe(1);
  });

  it('falls back to rules with a note when the seat fails', async () => {
    reply = () => ({ status: 500 });
    const result = await makeScript(options());
    expect(result.stats.labels.fallback).toBe(1);
    expect(result.notes).toEqual([
      {
        seq: 1,
        text: expect.stringMatching(/^Quotes attributed by rules: script seat unavailable/),
      },
    ]);
  });

  it('applies speakers.json and reports a bad one with its path', async () => {
    const path = join(sessionPath, 'speakers.json');
    await writeFile(
      path,
      JSON.stringify({ 'npc-faceless-creature': { name: 'The Faceless One' } })
    );
    const result = await makeScript(options());
    const script = ScriptFile.parse(JSON.parse(await readFile(result.scriptPath, 'utf8')));
    expect(script.speakers.at(-1)?.name).toBe('The Faceless One');

    await writeFile(path, '{ nope');
    await expect(makeScript(options())).rejects.toThrow(`${path}: invalid JSON`);
    await writeFile(path, JSON.stringify({ 'npc-x': { voice: 'deep' } }));
    await expect(makeScript(options())).rejects.toThrow(`${path}: invalid speaker overrides`);
    await writeFile(path, JSON.stringify({ 'npc-ghost': { name: 'Ghost' } }));
    await expect(makeScript(options())).rejects.toThrow('speakers.json: "npc-ghost"');
  });

  it('refuses a missing session, a held lock, and an unknown log version', async () => {
    await expect(makeScript(options({ session: 2 }))).rejects.toThrow('No event log at');

    const lock = join(sessionPath, 'events.jsonl.lock');
    await writeFile(lock, `${process.pid} now\n`);
    await expect(makeScript(options())).rejects.toThrow('another run may be active');
    await rm(lock);

    const events = join(sessionPath, 'events.jsonl');
    const lines = (await readFile(events, 'utf8')).split('\n');
    lines[0] = lines[0]!.replace('"schemaVersion":1', '"schemaVersion":2');
    await writeFile(events, lines.join('\n'));
    await expect(makeScript(options())).rejects.toThrow('invalid event');
  });

  it('formats a summary', async () => {
    const result = await makeScript(options());
    expect(formatScriptSummary(result)).toEqual([
      'Lines: narration 2, dialogue 3',
      'Spoken words: 13 (~0.1 min)',
      'Quote labels: model 1, cache 0, rules 0 (seat "checker")',
      'Stage directions dropped: 1',
      'Unlisted NPC speakers: npc-faceless-creature',
      `Script: ${result.scriptPath}`,
      `Book: ${result.markdownPath}`,
    ]);
  });
});
```

Word count for the summary: "The slit opens." 3 + "You... opened... the door." 4 + "it rasps." 2 + "Not us." 2 + "Not ever." 2 = 13. The `Lines:` order follows first appearance: narration, dialogue.

Run: `npx vitest run apps/cli/test/script.test.ts`
Expected: FAIL, module `../src/script` not found.

- [ ] **Step 4: Write `script.ts`**

```ts
// apps/cli/src/script.ts
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenAICompatibleModelClient } from '@cartyx-sim/models';
import {
  buildScript,
  ModelLabeler,
  renderScriptMarkdown,
  SpeakerOverrides,
  type BuildStats,
  type Labeler,
  type Note,
} from '@cartyx-sim/script';
import { z } from 'zod';
import { loadCampaign } from './campaign';
import { JsonlFileSink } from './jsonl-sink';
import { FileLabelCache } from './label-cache';
import { sessionDir } from './paths';

const WORDS_PER_MINUTE = 150;

export interface ScriptOptions {
  campaignsDir: string;
  campaign: string;
  session: number;
  /** Label quotes in narration with the campaign's script (or checker) seat. */
  useModel: boolean;
  /** Ignore cached model answers. */
  refresh: boolean;
  log?: (line: string) => void;
}

export interface ScriptResult {
  scriptPath: string;
  markdownPath: string;
  stats: BuildStats;
  notes: Note[];
  /** The seat that labeled quotes, when one was used. */
  labelSeat?: string;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function loadSpeakerOverrides(path: string): Promise<SpeakerOverrides | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : error})`);
  }
  const parsed = SpeakerOverrides.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${path}: invalid speaker overrides\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

async function campaignLabeler(
  options: ScriptOptions,
  dir: string,
  log: (line: string) => void
): Promise<{ labeler?: Labeler; seat?: string }> {
  const campaign = await loadCampaign(options.campaignsDir, options.campaign);
  const seat = campaign.scriptSeat;
  if (!seat) {
    log('No script or checker seat in campaign.json; attributing quotes by rules only.');
    return {};
  }
  const labeler = new ModelLabeler({
    model: new OpenAICompatibleModelClient(campaign.models),
    seat,
    modelId: campaign.models[seat]!.model,
    cache: new FileLabelCache(join(dir, '.script-cache')),
    refresh: options.refresh,
  });
  return { labeler, seat };
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, content);
  await rename(temp, path);
}

/**
 * Builds `script.json` and `script.md` for one session from its event log, which it never
 * modifies. Holds the session lock while it reads and builds, so it cannot run against a session
 * that is still being played.
 */
export async function makeScript(options: ScriptOptions): Promise<ScriptResult> {
  const log = options.log ?? (() => {});
  const dir = sessionDir(options.campaignsDir, options.campaign, options.session);
  const eventsPath = join(dir, 'events.jsonl');
  const sink = new JsonlFileSink(eventsPath);
  if (!(await sink.exists())) throw new Error(`No event log at ${eventsPath}.`);
  // Load everything that can fail on configuration before taking the lock.
  const labeling: { labeler?: Labeler; seat?: string } = options.useModel
    ? await campaignLabeler(options, dir, log)
    : {};
  const speakers = await loadSpeakerOverrides(join(dir, 'speakers.json'));

  const stalePid = await sink.acquireLock();
  if (stalePid !== undefined) {
    log(
      `Replaced a stale lock from process ${stalePid}, which is no longer running: ${eventsPath}.lock`
    );
  }
  try {
    const events = await sink.readAll();
    if (sink.tornTail) {
      log(
        `Ignoring an incomplete final line (line ${sink.tornTail.line}) left by an interrupted ` +
          `write: ${eventsPath}`
      );
    }
    const eventsSha256 = createHash('sha256')
      .update(await readFile(eventsPath))
      .digest('hex');
    const { script, stats } = await buildScript({
      campaign: options.campaign,
      session: options.session,
      eventsSha256,
      events,
      labeler: labeling.labeler,
      speakers,
    });
    const scriptPath = join(dir, 'script.json');
    const markdownPath = join(dir, 'script.md');
    await writeAtomic(scriptPath, `${JSON.stringify(script, null, 2)}\n`);
    await writeAtomic(markdownPath, renderScriptMarkdown(script));
    return {
      scriptPath,
      markdownPath,
      stats,
      notes: script.notes,
      ...(labeling.seat ? { labelSeat: labeling.seat } : {}),
    };
  } finally {
    await sink.releaseLock();
  }
}

export function formatScriptSummary(result: ScriptResult): string[] {
  const { stats } = result;
  const kinds = Object.entries(stats.lines)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(', ');
  const minutes = (stats.spokenWords / WORDS_PER_MINUTE).toFixed(1);
  const seat = result.labelSeat ? ` (seat "${result.labelSeat}")` : '';
  const lines = [
    `Lines: ${kinds || 'none'}`,
    `Spoken words: ${stats.spokenWords} (~${minutes} min)`,
    `Quote labels: model ${stats.labels.model}, cache ${stats.labels.cache}, rules ${stats.labels.fallback}${seat}`,
    `Stage directions dropped: ${stats.stageDirections}`,
    `Unlisted NPC speakers: ${stats.unlisted.join(', ') || 'none'}`,
  ];
  for (const note of result.notes) lines.push(`Note (event ${note.seq}): ${note.text}`);
  lines.push(`Script: ${result.scriptPath}`, `Book: ${result.markdownPath}`);
  return lines;
}
```

- [ ] **Step 5: Add the command to `main.ts`**

```ts
// with the other imports
import { formatScriptSummary, makeScript } from './script';

// with the other option interfaces
interface ScriptCommandOptions {
  campaign: string;
  session: number;
  /** False with --no-model. */
  model: boolean;
  refresh: boolean;
  campaignsDir: string;
}

// after the bench command, before parseAsync
program
  .command('script')
  .description(
    'Turn a session event log into script.json (for voicing) and script.md (for reading)'
  )
  .requiredOption('--campaign <id>', 'campaign id (a folder under the campaigns directory)')
  .option('--session <n>', 'session number', parseNumber('integer'), 1)
  .option('--no-model', 'attribute quotes in DM narration by rules only')
  .option('--refresh', 'ignore cached model answers', false)
  .option('--campaigns-dir <path>', 'campaigns directory', 'campaigns')
  .action(async (options: ScriptCommandOptions) => {
    const result = await makeScript({
      campaignsDir: options.campaignsDir,
      campaign: options.campaign,
      session: options.session,
      useModel: options.model,
      refresh: options.refresh,
      log: (line) => console.log(line),
    });
    for (const line of formatScriptSummary(result)) console.log(line);
  });
```

- [ ] **Step 6: Run the tests and a smoke check**

Run: `npx vitest run apps/cli`
Expected: PASS.

Smoke check against a fixture session (no models needed):

```bash
TMP=$(mktemp -d)
npm run sim -- run --fixture apps/cli/fixtures/demo-session.json --campaign smoke --campaigns-dir "$TMP" --seed 1
npm run sim -- script --campaign smoke --no-model --campaigns-dir "$TMP"
head -20 "$TMP/smoke/sessions/001/script.md"
rm -rf "$TMP"
```

Expected: the summary prints and `script.md` starts with `# smoke — Session 1`.

- [ ] **Step 7: Check and commit**

```bash
npx prettier --write apps/cli
npm run typecheck && npm test && npm run format:check
git add apps/cli package-lock.json
git commit -m "feat(cli): add sim script to write script.json and script.md for a session

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Document `sim script`

**Files:**

- Modify: `docs/running-a-session.md` (new §8 at the end)
- Modify: `docs/status.md` (What works today; Where things stand; Next steps)
- Modify: `docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md` (Deviations)
- Modify: `apps/cli/examples/local-campaign/README.md` only if it lists commands (add one line for `sim script`)

- [ ] **Step 1: Add §8 to `docs/running-a-session.md`**

Append (keep the file's existing heading style and numbering):

````markdown
## 8. Make a script

`sim script` turns a finished session's event log into two files next to it:

- `script.json`: every spoken line in order, with its speaker, cleaned for text-to-speech, plus silent cues for rolls, scenes, combat, and HP or condition changes. This is what the voice and playback stages read.
- `script.md`: the same session as a readable script.

```bash
npm run sim -- script --campaign avalon --session 3
```

The event log is never changed, and the script never adds words: it only drops, splits, and attributes text from the log.

- **Player lines:** a stage direction between quotes (`"…" I keep my voice low. "…"`) is dropped from the spoken line and shown as an aside in `script.md`. Stray quote marks and markdown are removed. Slips such as "Kira's — I mean, my — take" stay as spoken.
- **Actions** are spoken in the player's voice.
- **DM narration:** `DM:` prefixes, hand-off lines, and markdown are removed, and each paragraph (and each heading or list item) becomes its own line.
- **NPC speech inside narration** becomes its own line. A model decides who speaks each quote: a known NPC, a new NPC (given an id like `npc-faceless-creature` and listed as unlisted), a player character, or no one (a sign, a name, a single word). The model only returns these labels, never text. A quote the DM wrote for a player character stays in the DM's voice and is marked `DM (as Kira Vale)`.

The labeling seat is `seats.script` in `campaign.json` when present, otherwise `seats.checker`; with neither, or with `--no-model`, rules decide: a quote of fewer than three words is not speech, and any other goes to the only NPC introduced in the current scene, or to `npc-unnamed`. A failed or unusable model reply is retried once, then rules decide for that narration and a note says why. `sim bench` checks a `script` seat like any other.

```json
"script": {
  "endpoint": "ampere",
  "model": "glm-4.7-flash:latest",
  "temperature": 0.2,
  "maxOutputTokens": 4000,
  "timeoutMs": 300000
}
```

Model answers are cached in `sessions/NNN/.script-cache/`, so re-running is free and gives the same result. `--refresh` asks the model again.

To rename or merge speakers, add `sessions/NNN/speakers.json` and re-run:

```json
{
  "npc-faceless-creature": { "name": "The Faceless One" },
  "npc-thing": { "id": "npc-faceless-creature" }
}
```

`name` renames a speaker; `id` merges one NPC into another. Unknown speakers and merges into a player character or the DM are errors.

`sim script` refuses to run while the session is being played (it takes the same lock as `sim run`) and prints a summary: lines by kind, spoken words, how quotes were labeled, dropped stage directions, unlisted speakers, and notes.
````

- [ ] **Step 2: Update `docs/status.md`**

- Set `_Last updated:_` to today's date.
- Under "What works today", add a bullet: `**\`sim script --campaign <id> --session <n>\`**: turns an event log into \`script.json\` (speaker-attributed, TTS-ready lines and cues) and \`script.md\` (a readable script); see \`docs/running-a-session.md\` §8.`
- In "Next steps", replace item 1 (build the post-processing stage) with the manual-run findings from Task 11 once they exist, and make "Test a 1-hour session" item 1.
- Update the test count line (`npm test` output) under "Checks".

- [ ] **Step 3: Update the roadmap deviations**

Append to "Deviations from the spec" in `docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md`:

```markdown
- **A script stage sits between the event log and media** (design `../specs/2026-09-16-session-script-design.md`). `sim script` writes `script.json` and `script.md`; Plan 3 reads `script.json` rather than raw events, and `timeline.json` references script line ids. NPC speech the DM embedded in narration becomes its own lines there, attributed by an optional `seats.script` model seat (default: `checker`). (Post-2A)
```

- [ ] **Step 4: Check and commit**

```bash
npx prettier --write docs apps/cli/examples
npm run format:check
git add docs apps/cli/examples
git commit -m "docs: explain sim script and record the script stage in the roadmap

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Run it on the real sessions (controller, not a subagent)

This needs the LAN model servers, so the controller runs it with the Bash sandbox disabled. It changes no code unless it finds a bug; a bug found here gets its own failing test and fix, reviewed with any other fixes from this task in one batch.

- [ ] **Step 1: Check the checker seat is up**

```bash
npm run sim -- bench --campaign avalon --trials 1
```

Only the `checker` seat matters here; note any other seat that is down, but do not act on it.

- [ ] **Step 2: Script the sessions**

```bash
for s in 2 3 4; do npm run sim -- script --campaign avalon --session $s; done
npm run sim -- script --campaign avalon-nochecker --session 1
npm run sim -- script --campaign avalon --session 3 --no-model
```

Expected: each prints a summary with no error. The last one shows rules-only labels for comparison (it overwrites 003's files; re-run 003 with the model afterwards, which answers from the cache).

- [ ] **Step 3: Read the output**

For each session, read `script.md` in full and spot-check `script.json`. Record:

- stage directions dropped from player lines, and any spoken text wrongly dropped or any direction left in;
- each embedded NPC quote: was the speaker right, and were scare quotes left in the narration;
- DM-written PC dialogue in the checker-off session: flagged as `DM (as …)`;
- leftover markdown, `DM:` prefixes, or hand-off lines;
- notes (fallbacks) and their reasons;
- the unlisted speakers, and whether any should be merged with `speakers.json`.

- [ ] **Step 4: Record the findings**

Add a "Script stage on real sessions (<date>)" section to `docs/status.md` with the counts from the summaries and the findings above, then commit:

```bash
npx prettier --write docs/status.md
npm run format:check
git add docs/status.md
git commit -m "docs: record the script stage's results on the avalon sessions

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: §1.1 → Global Constraints and `invariantViolations` (Task 7); §3 → Tasks 2–9; §4.1 → `normalize.ts` (Task 2, spec updated there); §4.2 → `schema.ts` (Task 2), build (Task 7); §4.3 → `speakers.ts` (Task 6), loading (Task 9); §5.1 → Task 3; §5.2 → Task 4; §5.3 → Tasks 5 and 7, seat and cache in Task 9; §5.4–5.5 → Task 7; §5.6 → Task 7; §6 → Task 8; §7 → Task 9; §8 → tests in every task plus Task 11; §9 → Task 10.
- Names used across tasks: `Mask`, `finishLine`, `sliceText`, `hasWords`, `pairQuotes`, `removeQuotes`, `removeEmphasis`, `removeMarkdown`, `sourceLines`, `BULLET` (Task 2); `splitSpeech`, `cleanAction` (Task 3); `segmentNarration`, `narrationPieces`, `QuoteLabel` (Task 4); `Labeler`, `LabelRequest`, `SpanLabel`, `LabelResult`, `ModelLabeler`, `LabelCache`, `fallbackLabels` (Task 5); `SpeakerTable`, `applySpeakerOverrides` (Task 6); `buildScript`, `BuildStats`, `invariantViolations` (Task 7); `renderScriptMarkdown` (Task 8); `makeScript`, `formatScriptSummary`, `FileLabelCache`, `Campaign.scriptSeat` (Task 9).
