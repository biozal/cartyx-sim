# Fixes from the 1-hour run: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix what session 005 exposed (`docs/status.md`, "1-hour run (session 005, 2026-09-17)") so the next 1-hour run is worth recording.

**Architecture:** Tasks 1–4 are small changes inside the existing engine units (`packages/core`: validators, director, prompts, tools) and `packages/script`. Task 5 implements death saves across `packages/rules`, `packages/core`, and `packages/script`, following its own spec.

**Tech Stack:** TypeScript (ESM), zod, vitest, Prettier.

**Spec:** `docs/superpowers/specs/2026-09-17-death-saves-design.md` (Task 5 only). Tasks 1–4 are bounded fixes with no spec; the findings they close are numbered in `docs/status.md`.

## Global Constraints

- Every commit passes `npm run typecheck`, `npm test`, and `npm run format:check`. Run `npx prettier --write <files>` before committing.
- The engine never writes prose: it only drops, trims, or rejects what a model wrote.
- `EVENT_SCHEMA_VERSION` stays 1. Adding `StateField` values is additive and deliberate.
- Config and data files are JSON, never YAML. `campaigns/` is git-ignored: never commit anything under it.
- End commit messages with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Do not push, and do not run `npm run sim`.

---

### Task 1: Close combat, and keep prompt state out of narration (findings 3 and 4)

**Files:**

- Modify: `packages/core/src/tools/narrative.ts` (the `scene_change` tool), `packages/core/src/director.ts` (session end, clock instruction), `packages/core/src/clock.ts` (instruction text), `packages/core/src/validators.ts`
- Test: `packages/core/test/tools-narrative.test.ts` (or whichever test file covers `scene_change`; find it with `grep -rl scene_change packages/core/test`), `packages/core/test/director-*.test.ts`, `packages/core/test/validators.test.ts`, `packages/core/test/clock.test.ts`

**Interfaces:**

- Produces: a `dm_state_leak` rule in `validateDmText`'s result type (the same shape as the existing rules).

**Finding 3 — combat is never closed.** Three changes:

1. `scene_change` throws a `ToolError` while combat is running: `Combat is still running. Call end_combat first, then scene_change.` (this mirrors `start_combat`'s existing "Combat is already running. Call end_combat first.").
2. `clockInstruction` for `end_at_scene_break` and `hard_stop` becomes: `Time is up: end combat with end_combat if a fight is running, close the current scene now, and call scene_change to cut to the cliffhanger.`
3. When the session ends with `state.combat` not null, the director emits a `combat_end` event before `session_end`, in the same turn. Put it where `session_end` is emitted, and cover it with a fixture test that ends the session mid-combat.

**Finding 4 — prompt state leaked into narration.** In `validators.ts`, add a rule `dm_state_leak` to `validateDmText`. A line of the narration is a leak when it matches any of:

- `/\(id:\s*[a-z0-9-]+\)/i`
- `/\bHP\s+\d+\s*\/\s*\d+/i`
- `/\bIt is [^.]{1,40}'s turn\b/i`

Follow the file's existing structure: it returns a violation the director turns into a rejection or a flag. Since a leak is mechanical, rejecting the whole narration wastes a DM turn; instead `validateDmText` returns the rule with a `strip` field naming the offending lines, and the director removes those lines from the narration (reusing the same path as the checker's `cutSentences` trim), flags `dm_state_leak` with resolution `trimmed`, and records a DM-only `ooc_note`: `Cut from DM narration (dm_state_leak): <the removed lines>`. If nothing is left, the call is rejected the way a fully cut narration already is.

- [ ] **Step 1: Write the failing tests**
  - `scene_change` during combat throws, and outside combat still works.
  - The 100% and 115% clock instructions mention `end_combat`.
  - A fixture session that reaches its target mid-combat logs `combat_end` immediately before `session_end`.
  - `validateDmText` flags the three leak shapes and leaves ordinary narration alone (including a line that merely says "HP" or mentions a turn without the state shape).
  - A director test: a `narrate` call whose text ends with a combatant block keeps the prose and drops the block, flags `dm_state_leak` as `trimmed`, and writes the note.
- [ ] **Step 2: Run** `npx vitest run packages/core`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run packages/core packages/script`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(core): close combat before a scene cut and strip prompt state from narration`.

---

### Task 2: Stop the DM repeating itself and the players (findings 5 and 6)

**Files:**

- Modify: `packages/core/src/director.ts` (the `narrate` path in `dmBeat`), and a new `packages/core/src/repeats.ts` for the pure logic
- Test: new `packages/core/test/repeats.test.ts`, plus the director tests

**Interfaces:**

- Produces (`repeats.ts`):

