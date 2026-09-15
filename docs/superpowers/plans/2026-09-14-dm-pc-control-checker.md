# DM Player-Character Control Checker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the AI DM from playing the player characters: an optional checker model reviews every DM narration, the DM rewrites once when it goes beyond what players declared, and offending sentences are cut after that.

**Architecture:** The checker is an optional campaign seat (`seats.checker`) called through the existing `ModelClient` with no tools and `reasoningEffort: "none"`. Pure helpers in `packages/core/src/pc-control.ts` gather player declarations, parse the checker's JSON, verify flagged sentences against the narration, and cut them. The director runs the check on each `narrate` call in a DM beat (retry once, then trim), never pauses a session on checker failure, and logs `dm_controls_pc` flags plus DM-only notes.

**Tech Stack:** TypeScript, Node ≥ 22.22, npm workspaces, Vitest, Zod 4, Vercel AI SDK 7 (`ai`, `@ai-sdk/openai-compatible`).

**Spec:** `docs/superpowers/specs/2026-09-14-dm-pc-control-checker-design.md`

## Global Constraints

- Node ≥ 22.22; run commands from the repository root `/Users/labeaaa/Developer/cartyx-sim`.
- Before every commit, all three pass: `npm run typecheck`, `npm test`, `npm run format:check`. Format changed files with `npx prettier --write <files>`; formatting failures are never deferred.
- `packages/core` and `packages/rules` must not import Node APIs (`node:*`); they are typechecked without Node types.
- Zod 4: `import { z } from 'zod'`.
- Campaign and character files are JSON. Never add YAML.
- `EVENT_SCHEMA_VERSION` stays `1`. The `validator_flag` resolution enum gains `trimmed` additively.
- The checker never pauses a session.
- Without `seats.checker`, behavior is unchanged and every existing test passes untouched.
- Work on branch `feat/dm-pc-control-checker`; commit once per task; do not push.
- End every commit message with these two lines:

  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LSnP9Z837zfKgZJcQR7Q9B
  ```

---

## Before you start

- [ ] **Create the branch**

```bash
git switch -c feat/dm-pc-control-checker
```

Expected: `Switched to a new branch 'feat/dm-pc-control-checker'`.

## File map

| File                                                                      | Change | Responsibility                                                      |
| ------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------- |
| `packages/models/src/seat.ts`                                             | Modify | `reasoningEffort` seat option and `reasoningProviderOptions` helper |
| `packages/models/src/client.ts`                                           | Modify | Send a seat's reasoning effort                                      |
| `packages/models/src/bench.ts`                                            | Modify | Send reasoning effort in bench calls                                |
| `packages/models/src/testing.ts`                                          | Modify | `reasoning_effort` on the fake server's request type                |
| `packages/models/test/client.test.ts`, `bench.test.ts`                    | Modify | Tests                                                               |
| `packages/core/src/pc-control.ts`                                         | Create | Declarations, reply parsing, verification, cutting                  |
| `packages/core/test/pc-control.test.ts`                                   | Create | Tests                                                               |
| `packages/core/src/prompts.ts`                                            | Modify | `pcControlCheck` prompt, stricter DM rule                           |
| `packages/core/test/prompts.test.ts`                                      | Create | Tests                                                               |
| `packages/core/src/events.ts`, `packages/core/test/contract.test.ts`      | Modify | `trimmed` resolution                                                |
| `packages/core/src/director.ts`                                           | Modify | Checker seat, per-narration flow, failure handling                  |
| `packages/core/test/director-pc-control.test.ts`                          | Create | Tests                                                               |
| `packages/core/src/index.ts`                                              | Modify | Export `pc-control`                                                 |
| `apps/cli/src/campaign.ts`, `apps/cli/src/bench.ts`                       | Modify | Checker seat, reasoning effort, bench without tool trials           |
| `apps/cli/test/campaign.test.ts`, `bench.test.ts`, `run-campaign.test.ts` | Modify | Tests                                                               |
| `docs/running-a-session.md`, `docs/status.md`, spec                       | Modify | Docs                                                                |

---

### Task 1: Per-seat reasoning effort in `packages/models`

**Files:**

- Modify: `packages/models/src/seat.ts`
- Modify: `packages/models/src/client.ts`
- Modify: `packages/models/src/bench.ts`
- Modify: `packages/models/src/testing.ts`
- Test: `packages/models/test/client.test.ts`, `packages/models/test/bench.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces:
  - `SeatConfig.reasoningEffort?: 'none' | 'low' | 'medium' | 'high'` (and on `SeatConfigInput`).
  - `reasoningProviderOptions(providerName: string, reasoningEffort: SeatConfig['reasoningEffort']): Record<string, Record<string, string>> | undefined`, exported from `@cartyx-sim/models`.
  - `ChatCompletionRequest.reasoning_effort?: string` in `@cartyx-sim/models/testing`.
  - `benchSeat(..., { trials: 0 })` runs no tool trials (already true; pinned by a test).

- [ ] **Step 1: Write the failing tests**

In `packages/models/src/testing.ts`, add one field to `ChatCompletionRequest` (after `max_tokens?: number;`) so tests can read it:

```ts
  reasoning_effort?: string;
```

Append to the `describe('OpenAICompatibleModelClient', ...)` block in `packages/models/test/client.test.ts`:

```ts
it("sends a seat's reasoning effort as reasoning_effort, and nothing when unset", async () => {
  const fake = await server(() => ({ text: '{"violations": []}' }));
  const client = new OpenAICompatibleModelClient({
    checker: { endpoint: { baseURL: fake.baseURL }, model: 'glm', reasoningEffort: 'none' },
    dm: { endpoint: { baseURL: fake.baseURL }, model: 'qwen-dm' },
  });

  await client.complete(request({ seat: 'checker', tools: [], toolChoice: 'auto' }));
  await client.complete(request({ seat: 'dm', toolChoice: 'auto' }));

  expect(fake.requests[0]).toMatchObject({ model: 'glm', reasoning_effort: 'none' });
  expect(fake.requests[0]).not.toHaveProperty('reasoningEffort');
  expect(fake.requests[0]).not.toHaveProperty('tools');
  expect(fake.requests[0]).not.toHaveProperty('tool_choice');
  expect(fake.requests[1]).not.toHaveProperty('reasoning_effort');
});
```

Append to the `describe('benchSeat', ...)` block in `packages/models/test/bench.test.ts`:

```ts
it("sends the seat's reasoning effort with the speed test and the tool trials", async () => {
  const fake = await server((_body, index) =>
    index === 0
      ? { text: 'A corridor.' }
      : { toolCalls: [{ name: 'roll_dice', arguments: { dice: '1d20+3', reason: 'ok' } }] }
  );

  await benchSeat(
    'checker',
    { endpoint: { baseURL: fake.baseURL }, model: 'glm', reasoningEffort: 'none' },
    { trials: 1 }
  );

  expect(fake.requests.map((sent) => sent.reasoning_effort)).toEqual(['none', 'none']);
});

it('runs no tool trials when trials is 0', async () => {
  const fake = await server(() => ({ text: 'A corridor.', completionTokens: 20 }), {
    models: ['glm'],
  });

  const result = await benchSeat(
    'checker',
    { endpoint: { baseURL: fake.baseURL }, model: 'glm' },
    { trials: 0 }
  );

  expect(result).toMatchObject({
    reachable: true,
    modelListed: true,
    toolCallTrials: 0,
    toolCallSuccesses: 0,
    errors: [],
  });
  expect(fake.requests).toHaveLength(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/models/test/client.test.ts packages/models/test/bench.test.ts`

Expected:

- FAIL: the two `reasoning_effort` tests. `reasoning_effort` is `undefined`, and TypeScript accepts `reasoningEffort` only after Step 3. Vitest still runs, because Zod strips unknown keys.
- PASS: "runs no tool trials when trials is 0" already passes. It pins behavior Task 5 relies on.

- [ ] **Step 3: Implement**

