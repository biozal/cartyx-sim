# Script stage fixes before the 1-hour run: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the ten script-stage issues left open by the last reviews (see `docs/status.md`, "Open backlog"), so the 1-hour run's script is trustworthy.

**Architecture:** Changes stay inside the existing units: `packages/script` (pure logic), `packages/core` (one shared HP helper and an optional `ModelResponse.model`), `packages/models` (reports the answering model), and `apps/cli` (script command I/O and error printing). There are no new packages and no script schema change.

**Tech Stack:** TypeScript (ESM), zod, vitest, Prettier, commander.

**Spec:** `docs/superpowers/specs/2026-09-16-session-script-design.md` (§5.1 is amended by Task 2).

## Global Constraints

- Every commit passes `npm run typecheck`, `npm test`, and `npm run format:check`. Run `npx prettier --write <files>` before committing.
- Rule §1.1 of the spec: the script never rewrites, paraphrases, or adds spoken words. It only drops, splits, and attributes.
- `SCRIPT_SCHEMA_VERSION` stays 1. `LABEL_PROMPT_VERSION` goes from 2 to 3 (Task 1).
- `packages/script` and `packages/core` use no Node APIs.
- Config and data files are JSON, never YAML.
- Commit messages follow the repo style (`fix(script): …`) and end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Do not push.

---

### Task 1: Labeling prompt and cache key (items 1 and 7)

**Files:**

- Modify: `packages/script/src/attribution.ts`
- Modify: `packages/core/src/model.ts` (the `ModelResponse` schema)
- Modify: `packages/models/src/client.ts` (the `complete` return)
- Test: `packages/script/test/attribution.test.ts`, `packages/models/test/client.test.ts` (whichever file tests `OpenAICompatibleModelClient` fallbacks; find it with `grep -l fallbacks packages/models/test`)

**Interfaces:**

- Produces: `ModelResponse` gains `model?: string`, the id of the model that produced the reply. `OpenAICompatibleModelClient.complete` sets it to `target.model`.
- Produces: `LABEL_PROMPT_VERSION = 3`.

- [ ] **Step 1: Write the failing tests**

In `attribution.test.ts`:

```ts
it('tells the model that a quote inside reported speech is not speech', () => {
  const [system] = buildLabelMessages(REQUEST); // use the file's existing request fixture
  expect(system!.content).toMatch(/reported speech/i);
  expect(LABEL_PROMPT_VERSION).toBe(3);
});

it('caches a fallback model reply under that model, not the primary', async () => {
  const cache = new MemoryCache(); // the file's existing in-memory LabelCache, or a Map-backed one
  const model = {
    complete: async () => ({ text: VALID_REPLY, toolCalls: [], model: 'fallback-model' }),
  };
  const labeler = new ModelLabeler({ model, seat: 'script', modelId: 'primary-model', cache });
  await labeler.label(REQUEST);
  expect(await cache.get(await labelCacheKey('fallback-model', REQUEST))).toBeDefined();
  expect(await cache.get(await labelCacheKey('primary-model', REQUEST))).toBeUndefined();
});
```