```ts
/** A sentence of `text` repeats when it was already narrated this beat, or quotes a player's recent line. */
export function cutRepeats(
  text: string,
  options: { narratedThisBeat: readonly string[]; recentPlayerLines: readonly string[] }
): { kept: string; removed: string[] };
```

Rules inside `cutRepeats`, all on whitespace-collapsed, case-folded text with quote marks and emphasis removed:

- Split `text` into sentences the same way the checker's `cutSentences` does (reuse that splitter; export it if it is private).
- A sentence is removed when its normalized form equals a sentence of any `narratedThisBeat` entry.
- A sentence is removed when it contains a quoted span (straight or curly) of 4 or more words whose normalized form appears in any `recentPlayerLines` entry.
- Everything else is kept. `kept` is the kept sentences joined with a single space, or `''` when nothing is left.

In `dmBeat`:

- Collect `narratedThisBeat` from the recorder's narration events (the existing `narratedThisBeat` helper covers the exact-match case; keep it and let `cutRepeats` handle partial repeats).
- Collect `recentPlayerLines` from `this.history`: the `text` of every public `dialogue` event after the last `turn_end` whose actor is the DM.
- Run `cutRepeats` after the checker's trim and before the tool executes. When something is removed, flag `repeated_text` with resolution `trimmed`, write a DM-only note `Cut from DM narration (repeated_text): <removed sentences>`, and narrate the kept text. When nothing is left, reject the call exactly as a fully cut narration is rejected today.

- [ ] **Step 1: Write the failing tests**

```ts
it('cuts a sentence the DM already narrated this beat', () => {
  const out = cutRepeats('The gate groans open. Rain hammers the stones.', {
    narratedThisBeat: ['Rain hammers the stones.'],
    recentPlayerLines: [],
  });
  expect(out).toEqual({ kept: 'The gate groans open.', removed: ['Rain hammers the stones.'] });
});

it("cuts a sentence that quotes a player's line back", () => {
  const out = cutRepeats('Tomas leans forward. "We do not have much time," he says.', {
    narratedThisBeat: [],
    recentPlayerLines: ['We do not have much time before it comes looking.'],
  });
  expect(out.kept).toBe('Tomas leans forward.');
});

it('keeps a short quote and unrelated text', () => {
  const out = cutRepeats('"Go," the guard says.', {
    narratedThisBeat: [],
    recentPlayerLines: ['Go'],
  });
  expect(out.removed).toEqual([]);
});
```

Plus director tests: a second narration repeating one sentence of the first is trimmed and flagged `repeated_text`; a narration that only repeats a player's line is rejected.

- [ ] **Step 2: Run** `npx vitest run packages/core`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(core): cut narration that repeats this beat or a player's line`.

---

### Task 3: Prompts — NPC descriptions, shorter monster turns, players speaking in combat (findings 7 and 1)

**Files:**

- Modify: `packages/core/src/prompts.ts`, `packages/core/src/director.ts` (`dmInstruction` for `reason === 'monster'`)
- Test: `packages/core/test/prompts.test.ts`, director tests that assert on instructions

**Changes:**

1. **NPC descriptions (finding 7).** The DM prompt's NPC list becomes `- <name> (npcId: <id>): <description>`, with the description collapsed to one line and truncated to 200 characters with `…`. `GameState.npcs` entries already carry a description; check the type and use it. An NPC with no description keeps today's line.
2. **Monster-turn brevity (finding 1).** `dmInstruction` for a monster turn appends: `Keep this turn's narration to at most three sentences: what the creature does and what it costs. Save detail for scene beats.`
3. **Players speak in combat (finding 1).** In `basicPrompts.player`, when the view says combat is running and it is this PC's turn, the instruction adds: `Say one short line in character as you act, unless silence fits the moment better.` Check `PlayerView` for the combat flag; if it does not expose whose turn it is, add that field (it already carries combat state) and cover it with a view test.

- [ ] **Step 1: Write the failing tests**
  - The DM prompt contains an NPC description, truncated at 200 characters with `…`.
  - A monster-turn instruction contains the three-sentence rule, and a normal beat does not.
  - A player prompt in combat, on that PC's turn, contains the one-line rule; out of combat it does not.