In `packages/models/src/seat.ts`, add inside `SeatConfig = ModelTarget.extend({ ... })`, after the `toolChoice` entry:

```ts
  /**
   * Sent as `reasoning_effort`. "none" turns thinking off on servers that support it (LM Studio,
   * Ollama), which makes short structured replies such as the checker's fast. Unset leaves the
   * server's default.
   */
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).optional(),
```

and append to the end of `packages/models/src/seat.ts`:

```ts
/**
 * AI SDK provider options that carry a seat's reasoning effort. `@ai-sdk/openai-compatible` reads
 * `reasoningEffort` under the provider's name and sends it as `reasoning_effort`.
 */
export function reasoningProviderOptions(
  providerName: string,
  reasoningEffort: SeatConfig['reasoningEffort']
): Record<string, Record<string, string>> | undefined {
  return reasoningEffort ? { [providerName]: { reasoningEffort } } : undefined;
}
```

In `packages/models/src/client.ts`:

- Change the seat import to `import { reasoningProviderOptions, SeatConfig, type ModelTarget, type SeatConfigInput } from './seat';`.
- Add `const PROVIDER_NAME = 'cartyx-sim';` below the imports.
- In `generate`, replace `name: 'cartyx-sim',` with `name: PROVIDER_NAME,`.
- In `generate`, add this line to the `generateText({ ... })` options, after `maxOutputTokens: seat.maxOutputTokens,`:

```ts
      providerOptions: reasoningProviderOptions(PROVIDER_NAME, seat.reasoningEffort),
```

In `packages/models/src/bench.ts`:

- Change `import { SeatConfig, type SeatConfigInput } from './seat';` to `import { reasoningProviderOptions, SeatConfig, type SeatConfigInput } from './seat';`.
- Add `const BENCH_PROVIDER = 'cartyx-sim-bench';` next to `SPEED_PROMPT`.
- Replace `name: 'cartyx-sim-bench',` with `name: BENCH_PROVIDER,`.
- Add this line to both `generateText({ ... })` calls (the speed test and the tool trial), after their `temperature: seat.temperature,` line:

```ts
      providerOptions: reasoningProviderOptions(BENCH_PROVIDER, seat.reasoningEffort),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/models/test/client.test.ts packages/models/test/bench.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 5: Full checks and commit**

```bash
npx prettier --write packages/models
npm run typecheck && npm test && npm run format:check
git add packages/models
git commit -F - <<'EOF'
feat(models): add a per-seat reasoning effort sent as reasoning_effort

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LSnP9Z837zfKgZJcQR7Q9B
EOF
```

Expected: typecheck clean, all tests pass, Prettier clean, one commit.

---

### Task 2: Pure checker helpers in `packages/core/src/pc-control.ts`

**Files:**

- Create: `packages/core/src/pc-control.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/pc-control.test.ts`

**Interfaces:**

- Consumes: `SimEvent` (`./events`), `GameState` and `ownEntry` (`./state`).
- Produces (all exported from `@cartyx-sim/core`):
  - `PcControlFinding` (zod schema) and `type PcControlFinding = { pc: string; sentence: string; why: string }`.
  - `declarationsSinceDm(history: readonly SimEvent[], state: GameState): string[]`
  - `parseCheckerReply(text: string): PcControlFinding[] | null`
  - `verifyFindings(narration: string, findings: readonly PcControlFinding[]): PcControlFinding[]`
  - `cutSentences(narration: string, findings: readonly PcControlFinding[]): string`
  - `describeFindings(findings: readonly PcControlFinding[]): string`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/pc-control.test.ts`:

````ts
import { describe, expect, it } from 'vitest';
import {
  cutSentences,
  declarationsSinceDm,
  describeFindings,
  parseCheckerReply,
  verifyFindings,
  type PcControlFinding,
} from '../src/pc-control';
import { TurnRecorder } from '../src/recorder';
import { kira, now, startedState, tomas } from './helpers';

function historyWith(emit: (recorder: TurnRecorder) => void) {
  const started = startedState([kira, tomas]);
  const recorder = new TurnRecorder(started.state, 'turn-2', now);
  emit(recorder);
  return { history: [...started.history, ...recorder.events], state: recorder.state };
}

function finding(sentence: string, pc = 'Kira Vale'): PcControlFinding {
  return { pc, sentence, why: 'dialogue the player never said' };
}

describe('declarationsSinceDm', () => {
  it("lists what players said, declared, or passed on since the DM's last turn ended", () => {
    const { history, state } = historyWith((recorder) => {
      recorder.emit({
        type: 'dialogue',
        speaker: 'kira',
        speakerKind: 'pc',
        text: 'Before the DM spoke.',
        emotion: 'neutral',
      });
      recorder.emit({
        type: 'narration',
        speaker: 'dm',
        text: 'The door opens.',
        emotion: 'neutral',
      });
      recorder.emit({ type: 'turn_end', actor: 'dm' });
      recorder.emit({
        type: 'dialogue',
        speaker: 'kira',
        speakerKind: 'pc',
        text: 'Who is there?',
        emotion: 'afraid',
      });
      recorder.emit({ type: 'action', actor: 'kira', intent: 'raise my hammer' });
      recorder.emit({ type: 'pass', actor: 'tomas' });
      recorder.emit({
        type: 'dialogue',
        speaker: 'npc-guard',
        speakerKind: 'npc',
        text: 'Halt!',
        emotion: 'angry',
      });
    });

    expect(declarationsSinceDm(history, state)).toEqual([
      'Kira Vale says: "Who is there?"',
      'Kira Vale attempts: raise my hammer',
      'Tomas Reed holds back.',
    ]);
  });

  it('lists everything since the session started when the DM has not had a turn yet', () => {
    const { history, state } = historyWith((recorder) => {
      recorder.emit({ type: 'action', actor: 'kira', intent: 'study the runes' });
    });
    expect(declarationsSinceDm(history, state)).toEqual(['Kira Vale attempts: study the runes']);
  });
});

describe('parseCheckerReply', () => {
  const reply =
    '{"violations": [{"pc": "Kira Vale", "sentence": "Kira nods.", "why": "undeclared"}]}';

  it('reads plain JSON', () => {
    expect(parseCheckerReply(reply)).toEqual([
      { pc: 'Kira Vale', sentence: 'Kira nods.', why: 'undeclared' },
    ]);
  });

  it('reads JSON inside a code fence or surrounded by text', () => {
    expect(parseCheckerReply('```json\n' + reply + '\n```')).toHaveLength(1);
    expect(parseCheckerReply(`Here is my answer: ${reply} Done.`)).toHaveLength(1);
  });

  it('reads an empty violations list and defaults a missing reason', () => {
    expect(parseCheckerReply('{"violations": []}')).toEqual([]);
    expect(
      parseCheckerReply('{"violations": [{"pc": "Kira Vale", "sentence": "Kira nods."}]}')
    ).toEqual([{ pc: 'Kira Vale', sentence: 'Kira nods.', why: '' }]);
  });

  it('returns null for the wrong shape, cut-off JSON, or no JSON', () => {
    expect(parseCheckerReply('{"violations": "none"}')).toBeNull();
    expect(parseCheckerReply('{"violations": [{"pc": "Kira Vale", "sentence": "Kira')).toBeNull();
    expect(parseCheckerReply('No violations found.')).toBeNull();
  });
});

describe('verifyFindings', () => {
  const narration = 'Kira turns to the others.  "I can’t quite grasp it," she admits.';

  it('keeps findings that appear in the narration despite spacing and quote style', () => {
    const kept = verifyFindings(narration, [
      finding('Kira turns to the others.'),
      finding('"I can\'t quite grasp it," she admits.'),
    ]);
    expect(kept).toHaveLength(2);
  });

  it('drops findings that are not in the narration', () => {
    expect(verifyFindings(narration, [finding('I grip the stone a little harder.')])).toEqual([]);
  });
});