In the models client test, add a check to the existing fallback test (the primary fails and the fallback answers) that `response.model` equals the fallback's model id, and to a primary-success test that it equals the primary's id.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run packages/script/test/attribution.test.ts packages/models/test`
Expected: the new assertions fail.

- [ ] **Step 3: Implement**

`packages/core/src/model.ts`:

```ts
export const ModelResponse = z.object({
  text: z.string().default(''),
  toolCalls: z.array(ToolCall).default([]),
  /** The model that produced this reply (a fallback's id when the primary failed), when known. */
  model: z.string().optional(),
});
```

`packages/models/src/client.ts`, in `generate`:

```ts
return {
  response: { text: result.text, toolCalls: toToolCalls(result.toolCalls), model: target.model },
  finishReason: result.finishReason,
};
```

`packages/script/src/attribution.ts`:

- Set `LABEL_PROMPT_VERSION = 3`.
- Add this rule to `SYSTEM_PROMPT`, right after the `"none"` line:
  `'- "none" also for words the narration only reports, such as "mutters something about "bad luck"" or "says that "the gate is shut"": reported speech is part of the narration, not a line of dialogue.',`
- In `ModelLabeler.label`, keep `response` rather than just `text`. On success, cache under the key of the model that answered:

```ts
const answeredBy = response.model ?? modelId;
const writeKey = answeredBy === modelId ? key : await labelCacheKey(answeredBy, request);
try {
  await cache?.set(writeKey, parsed.reply);
} catch {
  // Ignored; see above.
}
```

Update the `labelCacheKey` and `ModelLabelerOptions.modelId` doc comments to say that lookups use the primary model's key and writes use the key of the model that answered, so a fallback's reply is never served as the primary's.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run packages/script packages/models packages/core`
Expected: PASS. If a cache hit test depended on version 2 keys, recompute its keys; don't hard-code them.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/model.ts packages/models packages/script
git commit -m "fix(script): label reported speech as none; key cached labels by the answering model"
```

---

### Task 2: Narrow direction rule for PC speech (item 2)

**Files:**

- Modify: `packages/script/src/speech.ts`
- Modify: `packages/script/src/build.ts` (`addSpeech` passes the speaker's names)
- Modify: `docs/superpowers/specs/2026-09-16-session-script-design.md` §5.1
- Test: `packages/script/test/speech.test.ts`

**Interfaces:**

- Produces: `splitSpeech(raw: string, names: readonly string[] = []): SpeechSplit`. `names` holds the speaker's own names (full name and first name), which count as a speech-tag subject like `I`/`she`.

**Rule.** Split when today's rule holds (unchanged), **or** when all of these hold:

1. there is at least one quote span and every span is closed;
2. every quote span is a sentence: its first kept letter is uppercase, and its last kept non-space character is one of `. , ! ? … — –`;
3. the text outside the quotes has words, and every outside gap with words is a direction. A gap is split into sentences at `[.!?…]` followed by whitespace, and **every** sentence (its kept text, emphasis removed, trimmed) must match one of:
   - `TAG`: `^(?:I|he|she|they|<names>)\s+(?:\w+ly\s+)?(?:say|says|said|add|adds|added|reply|replies|replied|mutter|mutters|muttered|murmur|murmurs|murmured|whisper|whispers|whispered|call|calls|called|ask|asks|asked|answer|answers|answered|hiss|hisses|hissed|snap|snaps|snapped|shout|shouts|shouted|continue|continues|continued|grumble|grumbles|grumbled)\b`, case-insensitive. The rest of the sentence may be anything, e.g. `I say, drawing my blade and stepping between them.`
   - `ACTION`: `^I\s+(?:\w+ly\s+)?(?:nod|shrug|glance|step|draw|lean|turn|look|grin|smile|sigh|frown|raise|lower|gesture|point|tap|cross|narrow|crouch|kneel|straighten|wince|exhale|swallow)\b`, case-insensitive on the verb only (`I` must be uppercase).

   Build the `<names>` alternation with core's `escapeRegExp`. Verbs such as `keep`, `let`, `hold`, `think`, and `mean` are deliberately left out, because they start real speech ("I let him go once.", "I think we wait.").

When the split happens, the output is built exactly as today: each quoted span with words is a line, and each trimmed outside gap with words is a dropped `stage_direction`.

- [ ] **Step 1: Write the failing tests** (add to `speech.test.ts`, using its `spoken` helper; pass names where the test needs them)

```ts
describe('splitSpeech direction rule', () => {
  it('drops a leading first-person action', () => {
    expect(spoken('I nod slowly. "Let\'s go, then."')).toEqual({
      lines: ["Let's go, then."],
      directions: ['I nod slowly.'],
    });
  });

  it('drops a short trailing speech tag', () => {
    expect(spoken('"Hello," she says.')).toEqual({
      lines: ['Hello.'],
      directions: ['she says.'],
    });
  });

  it('drops a long speech tag between two quotes', () => {
    expect(
      spoken('"Stay back," I say, drawing my blade and stepping between them. "Now."')
    ).toEqual({
      lines: ['Stay back.', 'Now.'],
      directions: ['I say, drawing my blade and stepping between them.'],
    });
  });

  it("accepts the speaker's own name as a tag subject", () => {
    const raw = '"Wait." Kira whispers it, barely moving.';
    const split = splitSpeech(raw, ['Kira Vale', 'Kira']);
    expect(split.directions.map((r) => raw.slice(r.start, r.end))).toEqual([
      'Kira whispers it, barely moving.',
    ]);
  });

  it.each([
    'Aye, the "old road" is safer.',
    'I think "Stay back" is wise.',
    '"Never." Well, I don\'t.',
    '"Go." I let him go once.',
    'I nod. "Fine." We should move before dark.',
    'I nod slowly. "Stay back," I say. "Now',
  ])('keeps %j whole', (raw) => {
    expect(spoken(raw).directions).toEqual([]);
    expect(spoken(raw).lines).toHaveLength(1);
  });
});
```

The last `it.each` case has an unclosed quote and does not open with one, so neither path applies. The existing tests in the file must still pass unchanged.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run packages/script/test/speech.test.ts`
Expected: the three split cases and the name case fail; the keep-whole cases pass.

- [ ] **Step 3: Implement**