- [ ] **Step 2: Run** `npx vitest run packages/core`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): richer NPC context, shorter monster turns, player lines in combat`.

---

### Task 4: Traceability and script speakers (findings 8, 9, 10)

**Files:**

- Modify: `packages/core/src/director.ts` (tool-error notes), `packages/core/src/tools/narrative.ts` (`record_invention` query), `packages/script/src/build.ts` (label request, promotion)
- Test: `packages/core/test/director-*.test.ts`, the narrative tool tests, `packages/script/test/build.test.ts`

**Finding 8 — tool errors leave no trace.** In `dmBeat`, wherever the director flags `invalid_tool_call` or `tool_error` (three sites: the prepare failure, the execution failure, and the player path if it has one), also emit a DM-only `ooc_note`: `Tool error (<tool name>): <message>` and `Invalid tool call (<tool name>): <message>`. Keep the message the model receives unchanged.

**Finding 9 — script speakers split in two.** Two changes in `packages/script/src/build.ts`:

1. The label request's `npcs` list also includes non-PC combatants from `this.state.combatants` (`kind !== 'pc'`), as `{ id, name, description: 'a combatant in this fight' }`, so a monster's line is attributed to it instead of a new unlisted speaker. Introduced NPCs keep their own descriptions and come first.
2. `promote` also matches when the ids differ only by a leading article: compare `id.replace(/^npc-(the|a|an)-/, 'npc-')` on both sides. Keep the exact-id case as it is. Add a test: a `new:innkeeper` label followed by `npc_introduced` for `npc-the-innkeeper` leaves one speaker, named as introduced.

**Finding 10 — stale invention query.** In `record_invention`, the `query` recorded is the last lore lookup's query even when this invention has nothing to do with it. Look at the tool and context: record the query only when this invention followed that lookup in the same turn (the recorder's events hold the turn's lookups). If that is not knowable, make `query` optional and leave it out instead of attaching a stale one. Note in the report which you chose.

- [ ] **Step 1: Write the failing tests** for each of the three findings.
- [ ] **Step 2: Run** `npx vitest run packages/core packages/script`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run packages/core packages/script`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(core): log tool errors, and attribute monster lines in the script`.

---

### Task 5: Death saves (finding 2)

**Files:**

- Modify: `packages/rules/src/hp.ts`, `packages/rules/src/schemas.ts`, `packages/core/src/events.ts` (`StateField`), `packages/core/src/state.ts`, `packages/core/src/director.ts`, `packages/core/src/transcript.ts`, `packages/core/src/view.ts`, `packages/core/src/prompts.ts`, `packages/script/src/markdown.ts`
- Test: `packages/rules/test/hp.test.ts`, `packages/core/test/state.test.ts`, the director fixture tests, `packages/core/test/transcript.test.ts`, `packages/core/test/view.test.ts`, `packages/script/test/markdown.test.ts`

**Read the spec first:** `docs/superpowers/specs/2026-09-17-death-saves-design.md`. It gives the exact table of outcomes (§4), the turn flow (§5), what each seat sees (§6), the script cues (§7), and the test list (§8). Implement it as written.

Order of work, each with its tests first:

- [ ] **Step 1: Rules.** `deathSaves` and `stable` on `Combatant`; `rollDeathSave`, `failDeathSaves`; `applyDamage` at 0 HP; `applyHealing` clearing both. Tests: every row of §4's table, plus the `RulesError` cases.
- [ ] **Step 2: Run** `npx vitest run packages/rules`. Expected: PASS.
- [ ] **Step 3: State.** `isDying`, `takesTurn`, `advanceCombat`, the `death_save` case in `nextActor`, and the `StateField` additions. Tests per §8.
- [ ] **Step 4: Director.** The death-save turn: roll through `this.deps.rng`, the roll event, the state changes with `cause: 'death_save'`, `turn_end`, then advance. Test with the fixture model and a scripted RNG covering success, stabilization, revival on a 20, and death on the third failure.
- [ ] **Step 5: Seats.** `describeEvent` lines, `PlayerView`, and the DM party-block markers (§6).
- [ ] **Step 6: Script.** The two `state_change` cues in `markdown.ts` (§7).
- [ ] **Step 7: Run** `npm run typecheck && npm test && npm run format:check`. Expected: all pass.
- [ ] **Step 8: Commit** `feat(rules): death saving throws for downed player characters`.

---

### Task 6: Documentation

**Files:**

- Modify: `docs/status.md`, `docs/running-a-session.md`, `docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md`

- [ ] **Step 1:** In `docs/status.md`, under the 1-hour run section, add a "Fixes after the run" list saying what each of findings 1–10 now does, mark death saves as implemented, and update the test counts and the "Last updated" date.
- [ ] **Step 2:** In `docs/running-a-session.md`, document the new validator rules (`dm_state_leak`, `repeated_text`), the death-save turn (what appears in the log), and the tool-error notes.
- [ ] **Step 3:** In the roadmap, record death saves as delivered outside Plan 2C, with a pointer to the spec.
- [ ] **Step 4: Commit** `docs: record the fixes from the 1-hour run`.