describe('cutSentences', () => {
  it('removes every sentence of a flagged multi-sentence quote and keeps the rest', () => {
    const narration =
      'The runes pulse. Kira turns to the others. "These runes are old. They seem to be a ward."';
    const cut = cutSentences(narration, [
      finding('"These runes are old. They seem to be a ward."'),
    ]);
    expect(cut).toBe('The runes pulse. Kira turns to the others.');
  });

  it('removes the whole sentence around a flagged clause and keeps paragraph breaks', () => {
    const narration =
      'The fog lifts.\n\nTomas leans against a tree, watching the road. The wind rises.';
    const cut = cutSentences(narration, [finding('Tomas leans against a tree', 'Tomas Reed')]);
    expect(cut).toBe('The fog lifts.\n\nThe wind rises.');
  });

  it('returns an empty string when every sentence is cut', () => {
    expect(cutSentences('Kira nods.', [finding('Kira nods.')])).toBe('');
  });
});

describe('describeFindings', () => {
  it('lists each sentence with its character and reason', () => {
    expect(
      describeFindings([
        finding('Kira nods.'),
        { pc: 'Tomas Reed', sentence: 'Tomas grins.', why: '' },
      ])
    ).toBe('"Kira nods." (Kira Vale: dialogue the player never said); "Tomas grins." (Tomas Reed)');
  });
});
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/pc-control.test.ts`
Expected: FAIL. The file doesn't exist yet, so Vitest reports "Failed to resolve import "../src/pc-control"".

- [ ] **Step 3: Implement**

Create `packages/core/src/pc-control.ts`:

```ts
import { z } from 'zod';
import type { SimEvent } from './events';
import { ownEntry, type GameState } from './state';

/** A sentence the checker says plays a player character, with the character and the reason. */
export const PcControlFinding = z.object({
  pc: z.string().min(1),
  sentence: z.string().min(1),
  why: z.string().default(''),
});
export type PcControlFinding = z.output<typeof PcControlFinding>;

const CheckerReply = z.object({ violations: z.array(PcControlFinding) });

function nameOf(id: string, state: GameState): string {
  return ownEntry(state.combatants, id)?.name ?? id;
}

/**
 * What the player characters said, declared, or passed on since the DM's most recent turn ended,
 * as lines for the checker prompt ("Kira Vale says: …", "Kira Vale attempts: …").
 */
export function declarationsSinceDm(history: readonly SimEvent[], state: GameState): string[] {
  let start = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index]!;
    if (event.type === 'turn_end' && event.actor === 'dm') {
      start = index + 1;
      break;
    }
  }
  const party = new Set(state.partyIds);
  const lines: string[] = [];
  for (const event of history.slice(start)) {
    if (event.type === 'dialogue' && event.speakerKind === 'pc') {
      lines.push(`${nameOf(event.speaker, state)} says: "${event.text}"`);
    } else if (event.type === 'action' && party.has(event.actor)) {
      lines.push(`${nameOf(event.actor, state)} attempts: ${event.intent}`);
    } else if (event.type === 'pass' && party.has(event.actor)) {
      lines.push(`${nameOf(event.actor, state)} holds back.`);
    }
  }
  return lines;
}

/**
 * The checker's findings, or null when its reply holds no readable `{ "violations": [...] }`
 * object. Reads from the first "{" to the last "}", so code fences and surrounding text are fine.
 */
export function parseCheckerReply(text: string): PcControlFinding[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = CheckerReply.safeParse(raw);
  return parsed.success ? parsed.data.violations : null;
}