In `speech.ts`, add `isSentenceQuote(mask, span)`, `isDirection(text, names)`, and `directionSplit(mask, spans, outside, names)`. Compute `split = currentRule || directionSplit(...)`, using the masked kept text of each range (`mask.keptText`). Update the `splitSpeech` doc comment to describe both paths.

In `build.ts` `addSpeech`, pass names for PCs only:

```ts
const pcName =
  event.speakerKind === 'pc' ? ownEntry(this.state.combatants, event.speaker)?.name : undefined;
const names = pcName ? [pcName, pcName.split(/\s+/)[0]!] : [];
const split = splitSpeech(event.text, names);
```

- [ ] **Step 4: Update spec §5.1.** Replace the first bullet and the "Known cost" bullet with the two paths above. Keep the "never drops speech" principle, list the excluded verbs and why, and keep one sentence on the remaining cost: a direction that matches neither pattern is still voiced whole. Update "**Status:**" to note the amendment date (2026-09-16).

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run packages/script`
Expected: PASS, including the invariant tests.

- [ ] **Step 6: Commit**

```bash
git add packages/script docs/superpowers/specs/2026-09-16-session-script-design.md
git commit -m "fix(script): drop speech tags and first-person actions around quoted PC speech"
```

---

### Task 3: Build and markdown fixes (items 3, 4, 5, 6)

**Files:**

- Modify: `packages/script/src/speakers.ts`, `packages/script/src/build.ts`, `packages/script/src/markdown.ts`, `packages/script/src/invariants.ts`
- Modify: `packages/core/src/transcript.ts` (shared HP helper)
- Test: `packages/script/test/{speakers,build,markdown,invariants}.test.ts`, `packages/core/test/transcript.test.ts`

**Interfaces:**

- Produces: `SpeakerTable.promote(id: string, name: string): void`. If `id` is an unlisted speaker, it becomes a listed NPC with `name`, keeping its position in the table (no `unlisted`, no `firstSeq`). Otherwise it does nothing.
- Produces (core): `export type HpTrend = 'down' | 'wounded' | 'recovers' | 'unchanged' | 'unknown'` and `export function hpTrend(before: unknown, after: unknown): HpTrend`. `unknown` means either value is not a finite number; otherwise `after <= 0` is `down`, a drop is `wounded`, a rise is `recovers`, and equal values are `unchanged`.

**Item 3 (promote).** The engine names an introduced NPC `npc-<slugify(name)>`, and a `new:<label>` speaker is `npc-<slugify(label)>`, so an NPC the model named before its introduction has the same id. In `ScriptBuilder.run`, on `npc_introduced`, call `this.speakers.promote(event.npcId, event.name)` and remove the matching label from `this.newLabels` (the label whose `npc-${slugify(label)}` equals the id), so later requests list the NPC by id. Implement `promote` by rebuilding the map in the same order, with the replaced entry.

Test in `build.test.ts`: narration `'"Open the gate," a voice says.'` labeled `new:the warden` by a `FakeLabeler`, then `npc_introduced` (`npc-the-warden`, `The Warden`), then narration `'"Now," the Warden says.'` labeled `npc-the-warden`. Expect exactly one speaker `npc-the-warden` with name `The Warden`, no `unlisted` or `firstSeq`, both dialogue lines on it, and the second request's `newLabels` not containing `the warden`. Test in `speakers.test.ts`: `promote` on an unlisted id, on a listed id (no change), and on an unknown id (no change).

**Item 4 (HP).** In core, replace `describeHpChange`'s comparison with `hpTrend`: `down` → `is down`, `wounded` → `is wounded`, `recovers` → `recovers`, `unchanged` → `is unchanged`, `unknown` → `changes condition`. Fix the `to === 0` bug (a negative value is also down). In `markdown.ts` `stateChange`, for hidden entities: `unchanged` returns `null` (no block; `renderScriptMarkdown` skips null), `unknown` gives `*Name's condition changes.*`, and the others read as today. For visible entities keep the numbers. Tests:

- core: `hpTrend(5, 5)` is `unchanged`, `hpTrend(3, -2)` is `down`, `hpTrend('x', 3)` is `unknown`, and the player transcript line for an equal change reads `is unchanged`;
- markdown: a hidden 4 → 4 change adds no line, and a hidden `'?'` → 3 change reads `*Goblin's condition changes.*`.

**Item 5 (pauses).** In `run()`, replace `pause` with `pauses: {seq, reason}[]`. On `session_paused` push to it. Before the next non-pause event, push one `pause` line per entry, in order, then clear. Test: two consecutive pauses then a narration give two pause lines with their own seqs and reasons, followed by the narration.

**Item 6 (invariants).** In `invariantViolations`:

