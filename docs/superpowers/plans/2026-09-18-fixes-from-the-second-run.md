# Fixes from the second 1-hour run: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five findings session 006 left open (`docs/status.md`, "Second 1-hour run (session 006, 2026-09-18)"), so the third 1-hour run tests a table where combat is not a DM monologue and the seats waste no turns on tool shapes the engine could accept.

**Architecture:** Four small changes inside `packages/core` (director instructions, a player-side repeat check mirroring the DM's, tool argument coercion, one clock rule) and one prompt change in `packages/script`. No new packages, no schema version changes.

**Tech Stack:** TypeScript (ESM), zod, vitest, Prettier.

**Spec:** none; these are bounded fixes. The findings they close are numbered in `docs/status.md` under the session 006 section.

## Global Constraints

- Every commit passes `npm run typecheck`, `npm test`, and `npm run format:check`. Run `npx prettier --write <files>` before committing.
- The engine never writes prose, and it never drops a player's speech: a repeat is re-prompted, then accepted with a flag.
- `EVENT_SCHEMA_VERSION` and `SCRIPT_SCHEMA_VERSION` both stay 1. `LABEL_PROMPT_VERSION` goes from 3 to 4 (Task 4).
- Config and data files are JSON, never YAML. `campaigns/` is git-ignored: never commit anything under it.
- End commit messages with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Do not push, and do not run `npm run sim`.

---

### Task 1: Cap every combat beat, and refuse a fight after the hard stop (findings 1 and 4)

**Files:**

- Modify: `packages/core/src/director.ts` (`dmInstruction`), `packages/core/src/clock.ts` (`clockInstruction`), `packages/core/src/tools/combat.ts` (`start_combat`)
- Test: `packages/core/test/clock.test.ts`, the director tests that assert on instructions (find them with `grep -rl dmInstruction packages/core/test`), and the combat tool tests

**Finding 1 — combat is a DM monologue.** Task 3 of the previous plan added a three-sentence cap for `reason === 'monster'`. Apply the same sentence to `reason === 'resolve'` (resolving a PC's declared action) **only while combat is running** (`state.combat !== null`); a resolve outside combat keeps today's instruction. Keep the wording identical to the monster-turn sentence, so both read the same:

`Keep this turn's narration to at most three sentences: what the creature does and what it costs. Save detail for scene beats.`

For a resolve beat, say what it costs the player instead:

`Keep this turn's narration to at most three sentences: what the character's action achieves and what it costs. Save detail for scene beats.`

**Finding 4 — a fight started after the wrap-up steer.** Two changes:

1. `clockInstruction` for `wrap_up` becomes: `The session is nearing its time limit: start steering toward a satisfying cliffhanger, and do not start a new fight.`
2. `start_combat` throws a `ToolError` when the clock is at `hard_stop`: `Time is up: no new fight can start. Close the scene and call scene_change.` The tool needs the phase; look at how `ToolContext` is built in `director.ts` (`toolContext`) and pass what the tool needs — the same way `loreThreshold` is passed. Do not change the tool's arguments.

The `end_at_scene_break` phase keeps its current instruction (Task 1 of the previous plan already added `end_combat` to it) and still allows a fight to start, since that phase is reached before the hard stop.

- [ ] **Step 1: Write the failing tests**
  - A monster-turn instruction and an in-combat resolve instruction each contain the three-sentence sentence; a resolve outside combat contains neither.
  - The `wrap_up` instruction contains "do not start a new fight"; `running` does not.
  - `start_combat` throws at `hard_stop` and works at `end_at_scene_break` and below.
- [ ] **Step 2: Run** `npx vitest run packages/core`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): cap combat narration and refuse a fight after the hard stop`.

---

### Task 2: A player who repeats themselves is re-prompted once (finding 2)

**Files:**

- Modify: `packages/core/src/repeats.ts` (a second exported function), `packages/core/src/director.ts` (the player turn), `packages/core/src/prompts.ts` (the player instruction)
- Test: `packages/core/test/repeats.test.ts`, the player-turn director tests, `packages/core/test/prompts.test.ts`

**Interfaces:**

- Produces (`repeats.ts`):

```ts
/** The sentences of `text` this speaker has already said, normalized the same way `cutRepeats` does. */
export function repeatedSentences(text: string, earlierLines: readonly string[]): string[];
```

It reuses the same splitter and normalizer `cutRepeats` uses (whitespace collapsed, case-folded, quote marks and emphasis removed). A sentence counts as a repeat only on an exact normalized match, and only when it has 5 or more words, so "Agreed." and "I nod." never count.

**Director.** On a player's `speak` or `interject`:

- Gather that speaker's earlier public `dialogue` text from `this.history` (the whole session, not a window).
- If `repeatedSentences` is non-empty and this seat has not already been re-prompted this turn, re-prompt once with `You already said that this session: "<first repeat>". Say something new, in your own words.`, and flag `player_repeats_self` with resolution `re_prompted`.
- If the second reply still repeats, accept the line as it stands and flag `player_repeats_self` with resolution `accepted_with_flag`. **Never drop or trim a player's words.**
- Follow the existing player validator path (`validatePlayerText`, `player_controls_other`) for the flag and retry plumbing; do not invent a second mechanism.

**Prompt.** `basicPrompts.player`'s instruction gains: `Use fresh wording: do not reuse phrases or lines you have already said this session.`

- [ ] **Step 1: Write the failing tests**

```ts
it('finds a sentence the speaker already said', () => {
  expect(
    repeatedSentences('My numbers are what you breathe on. We move now.', [
      'My numbers are what you breathe on.',
    ])
  ).toEqual(['My numbers are what you breathe on.']);
});

it('ignores a short line and an unrelated one', () => {
  expect(repeatedSentences('Agreed.', ['Agreed.'])).toEqual([]);
  expect(repeatedSentences('We go left at the fork.', ['We go right at the fork.'])).toEqual([]);
});
```

Plus director tests: a player repeating an earlier line is re-prompted once and the new line is spoken; a player who repeats twice has the line spoken and flagged `accepted_with_flag`; a player's first use of a line is untouched.

- [ ] **Step 2: Run** `npx vitest run packages/core`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): re-prompt a player who repeats their own line`.

---

### Task 3: Accept the tool shapes models actually send (finding 3)

**Files:**

- Modify: `packages/core/src/events.ts` or wherever `HandOffTarget` is declared, `packages/core/src/tools/narrative.ts` and `player.ts` (emotion), `packages/core/src/tools/mechanics.ts` (attack lookup)
- Test: the tool tests for each, plus a director test per coercion

Three coercions, each of which must keep the strict shape working exactly as it does now:

1. **`hand_off` with a string.** `{ target: "party" }`, `"open"`, or `"kira"` are accepted as `{ kind: 'party' }`, `{ kind: 'open' }`, and `{ kind: 'pcs', ids: ['kira'] }`. Use a zod preprocess or union on the tool's argument schema, not a change to the `HandOffTarget` event type, so the logged event keeps its object shape. An unknown string still errors with the current message.
2. **An emotion outside the list.** `speak`, `interject`, `narrate`, and `npc_say` map an unrecognized emotion to `neutral` instead of failing. The engine records the emotion it used, never the model's invalid string. A missing emotion keeps whatever default it has today.
3. **A loosely named attack.** The attack lookup (used by the `attack` tool in `mechanics.ts`) matches, in order: an exact name; a case-insensitive name; a unique case-insensitive substring match in either direction (so "melee weapon attack" finds "Longsword" only when the combatant has exactly one attack, and "pickaxe" finds "Rusty Pickaxe"). Two or more matches, or none, keep today's error listing the known attacks — that error is what caught a character asking for a weapon they do not carry, so it must survive.

Leave `declare_spell` (no slot left) and `request_check` (missing `skill`) as they are: those are real rule violations.

- [ ] **Step 1: Write the failing tests**, one per coercion, each with its strict form still passing, plus: an unknown `hand_off` string errors; an ambiguous attack name errors listing the attacks; `"Longsword"` still fails for a character carrying only a Light Hammer.
- [ ] **Step 2: Run** `npx vitest run packages/core`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run packages/core packages/rules`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): accept the tool shapes models actually send`.

---

### Task 4: A read-aloud written quote is not speech (finding 5)

**Files:**

- Modify: `packages/script/src/attribution.ts`
- Test: `packages/script/test/attribution.test.ts`

In session 006 the DM read a diary entry aloud and the labeler gave it a speaker (`npc-diary-writer`). Add to `SYSTEM_PROMPT`, after the reported-speech rule:

`- "none" for words read from something written — a diary, a letter, a sign, a ledger, an inscription — even when a character reads them aloud.`

Set `LABEL_PROMPT_VERSION = 4`. Test that the prompt contains the rule and that the version is 4.

- [ ] **Step 1: Write the failing test.**
- [ ] **Step 2: Run** `npx vitest run packages/script`. Expected: it fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run packages/script`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(script): label a read-aloud written quote as none`.

---

### Task 5: Documentation

**Files:**

- Modify: `docs/status.md`, `docs/running-a-session.md`

- [ ] **Step 1:** In `docs/status.md`, add a "Fixes after the second run" list under the session 006 section, one line per finding 1–5, and update the test counts.
- [ ] **Step 2:** In `docs/running-a-session.md`, document the `player_repeats_self` flag, the tool coercions (so an operator reading a log knows why a loosely named attack worked), and the hard-stop rule for `start_combat`.
- [ ] **Step 3: Commit** `docs: record the fixes from the second 1-hour run`.