/** Lowercased, with whitespace collapsed and curly quotes and apostrophes made straight. */
function normalize(text: string): string {
  return text
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Normalized text without the quote marks around it, for matching one piece inside another. */
function matchText(text: string): string {
  return normalize(text)
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

/** Keeps only the findings whose sentence really appears in the narration. */
export function verifyFindings(
  narration: string,
  findings: readonly PcControlFinding[]
): PcControlFinding[] {
  const haystack = normalize(narration);
  return findings.filter((finding) => {
    const text = matchText(finding.sentence);
    return text.length > 0 && haystack.includes(text);
  });
}

/** Splits a paragraph after sentence-ending punctuation and any closing quotes or brackets. */
function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?…]["'”’)\]]*)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * The narration without every sentence that contains a finding or is contained in one, so a
 * finding spanning several sentences removes all of them and a finding that is one clause removes
 * its whole sentence. Paragraph breaks are kept; returns "" when nothing remains.
 */
export function cutSentences(narration: string, findings: readonly PcControlFinding[]): string {
  const cuts = findings
    .map((finding) => matchText(finding.sentence))
    .filter((text) => text.length > 0);
  return narration
    .split(/\n\s*\n/)
    .map((paragraph) =>
      splitSentences(paragraph)
        .filter((sentence) => {
          const text = matchText(sentence);
          return !(text.length > 0 && cuts.some((cut) => text.includes(cut) || cut.includes(text)));
        })
        .join(' ')
    )
    .filter((paragraph) => paragraph.length > 0)
    .join('\n\n');
}

/** Findings as one line for tool results and notes: `"sentence" (Character: reason); …`. */
export function describeFindings(findings: readonly PcControlFinding[]): string {
  return findings
    .map(
      (finding) => `"${finding.sentence}" (${finding.pc}${finding.why ? `: ${finding.why}` : ''})`
    )
    .join('; ');
}
```

In `packages/core/src/index.ts`, add after `export * from './model';`:

```ts
export * from './pc-control';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/pc-control.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Full checks and commit**

```bash
npx prettier --write packages/core/src/pc-control.ts packages/core/src/index.ts packages/core/test/pc-control.test.ts
npm run typecheck && npm test && npm run format:check
git add packages/core/src/pc-control.ts packages/core/src/index.ts packages/core/test/pc-control.test.ts
git commit -F - <<'EOF'
feat(core): add helpers to collect declarations and verify and cut PC-control findings

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LSnP9Z837zfKgZJcQR7Q9B
EOF
```

---

### Task 3: Checker prompt, stricter DM rule, and the `trimmed` resolution

**Files:**

- Modify: `packages/core/src/prompts.ts`
- Modify: `packages/core/src/events.ts`
- Test: `packages/core/test/prompts.test.ts` (create), `packages/core/test/contract.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `interface PcControlCheckInput { party: string[]; declarations: string[]; narration: string }`, exported from `prompts.ts`.
  - `PromptBuilder.pcControlCheck(input: PcControlCheckInput): ChatMessage[]`, implemented by `basicPrompts`.
  - `validator_flag.resolution` accepts `'trimmed'`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/prompts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { basicPrompts } from '../src/prompts';
import { startedState } from './helpers';

describe('basicPrompts.pcControlCheck', () => {
  it('sends the rule, the party, what players declared, and the narration', () => {
    const [system, user] = basicPrompts.pcControlCheck({
      party: ['Kira Vale', 'Tomas Reed'],
      declarations: ['Kira Vale attempts: study the runes'],
      narration: 'Kira turns to the others.',
    });
    expect(system).toMatchObject({ role: 'system' });
    expect(system!.content).toContain('the DM must not play the player characters');
    expect(system!.content).toContain('{"violations": []}');
    expect(user).toMatchObject({ role: 'user' });
    expect(user!.content).toContain('Player characters: Kira Vale, Tomas Reed');
    expect(user!.content).toContain('- Kira Vale attempts: study the runes');
    expect(user!.content).toContain('DM narration to check:\nKira turns to the others.');
  });

  it('says so when no player has declared anything', () => {
    const [, user] = basicPrompts.pcControlCheck({
      party: ['Kira Vale'],
      declarations: [],
      narration: 'The door creaks.',
    });
    expect(user!.content).toContain('since the DM last spoke:\n- nothing');
  });
});

describe('basicPrompts.dm', () => {
  it("tells the DM never to write a player character's dialogue", () => {
    const [system] = basicPrompts.dm({
      state: startedState().state,
      transcript: '',
      instruction: 'Begin.',
    });
    expect(system!.content).toContain(
      "Never write a player character's dialogue, thoughts, feelings, or choices."
    );
  });
});
```

Append inside `describe('event log contract', ...)` in `packages/core/test/contract.test.ts`:

```ts
it('accepts trimmed as a validator_flag resolution', () => {
  const { state } = startedState();
  const recorder = new TurnRecorder(state, 'turn', now);
  const event = recorder.emit({
    type: 'validator_flag',
    visibility: 'dm',
    seat: 'dm',
    rule: 'dm_controls_pc',
    retries: 0,
    resolution: 'trimmed',
  });
  expect(event).toMatchObject({ resolution: 'trimmed' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/prompts.test.ts packages/core/test/contract.test.ts`

Expected: FAIL.

- `basicPrompts.pcControlCheck is not a function`.
- The DM rule text is missing.
- The recorder rejects `resolution: 'trimmed'` with an invalid enum value.

- [ ] **Step 3: Implement**

In `packages/core/src/events.ts`, change the `validator_flag` resolution line to:

```ts
    resolution: z.enum([
      're_prompted',
      'accepted_with_flag',
      'forced_pass',
      'forced_hand_off',
      'trimmed',
    ]),
```

In `packages/core/src/prompts.ts`:

1. Add after the `PlayerPromptInput` interface:

```ts
export interface PcControlCheckInput {
  /** The player characters' names. */
  party: string[];
  /** What each player said or declared since the DM last had the floor, one line each. */
  declarations: string[];
  /** The DM narration to check. */
  narration: string;
}
```

2. Add to `interface PromptBuilder`:

```ts
  /** Asks the checker seat which narration sentences play a player character. */
  pcControlCheck(input: PcControlCheckInput): ChatMessage[];
```

3. In `DM_SYSTEM`, replace the line `'Never decide what a player character does, says, thinks, or feels.',` with:

```ts
  "Narrate the world and the results of what players declared. Never write a player character's dialogue, thoughts, feelings, or choices.",
```

4. Add after `DM_SYSTEM`:

```ts
const PC_CONTROL_SYSTEM = [
  "You check a Dungeons & Dragons Dungeon Master's narration for one rule: the DM must not play the player characters.",
  "The DM may describe a player character carrying out and experiencing the action that player declared, and the world's response to it, including effects on the character.",
  "The DM must not write a player character's dialogue, thoughts, feelings, or decisions, or have them do anything their player did not declare.",
  'Quote each offending sentence exactly as it appears in the narration.',
  'Reply with JSON only: {"violations": [{"pc": "<name>", "sentence": "<exact sentence>", "why": "<short reason>"}]}. Reply {"violations": []} when there are none.',
].join('\n');
```

5. Add to `basicPrompts`, after `player`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/prompts.test.ts packages/core/test/contract.test.ts packages/core/test/director.test.ts`
Expected: PASS. The director tests still pass because the DM rule change affects prompt text only.

- [ ] **Step 5: Full checks and commit**

```bash
npx prettier --write packages/core/src/prompts.ts packages/core/src/events.ts packages/core/test/prompts.test.ts packages/core/test/contract.test.ts
npm run typecheck && npm test && npm run format:check
git add packages/core/src/prompts.ts packages/core/src/events.ts packages/core/test/prompts.test.ts packages/core/test/contract.test.ts
git commit -F - <<'EOF'
feat(core): add the PC-control checker prompt, a stricter DM rule, and a trimmed resolution

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LSnP9Z837zfKgZJcQR7Q9B
EOF
```

---

### Task 4: Run the checker on every DM narration

**Files:**

- Modify: `packages/core/src/director.ts`
- Test: `packages/core/test/director-pc-control.test.ts` (create)

**Interfaces:**

- Consumes:
  - From Task 2: `declarationsSinceDm`, `parseCheckerReply`, `verifyFindings`, `cutSentences`, `describeFindings`, `PcControlFinding`.
  - From Task 3: `PromptBuilder.pcControlCheck`, the `trimmed` resolution.
- Produces:
  - `DirectorConfig.seats.checker?: string`.
  - `DirectorConfig.maxCheckerFailures?: number` (default 3).
  - Director behavior per spec §6–§8. Task 5 relies on `seats.checker` being passed straight from the campaign.

Behavior this task implements (spec §6):

- It runs on each `narrate` call that passes the duplicate check and `validateDmText` without a violation. A narration accepted with a flag after the validator's retries run out is not checked.
- It calls the checker seat with `tools: []` and `toolChoice: 'auto'`, directly through `deps.model.complete`, not through `callModel`.
- The DM's own call gets one retry per beat (`re_prompted`, `skipRest`). A second offense in the beat, or engine-made prose, gets cut (`trimmed`, a DM-only note, later calls still run).
- On checker failure or an unreadable reply: a DM-only note and the narration proceeds. After `maxCheckerFailures` consecutive failures, checking stops for the rest of the run with one note.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/director-pc-control.test.ts`:

```ts
import { scriptedRng } from '@cartyx-sim/rules';
import { describe, expect, it } from 'vitest';
import { Director, type DirectorConfig } from '../src/director';
import type { SimEvent } from '../src/events';
import { basicPrompts } from '../src/prompts';
import { MemorySink } from '../src/sink';
import {
  respond,
  ScriptedModelClient,
  StaticLoreIndex,
  toolCall,
  type ScriptedResponse,
} from '../src/testing';
import { kira, now, tomas } from './helpers';

function config(overrides: Partial<DirectorConfig> = {}): DirectorConfig {
  return {
    session: 1,
    targetMinutes: 60,
    loreCommit: 'abc123',
    party: [kira, tomas],
    seats: {
      dm: 'dm',
      checker: 'checker',
      players: { kira: 'player-kira', tomas: 'player-tomas' },
    },
    retryDelaysMs: [],
    ...overrides,
  };
}

function setup(
  script: Record<string, ScriptedResponse[]>,
  overrides: Partial<DirectorConfig> = {}
) {
  let turn = 0;
  const model = new ScriptedModelClient(script);
  const sink = new MemorySink();
  const director = Director.create(config(overrides), {
    model,
    lore: new StaticLoreIndex([]),
    rng: scriptedRng([]),
    sink,
    prompts: basicPrompts,
    now,
    newTurnId: () => `turn-${++turn}`,
    sleep: async () => {},
  });
  return { director, model, sink };
}

const CLEAN: ScriptedResponse = { text: '{"violations": []}', toolCalls: [] };

function flagged(sentence: string, pc = 'Kira Vale'): ScriptedResponse {
  return {
    text: JSON.stringify({ violations: [{ pc, sentence, why: 'the player never declared it' }] }),
    toolCalls: [],
  };
}

const narrate = (text: string) => toolCall('narrate', { text });
const handOffTomas = () => toolCall('hand_off', { target: { kind: 'pcs', ids: ['tomas'] } });

function ofType<T extends SimEvent['type']>(events: readonly SimEvent[], type: T) {
  return events.filter((event): event is Extract<SimEvent, { type: T }> => event.type === type);
}

async function playDmBeat(director: Promise<Director>) {
  const ready = await director;
  await ready.step(); // session_start
  await ready.step(); // DM beat
}

const BAD = 'The runes pulse. Kira turns to the others. "These runes are old."';
const BAD_SENTENCE = '"These runes are old."';

describe('DM player-character control checker', () => {
  it('narrates a clean narration and asks the checker with no tools', async () => {
    const { director, model, sink } = setup({
      dm: [respond(narrate('The door creaks open.'), handOffTomas())],
      checker: [CLEAN],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual(['The door creaks open.']);
    expect(ofType(sink.events, 'validator_flag')).toEqual([]);
    const [check] = model.requests.filter((request) => request.seat === 'checker');
    expect(check).toMatchObject({ tools: [], toolChoice: 'auto' });
    expect(check!.messages[1]!.content).toContain('DM narration to check:\nThe door creaks open.');
  });

  it('asks the DM to rewrite once, then narrates the clean rewrite', async () => {
    const { director, model, sink } = setup({
      dm: [respond(narrate(BAD)), respond(narrate('The runes pulse softly.'), handOffTomas())],
      checker: [flagged(BAD_SENTENCE), CLEAN],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual([
      'The runes pulse softly.',
    ]);
    expect(ofType(sink.events, 'validator_flag')).toMatchObject([
      { seat: 'dm', rule: 'dm_controls_pc', resolution: 're_prompted' },
    ]);
    const dmRequests = model.requests.filter((request) => request.seat === 'dm');
    expect(dmRequests[1]!.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('Rejected (dm_controls_pc)'),
    });
    expect(dmRequests[1]!.messages.at(-1)!.content).toContain('These runes are old.');
  });

  it('cuts the offending sentences on a second offense and records them', async () => {
    const { director, sink } = setup({
      dm: [respond(narrate(BAD)), respond(narrate(`The wind rises. ${BAD}`), handOffTomas())],
      checker: [flagged(BAD_SENTENCE), flagged(BAD_SENTENCE)],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual([
      'The wind rises. The runes pulse. Kira turns to the others.',
    ]);
    expect(ofType(sink.events, 'validator_flag').map((e) => e.resolution)).toEqual([
      're_prompted',
      'trimmed',
    ]);
    const [note] = ofType(sink.events, 'ooc_note');
    expect(note).toMatchObject({ visibility: 'dm' });
    expect(note!.text).toContain('Cut from DM narration (dm_controls_pc)');
    expect(note!.text).toContain('These runes are old.');
    expect(ofType(sink.events, 'hand_off')).toHaveLength(1);
  });

  it('skips the retry for a later offense in the same beat', async () => {
    const { director, sink } = setup({
      dm: [
        respond(narrate(BAD)),
        respond(narrate('The runes pulse softly.')),
        respond(narrate('Tomas leans on a tree. The wind rises.'), handOffTomas()),
      ],
      checker: [flagged(BAD_SENTENCE), CLEAN, flagged('Tomas leans on a tree.', 'Tomas Reed')],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual([
      'The runes pulse softly.',
      'The wind rises.',
    ]);
    expect(ofType(sink.events, 'validator_flag').map((e) => e.resolution)).toEqual([
      're_prompted',
      'trimmed',
    ]);
  });

  it("cuts engine-made prose without a retry and still runs the DM's calls", async () => {
    const { director, model, sink } = setup({
      dm: [
        {
          text: 'The runes pulse. Kira turns to the others, eyes bright.',
          toolCalls: [
            toolCall('scene_change', { location: 'Crossroads', artPrompt: 'A misty crossroads' }),
            handOffTomas(),
          ],
        },
      ],
      checker: [flagged('Kira turns to the others, eyes bright.')],
    });
    await playDmBeat(director);

    expect(sink.events.slice(1).map((e) => e.type)).toEqual([
      'scene_change',
      'validator_flag',
      'ooc_note',
      'narration',
      'hand_off',
      'turn_end',
    ]);
    expect(ofType(sink.events, 'narration')[0]).toMatchObject({ text: 'The runes pulse.' });
    expect(model.requests.filter((request) => request.seat === 'dm')).toHaveLength(1);
  });

  it('narrates nothing when every sentence is cut, and the beat still hands off', async () => {
    const { director, sink } = setup({
      dm: [{ text: 'Kira turns to the others, eyes bright.', toolCalls: [handOffTomas()] }],
      checker: [flagged('Kira turns to the others, eyes bright.')],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration')).toEqual([]);
    expect(ofType(sink.events, 'validator_flag')).toMatchObject([{ resolution: 'trimmed' }]);
    expect(ofType(sink.events, 'hand_off')).toHaveLength(1);
  });

  it('ignores a flagged sentence that is not in the narration', async () => {
    const { director, sink } = setup({
      dm: [respond(narrate('The door creaks open.'), handOffTomas())],
      checker: [flagged('Kira sings a song.')],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual(['The door creaks open.']);
    expect(ofType(sink.events, 'validator_flag')).toEqual([]);
  });

  it('narrates unchecked with a note when the checker fails or its reply is unreadable', async () => {
    const { director, sink } = setup({
      dm: [respond(narrate('The door creaks open.'), narrate('The wind rises.'), handOffTomas())],
      checker: [{ throw: 'connection refused' }, { text: 'Looks fine to me!', toolCalls: [] }],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration')).toHaveLength(2);
    expect(ofType(sink.events, 'ooc_note').map((e) => e.text)).toEqual([
      'Checker unavailable (connection refused); narration not checked.',
      'Checker reply unreadable; narration not checked.',
    ]);
    expect(ofType(sink.events, 'session_paused')).toEqual([]);
  });

  it('stops checking for the rest of the run after repeated failures', async () => {
    const { director, model, sink } = setup({
      dm: [
        respond(
          narrate('One bell tolls.'),
          narrate('Two bells toll.'),
          narrate('Three bells toll.'),
          narrate('Four bells toll.'),
          handOffTomas()
        ),
      ],
      checker: [{ throw: 'down' }, { throw: 'down' }, { throw: 'down' }],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration')).toHaveLength(4);
    expect(model.requests.filter((request) => request.seat === 'checker')).toHaveLength(3);
    expect(ofType(sink.events, 'ooc_note').at(-1)!.text).toBe(
      'Checker failed 3 times in a row; narration is not checked for the rest of this run.'
    );
  });

  it('does not call the checker when the rule check already rejected the narration', async () => {
    const { director, model } = setup({
      dm: [
        respond(narrate('Kira decides to open the door.')),
        respond(narrate('The door creaks.'), handOffTomas()),
      ],
      checker: [CLEAN],
    });
    await playDmBeat(director);

    expect(model.requests.filter((request) => request.seat === 'checker')).toHaveLength(1);
  });

  it('sends the checker what players declared since the DM last spoke', async () => {
    const { director, model } = setup({
      dm: [
        respond(
          narrate('The hall is quiet.'),
          toolCall('hand_off', { target: { kind: 'pcs', ids: ['kira'] } })
        ),
        respond(narrate("The runes glow under Kira's palm."), handOffTomas()),
      ],
      'player-kira': [respond(toolCall('act', { intent: 'press my palm to the runes' }))],
      checker: [CLEAN, CLEAN],
    });
    await (await director).run(4);

    const checks = model.requests.filter((request) => request.seat === 'checker');
    expect(checks[0]!.messages[1]!.content).toContain('since the DM last spoke:\n- nothing');
    expect(checks[1]!.messages[1]!.content).toContain(
      '- Kira Vale attempts: press my palm to the runes'
    );
  });

  it('never calls a checker when no checker seat is configured', async () => {
    const { director, model, sink } = setup(
      { dm: [respond(narrate('The door creaks open.'), handOffTomas())] },
      { seats: { dm: 'dm', players: { kira: 'player-kira', tomas: 'player-tomas' } } }
    );
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration')).toHaveLength(1);
    expect(model.requests.every((request) => request.seat === 'dm')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/director-pc-control.test.ts`

Expected: FAIL.

- **TypeScript** reports `checker` is not a known key of `seats`. Vitest runs anyway.
- **Fails:** the checker tests. Nothing calls the checker, so no `re_prompted` or `trimmed` flags appear and the BAD narration is narrated.
- **Passes:** "never calls a checker when no checker seat is configured" and "ignores a flagged sentence that is not in the narration".

- [ ] **Step 3: Implement**

In `packages/core/src/director.ts`:

1. Add to the imports (after the `./model` import):

```ts
import {
  cutSentences,
  declarationsSinceDm,
  describeFindings,
  parseCheckerReply,
  verifyFindings,
  type PcControlFinding,
} from './pc-control';
```

2. In `DirectorConfig`, replace the `seats` line and its comment with:

```ts
  /** Seat ids for the DM, each PC id, and optionally the checker that reviews DM narration. */
  seats: { dm: string; players: Record<string, string>; checker?: string };
```

and add after `retryDelaysMs?: number[];`:

```ts
  /** Consecutive checker failures before narration stops being checked for the run. Default 3. */
  maxCheckerFailures?: number;
```

3. In the `Director` class fields, add after `private readonly retryDelaysMs: number[];`:

```ts
  private readonly maxCheckerFailures: number;
  /** Consecutive checker calls that gave no verdict; reset by a successful check. */
  private checkerFailures = 0;
  /** Set once the checker has failed too often; lasts for this run only. */
  private checkerDisabled = false;
```

and in the constructor, after `this.retryDelaysMs = ...;`:

```ts
this.maxCheckerFailures = config.maxCheckerFailures ?? 3;
```

4. In `dmBeat`, add `let pcControlRetried = false;` after `let callLimitHit = false;`.

5. In `dmBeat`, replace:

```ts
const execution = await runPreparedCall(prepared.def, prepared.args, context);
```

with:

```ts
let args = prepared.args;
let removed = '';
if (call.name === 'narrate' && text && !violation) {
  const findings = await this.checkPcControl(recorder, text);
  if (findings.length > 0) {
    const listed = describeFindings(findings);
    if (call.id !== proseCallId && !pcControlRetried) {
      pcControlRetried = true;
      messages.push(
        toolMessage(
          call,
          `Rejected (dm_controls_pc): these sentences play player characters: ${listed}. Rewrite the narration without them and call narrate again.`
        )
      );
      this.flag(recorder, seat, 'dm_controls_pc', rejections, 're_prompted');
      skipRest = true;
      continue;
    }
    // A second offense this beat, or prose the engine narrated: cut only those sentences.
    const kept = cutSentences(text, findings);
    this.flag(recorder, seat, 'dm_controls_pc', rejections, 'trimmed');
    recorder.emit({
      type: 'ooc_note',
      visibility: 'dm',
      text: `Cut from DM narration (dm_controls_pc): ${listed}`,
    });
    if (!kept) {
      messages.push(
        toolMessage(call, `Not narrated: every sentence played a player character. ${listed}`)
      );
      continue;
    }
    args = { ...(prepared.args as Record<string, unknown>), text: kept };
    removed = ` Removed sentences that played player characters: ${listed}`;
  }
}
const execution = await runPreparedCall(prepared.def, args, context);
```

and in the same loop, replace:

```ts
messages.push(toolMessage(call, execution.outcome.result));
```

with:

```ts
messages.push(toolMessage(call, execution.outcome.result + removed));
```

6. Change the `flag` method's `resolution` parameter type to:

```ts
resolution: 're_prompted' | 'accepted_with_flag' | 'forced_pass' | 'forced_hand_off' | 'trimmed';
```

7. Add this method after `flag`:

```ts
  /**
   * Asks the checker seat which sentences of a DM narration play a player character, and returns
   * only findings that really appear in the narration. Never pauses the session: a failed or
   * unreadable check leaves the narration unchecked, with a DM-only note, and repeated failures
   * stop checking for the rest of the run.
   */
  private async checkPcControl(
    recorder: TurnRecorder,
    narration: string
  ): Promise<PcControlFinding[]> {
    const seat = this.config.seats.checker;
    if (!seat || this.checkerDisabled) return [];
    const party = this.state.partyIds.map((id) => ownEntry(this.state.combatants, id)?.name ?? id);
    const messages = this.deps.prompts.pcControlCheck({
      party,
      declarations: declarationsSinceDm(this.history, this.state),
      narration,
    });
    let findings: PcControlFinding[] | null = null;
    let failure = 'Checker reply unreadable; narration not checked.';
    try {
      const response = ModelResponse.safeParse(
        await this.deps.model.complete({
          seat,
          turnId: recorder.turnId,
          messages,
          tools: [],
          toolChoice: 'auto',
        })
      );
      findings = response.success ? parseCheckerReply(response.data.text) : null;
    } catch (error) {
      failure = `Checker unavailable (${error instanceof Error ? error.message : String(error)}); narration not checked.`;
    }
    if (findings === null) {
      this.checkerFailures++;
      recorder.emit({ type: 'ooc_note', visibility: 'dm', text: failure });
      if (this.checkerFailures >= this.maxCheckerFailures) {
        this.checkerDisabled = true;
        recorder.emit({
          type: 'ooc_note',
          visibility: 'dm',
          text: `Checker failed ${this.checkerFailures} times in a row; narration is not checked for the rest of this run.`,
        });
      }
      return [];
    }
    this.checkerFailures = 0;
    return verifyFindings(narration, findings);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/director-pc-control.test.ts packages/core/test/director.test.ts packages/core/test/director-backstop.test.ts`
Expected: PASS. All new tests pass, and the existing director and backstop tests are unchanged.

- [ ] **Step 5: Full checks and commit**

```bash
npx prettier --write packages/core/src/director.ts packages/core/test/director-pc-control.test.ts
npm run typecheck && npm test && npm run format:check
git add packages/core/src/director.ts packages/core/test/director-pc-control.test.ts
git commit -F - <<'EOF'
feat(core): check DM narration for playing player characters with an optional checker seat

The DM rewrites once when the checker finds sentences that go beyond what players declared;
after that, or for engine-made prose, those sentences are cut and logged. A failed or
unreadable check never pauses the session.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LSnP9Z837zfKgZJcQR7Q9B
EOF
```

---

### Task 5: Checker seat in the campaign loader, `sim run`, and `sim bench`

**Files:**

- Modify: `apps/cli/src/campaign.ts`
- Modify: `apps/cli/src/bench.ts`
- Test: `apps/cli/test/campaign.test.ts`, `apps/cli/test/bench.test.ts`, `apps/cli/test/run-campaign.test.ts`

**Interfaces:**

- Consumes:
  - From Task 1: `SeatConfigInput.reasoningEffort`; `benchSeat` with `trials: 0`.
  - From Task 4: `DirectorConfig.seats.checker`.
- Produces:
  - `CHECKER_SEAT = 'checker'`, exported from `campaign.ts`.
  - `Campaign.seats: { dm: string; players: Record<string, string>; checker?: string }`.
  - `Campaign.models.checker` when configured.
  - Every seat accepts `reasoningEffort`.
  - `sim bench` runs zero tool trials for the checker seat and shows `-` in its tool-calls cell.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('loadCampaign', ...)` in `apps/cli/test/campaign.test.ts`:

```ts
it('loads an optional checker seat with its reasoning effort', async () => {
  const base = config();
  const withChecker = {
    ...base,
    seats: {
      ...base.seats,
      checker: { endpoint: 'ampere', model: 'glm', reasoningEffort: 'none', timeoutMs: 20000 },
    },
  };
  await writeCampaign(withChecker, { 'kira.json': KIRA });
  const campaign = await loadCampaign(campaignsDir, 'test');

  expect(campaign.seats).toEqual({
    dm: 'dm',
    players: { kira: 'player-kira' },
    checker: 'checker',
  });
  expect(campaign.models.checker).toEqual({
    endpoint: { baseURL: 'http://10.0.0.3:8080/v1', apiKey: 'secret' },
    model: 'glm',
    reasoningEffort: 'none',
    timeoutMs: 20000,
    fallbacks: [],
  });
});

it('names an unknown checker endpoint and rejects an unknown reasoning effort', async () => {
  const base = config();
  await writeCampaign(
    { ...base, seats: { ...base.seats, checker: { endpoint: 'nowhere', model: 'glm' } } },
    { 'kira.json': KIRA }
  );
  await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow(
    'seats.checker uses unknown endpoint "nowhere"'
  );

  await writeCampaign(
    {
      ...base,
      seats: {
        ...base.seats,
        checker: { endpoint: 'ampere', model: 'glm', reasoningEffort: 'max' },
      },
    },
    { 'kira.json': KIRA }
  );
  await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow('invalid campaign');
});
```

Append inside `describe('runBench', ...)` in `apps/cli/test/bench.test.ts`:

```ts
it('benchmarks a checker seat without tool-call trials', async () => {
  const dir = join(campaignsDir, 'checked');
  await mkdir(join(dir, 'characters'), { recursive: true });
  await writeFile(
    join(dir, 'campaign.json'),
    JSON.stringify({
      name: 'Checked',
      targetMinutes: 30,
      endpoints: { local: { baseURL: fake.baseURL } },
      seats: {
        dm: { endpoint: 'local', model: 'dm-model' },
        checker: { endpoint: 'local', model: 'player-model', reasoningEffort: 'none' },
        players: { kira: { endpoint: 'local', model: 'player-model' } },
      },
    })
  );
  await writeFile(join(dir, 'characters', 'kira.json'), KIRA);
  const lines: string[] = [];

  const report = await runBench({
    campaignsDir,
    campaign: 'checked',
    trials: 2,
    log: (line) => lines.push(line),
  });

  expect(report.results.map((result) => [result.seat, result.toolCallTrials])).toEqual([
    ['dm', 2],
    ['checker', 0],
    ['player-kira', 2],
  ]);
  expect(report.results[1]).toMatchObject({ reachable: true, modelListed: true });
  expect(benchPassed(report.results)).toBe(true);
  expect(lines.find((line) => line.startsWith('checker'))).toMatch(/\s-$/);
});
```

Append inside `describe('runSession with campaign model seats', ...)` in `apps/cli/test/run-campaign.test.ts` (it uses that block's `campaignsDir` and `fake`):

```ts
it('checks DM narration with a configured checker seat', async () => {
  const dir = join(campaignsDir, 'checked');
  await mkdir(join(dir, 'characters'), { recursive: true });
  await writeFile(
    join(dir, 'campaign.json'),
    JSON.stringify({
      name: 'Checked',
      targetMinutes: 0.12,
      endpoints: { local: { baseURL: fake.baseURL } },
      seats: {
        dm: { endpoint: 'local', model: 'dm-model' },
        checker: { endpoint: 'local', model: 'dm-model', reasoningEffort: 'none' },
        players: { kira: { endpoint: 'local', model: 'player-model' } },
      },
    })
  );
  await writeFile(join(dir, 'characters', 'kira.json'), JSON.stringify(KIRA));

  const result = await runSession({ campaignsDir, campaign: 'checked', session: 1, resume: false });

  expect(result.status).toBe('ended');
  const checks = fake.requests.filter((request) => request.tools === undefined);
  expect(checks.length).toBeGreaterThan(0);
  expect(checks[0]).toMatchObject({ reasoning_effort: 'none' });
});
```

In the same file, make that block's fake server answer checker calls: in the `beforeEach` of `describe('runSession with campaign model seats', ...)`, add this as the first line inside the `startFakeOpenAIServer((body) => { ... })` callback:

```ts
if (body.tools === undefined) return { text: '{"violations": []}' };
```

Checker calls are the only requests without tools, and the existing tests never make one, so they are unaffected.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/test/campaign.test.ts apps/cli/test/bench.test.ts apps/cli/test/run-campaign.test.ts`

Expected: FAIL.

- **Campaign test:** `seats` has no `checker`, because Zod strips the unknown key, so `toEqual` fails.
- **Bench test:** the checker seat never appears in the results.
- **Run test:** `checks` is empty.
- **Unknown-endpoint test:** fails because no error is thrown.

- [ ] **Step 3: Implement**

In `apps/cli/src/campaign.ts`:

1. In `SeatRef`, add after `toolChoice: ...`:

```ts
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).optional(),
```

2. In `CampaignFile`'s `seats: z.object({ ... })`, add after `dm: SeatRef,`:

```ts
    /** Optional: reviews DM narration for playing the player characters. */
    checker: SeatRef.optional(),
```

3. Add after `export const DM_SEAT = 'dm';`:

```ts
export const CHECKER_SEAT = 'checker';
```

4. In `interface Campaign`, change the `seats` line to:

```ts
  seats: { dm: string; players: Record<string, string>; checker?: string };
```

5. In `resolve`, add after `toolChoice: ref.toolChoice,`:

```ts
    reasoningEffort: ref.reasoningEffort,
```

6. Replace:

```ts
const models: Record<string, SeatConfigInput> = {
  [DM_SEAT]: resolve(file.seats.dm, 'seats.dm'),
};
```

with:

```ts
const models: Record<string, SeatConfigInput> = {
  [DM_SEAT]: resolve(file.seats.dm, 'seats.dm'),
};
if (file.seats.checker) models[CHECKER_SEAT] = resolve(file.seats.checker, 'seats.checker');
```

7. In the returned object, replace `seats: { dm: DM_SEAT, players },` with:

```ts
    seats: { dm: DM_SEAT, players, ...(file.seats.checker ? { checker: CHECKER_SEAT } : {}) },
```

In `apps/cli/src/bench.ts`:

1. Change `import { loadCampaign } from './campaign';` to `import { CHECKER_SEAT, loadCampaign } from './campaign';`.
2. In `formatBenchTable`, replace the tool-calls cell expression:

```ts
    `${result.toolCallSuccesses}/${result.toolCallTrials}` +
      (result.textReplies > 0 ? ` (+${result.textReplies} text)` : ''),
```

with:

```ts
    result.toolCallTrials === 0
      ? '-'
      : `${result.toolCallSuccesses}/${result.toolCallTrials}` +
        (result.textReplies > 0 ? ` (+${result.textReplies} text)` : ''),
```

3. In `runBench`, replace:

```ts
results.push(await benchSeat(seat, model, { trials: options.trials }));
```

with:

```ts
// The checker answers in JSON without tools, so it gets no tool-call trials.
const trials = seat === CHECKER_SEAT ? 0 : options.trials;
results.push(await benchSeat(seat, model, { trials }));
```

`apps/cli/src/run.ts` needs no change: it already passes `campaign.seats` to the director.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/test`
Expected: PASS (all CLI tests).

- [ ] **Step 5: Full checks and commit**

```bash
npx prettier --write apps/cli/src/campaign.ts apps/cli/src/bench.ts apps/cli/test/campaign.test.ts apps/cli/test/bench.test.ts apps/cli/test/run-campaign.test.ts
npm run typecheck && npm test && npm run format:check
git add apps/cli
git commit -F - <<'EOF'
feat(cli): configure a checker seat and a per-seat reasoning effort in campaign.json

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LSnP9Z837zfKgZJcQR7Q9B
EOF
```

---

### Task 6: Docs, then live verification on the real machines

**Files:**

- Modify: `docs/running-a-session.md`
- Modify: `docs/status.md`
- Modify: `docs/superpowers/specs/2026-09-14-dm-pc-control-checker-design.md`
- Local only (git-ignored): `campaigns/avalon/campaign.json`

**Interfaces:**

- Consumes: everything above.
- Produces: operator docs, and live evidence against the spec's success criteria (§9).

- [ ] **Step 1: Document the checker**

Append to `docs/running-a-session.md`:

````markdown
## 7. Keep the DM from playing the players (optional)

Models acting as DM tend to write dialogue, thoughts, and actions for the player characters. An optional checker seat reviews every DM narration against what the players declared since the DM last spoke. The DM may describe a character carrying out the action its player declared; it may not write that character's dialogue, thoughts, feelings, or choices, or have them do anything undeclared.

When the checker finds sentences that cross that line, the DM is asked to rewrite once; if it does it again in the same turn, just those sentences are cut. Each case is logged as a `dm_controls_pc` flag (`re_prompted` or `trimmed`), and cut sentences are listed in a DM-only note. If the checker is down or its reply is unreadable, the narration goes through unchecked with a note; after 3 failures in a row, checking stops for the rest of the run. The checker never pauses a session.

Add it under `seats` in `campaign.json`:

```json
"checker": {
  "endpoint": "ampere",
  "model": "glm-4.7-flash:latest",
  "temperature": 0.2,
  "maxOutputTokens": 1500,
  "timeoutMs": 20000,
  "reasoningEffort": "none",
  "fallbacks": [{ "endpoint": "macbook", "model": "<a fast model id>" }]
}
```

`reasoningEffort: "none"` turns thinking off, which keeps each check to a few seconds; any seat accepts `reasoningEffort` (`none`, `low`, `medium`, or `high`). `sim bench` checks the checker seat's reachability and speed but runs no tool-call trials for it, so its tool-calls column shows `-`.
````

- [ ] **Step 2: Update the status page and the spec**

In `docs/status.md`:

- Under "Open backlog" → "Plan 2C", delete the line `- a per-seat \`reasoningEffort\` option (would make Muse Glimmer usable);`.
- Add this bullet at the end of the "What the runs taught us:" list:

```markdown
- **The DM plays the players.** Session 001's DM wrote dialogue for three player characters; the verb-list validator missed it. An optional checker seat now reviews each narration (`docs/running-a-session.md` §7).
```

In `docs/superpowers/specs/2026-09-14-dm-pc-control-checker-design.md`, replace the `declarationsSinceDm(history)` bullet's opening text `` `declarationsSinceDm(history)`: `` with `` `declarationsSinceDm(history, state)` (state supplies character names): ``, and replace `extracts the first JSON object (tolerating code fences and surrounding text)` with `reads from the first "{" to the last "}" (tolerating code fences and surrounding text)`.

- [ ] **Step 3: Format and commit the docs**

```bash
npx prettier --write docs/running-a-session.md docs/status.md docs/superpowers/specs/2026-09-14-dm-pc-control-checker-design.md
npm run format:check
git add docs/running-a-session.md docs/status.md docs/superpowers/specs/2026-09-14-dm-pc-control-checker-design.md
git commit -F - <<'EOF'
docs: document the DM player-character control checker

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LSnP9Z837zfKgZJcQR7Q9B
EOF
```

- [ ] **Step 4: Add the checker seat to the local campaign and bench it**

`campaigns/` is git-ignored, so this changes nothing in the repository. LAN calls need the command sandbox disabled.

```bash
/opt/homebrew/bin/python3 - campaigns/avalon/campaign.json <<'EOF'
import json, sys
path = sys.argv[1]
c = json.load(open(path))
c["seats"]["checker"] = {
    "endpoint": "ampere", "model": "glm-4.7-flash:latest", "temperature": 0.2,
    "maxOutputTokens": 1500, "timeoutMs": 20000, "reasoningEffort": "none",
    "fallbacks": [{"endpoint": "m5", "model": "qwen/qwen3.6-35b-a3b"}],
}
open(path, "w").write(json.dumps(c, indent=2) + "\n")
EOF
npm run sim -- bench --campaign avalon --trials 3
```

Expected: every seat reachable and listed. The `checker` row shows `-` in the tool-calls column. The bench exits 0.

- [ ] **Step 5: Replay the three session-001 cases through the real checker**

Write this script to `/private/tmp/claude-501/-Users-labeaaa-Developer-cartyx-sim/032fcf68-1ec3-4b03-9f39-d7530e77db1d/scratchpad/replay-checker.ts`. It lives outside the repo and is throwaway.

```ts
import {
  basicPrompts,
  declarationsSinceDm,
  foldEvents,
  parseCheckerReply,
  verifyFindings,
} from '/Users/labeaaa/Developer/cartyx-sim/packages/core/src/index.ts';
import { OpenAICompatibleModelClient } from '/Users/labeaaa/Developer/cartyx-sim/packages/models/src/index.ts';
import { loadCampaign } from '/Users/labeaaa/Developer/cartyx-sim/apps/cli/src/campaign.ts';
import { JsonlFileSink } from '/Users/labeaaa/Developer/cartyx-sim/apps/cli/src/jsonl-sink.ts';

const root = '/Users/labeaaa/Developer/cartyx-sim';
const campaign = await loadCampaign(`${root}/campaigns`, 'avalon');
const client = new OpenAICompatibleModelClient(campaign.models);
const events = await new JsonlFileSink(
  `${root}/campaigns/avalon/sessions/001/events.jsonl`
).readAll();

// seq 21: invented dialogue for Kira, Mira, and Tomas (must be flagged).
// seq 37 and 66: narrate Kira's own declared actions (must pass).
for (const [seq, expectFlag] of [
  [21, true],
  [37, false],
  [66, false],
] as const) {
  const index = events.findIndex((event) => event.seq === seq);
  const narration = events[index]!;
  if (narration.type !== 'narration') throw new Error(`seq ${seq} is not a narration`);
  const before = events.slice(0, index);
  const state = foldEvents(before);
  const messages = basicPrompts.pcControlCheck({
    party: state.partyIds.map((id) => state.combatants[id]!.name),
    declarations: declarationsSinceDm(before, state),
    narration: narration.text,
  });
  for (let run = 1; run <= 3; run++) {
    const started = performance.now();
    const reply = await client.complete({
      seat: 'checker',
      turnId: `replay-${seq}-${run}`,
      messages,
      tools: [],
      toolChoice: 'auto',
    });
    const parsed = parseCheckerReply(reply.text);
    const verified = parsed ? verifyFindings(narration.text, parsed) : null;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `seq ${seq} run ${run}: ${seconds}s expected ${expectFlag ? 'FLAG' : 'PASS'} -> ` +
        (verified === null
          ? 'UNREADABLE'
          : `${verified.length} verified: ${verified.map((f) => `${f.pc}: ${f.sentence.slice(0, 50)}`).join(' | ')}`)
    );
  }
}
```

Run: `npm exec -- tsx /private/tmp/claude-501/-Users-labeaaa-Developer-cartyx-sim/032fcf68-1ec3-4b03-9f39-d7530e77db1d/scratchpad/replay-checker.ts`

Expected:

- **seq 21:** at least 1 verified finding in all 3 runs.
- **seq 37 and seq 66:** 0 verified findings in at least 2 of 3 runs each, since a borderline flag costs only a rewrite.
- **No `UNREADABLE`.**
- **Speed:** each check under about 5 s.

If this fails, stop and report before playing a session.

- [ ] **Step 6: Play a 10-minute session and check the success criteria**

```bash
npm run sim -- run --campaign avalon --session 2 --target-minutes 10 --seed 2
```

Then summarize it:

```bash
/opt/homebrew/bin/python3 - campaigns/avalon/sessions/002/events.jsonl <<'EOF'
import json, sys, collections
from datetime import datetime
ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ts = lambda e: datetime.fromisoformat(e["ts"].replace("Z", "+00:00"))
print("ending:", [(e["type"], e.get("reason") or e.get("kind")) for e in ev if e["type"] in ("session_end", "session_paused")])
print("pc-control flags:", collections.Counter(e["resolution"] for e in ev if e["type"] == "validator_flag" and e["rule"] == "dm_controls_pc"))
for e in ev:
    if e["type"] == "ooc_note": print("note:", e["text"][:200])
prev, dm = ts(ev[0]), []
for e in ev:
    if e["type"] == "turn_end":
        if e["actor"] == "dm": dm.append((ts(e) - prev).total_seconds())
        prev = ts(e)
print(f"DM turns: {len(dm)}, average {sum(dm) / max(len(dm), 1):.0f} s (2026-09-14 runs averaged about 20 s)")
print("--- narration ---")
for e in ev:
    if e["type"] == "narration": print(f"{e['seq']:3}", e["text"][:300].replace("\n", " "))
EOF
```

Success, from spec §9:

- **No player dialogue from the DM:** no narration writes a player character's dialogue. Read the narration list.
- **Real violations only:** each `re_prompted` and `trimmed` flag, and each cut-note, points at a real violation.
- **Speed:** the DM turn average is no more than about 5 s above the 2026-09-14 runs.
- **No pauses from the checker:** the ending is `session_end`, or any pause names a seat other than `checker`.

Report the results to the user with the flag counts, the notes, and the average DM turn time.