- a voiced line whose source event is not `public` → `${line.id}: source ${seq} is not a public event`;
- for every dropped span (on lines and notes), the span must lie inside its event's source text (`0 <= start <= end <= length`), and `text` must equal `source.slice(start, end)`; otherwise `${where}: dropped span ${seq}:${start}-${end} does not match its source`, where `where` is the line id or `note ${seq}`;
- check spans before calling `cover`, and never cover an invalid span.

Tests in `invariants.test.ts`: mutate a built script (set a dropped span's `text` to `'x'`; set its `end` past the text length; point a line's source at a DM-only event added to the log) and expect each message.

- [ ] **Step 1: Write the failing tests above**
- [ ] **Step 2: Run** `npx vitest run packages/script packages/core`. Expected: the new tests fail.
- [ ] **Step 3: Implement the four fixes**
- [ ] **Step 4: Run** `npx vitest run packages/script packages/core`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/script packages/core
git commit -m "fix(script): promote introduced NPCs, keep every pause, compare HP safely, check dropped spans"
```

---

### Task 4: CLI fixes and docs (items 8, 9, 10)

**Files:**

- Modify: `apps/cli/src/script.ts`, `apps/cli/src/jsonl-sink.ts`, `apps/cli/src/main.ts`, `apps/cli/src/atomic-write.ts`
- Modify: `packages/script/src/markdown.ts` (the events hash in the header)
- Create: `apps/cli/src/command-errors.ts`
- Modify: `docs/running-a-session.md` §8, `docs/status.md`
- Test: `apps/cli/test/script.test.ts`, `apps/cli/test/jsonl-sink.test.ts`, `apps/cli/test/atomic-write.test.ts`, new `apps/cli/test/command-errors.test.ts`, `packages/script/test/markdown.test.ts`

**Interfaces:**

- Produces: `JsonlFileSink.readAll()` also sets `lastReadSha256: string | undefined`, the SHA-256 hex digest of the exact bytes it parsed (`undefined` when the file is missing). The injectable `readFile` becomes `(path: string) => Promise<Buffer>`; decode with `buffer.toString('utf8')`. Update test fakes to match.
- Produces: `writeFilesAtomic(files: { path: string; content: string }[], fs?)`. It writes every temp file first, then renames them in the given order. On any failure it removes every temp file that has not been renamed yet (ignoring cleanup errors) and rethrows. `writeFileAtomic(path, content, fs)` becomes a call to it with one file.
- Produces: `formatCommandError(error: unknown, debug: boolean): string`. Without debug it is the message only (`String(error)` for a non-Error); with debug it is the stack when present.
- Produces: the `script.md` header gains the line `` - Events: `<first 12 hex chars of eventsSha256>` ``.

**Item 8.** In `makeScript`, when `options.refresh` is set and no labeler is used (either `--no-model`, or no seat), log `--refresh has no effect: no model labels quotes in this run.` Test both cases with the `log` option.

**Item 9.** In `makeScript`, replace the separate `readFile` + `readAll` with `events = await sink.readAll(); eventsSha256 = sink.lastReadSha256!`. Write both outputs with `writeFilesAtomic([{ path: markdownPath, … }, { path: scriptPath, … }])`, so `script.json` is renamed last. Tests:

- jsonl-sink: `lastReadSha256` equals `createHash('sha256')` of the file bytes, including a log with a torn tail;
- atomic-write: a failure on the second rename leaves the first file written, the second untouched, and no temp files;
- script: the existing `eventsSha256` assertion still holds.

**Item 10.** In `main.ts`, wrap each of the three `.action` bodies:

```ts
function action<T>(body: (options: T) => Promise<void>) {
  return async (options: T) => {
    try {
      await body(options);
    } catch (error) {
      console.error(formatCommandError(error, process.env.SIM_DEBUG === '1'));
      process.exitCode = 1;
    }
  };
}
```

Remove the script command's own try/catch. Unit-test `formatCommandError` for both modes and for a non-Error value.

**Docs.**

- `docs/running-a-session.md` §8: the `--refresh` warning, the events hash in `script.md`, and `SIM_DEBUG=1` (also mention it once where `sim run` errors are described).
- `docs/status.md`:
  - update the test count;
  - remove the reported-speech line from "Open backlog";
  - under "Script stage on real sessions", add a short "Fixes after review" list for items 1–10;
  - update "Checks on `feat/dm-pc-control-checker`".

- [ ] **Step 1: Write the failing tests above**
- [ ] **Step 2: Run** `npx vitest run apps/cli packages/script`. Expected: the new tests fail.
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run format:check`. Expected: all pass.
- [ ] **Step 5: Commit**

```bash
git add apps/cli packages/script docs
git commit -m "fix(cli): read the log once, write script files as a pair, print clean command errors"
```
