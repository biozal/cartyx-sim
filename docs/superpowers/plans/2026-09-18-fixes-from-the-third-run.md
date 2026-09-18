# Fixes from the third 1-hour run: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven findings from session 007 (`docs/status.md`, "Third 1-hour run (session 007, 2026-09-18)"), the worst of which puts monster HP and AC into the players' script.

**Architecture:** All changes are inside `packages/core`: the DM-text validator, one tool argument schema, two prompt builders, the spell-target lookup, and the repeat check. No schema version changes, no new packages.

**Tech Stack:** TypeScript (ESM), zod, vitest, Prettier.

**Spec:** none; these are bounded fixes. The v1 design's §5.5 (monster AC and HP never reach a player prompt or transcript) is the rule finding 1 breaks.

## Global Constraints

- Every commit passes `npm run typecheck`, `npm test`, and `npm run format:check`. Run `npx prettier --write <files>` before committing.
- The engine never writes prose, and it never drops a player's speech.
- `EVENT_SCHEMA_VERSION`, `SCRIPT_SCHEMA_VERSION` and `LABEL_PROMPT_VERSION` all stay as they are.
- Config and data files are JSON, never YAML. `campaigns/` is git-ignored: never commit anything under it.
- End commit messages with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Do not push, and do not run `npm run sim`.

---

### Task 1: Catch every shape of leaked prompt state (finding 1)

**Files:**

- Modify: `packages/core/src/validators.ts` (the `dm_state_leak` rule)
- Test: `packages/core/test/validators.test.ts`, and the director test that covers the strip

**What leaked in session 007**, all from real narration events:

```
**Current Status:**
- Kira: 20/24 HP (Dagger wound)
- All three Hooded Figures: 11 HP each, AC 12
6. Hooded Figure (3)
7. Kira Vale
[combat] Round 1: Kira Vale's turn
[hand_off]
{"target": {"kind": "party"}}
```

The current rule matches `(id: …)`, `HP 20/24`, and `It is X's turn`. Add these line shapes:

1. `/\d+\s*\/\s*\d+\s*HP\b/i` — the reversed form (`20/24 HP`).
2. `/\bAC\s+\d+\b/i` — an armour class readout. A line of ordinary prose that happens to say "AC" without a number is untouched.
3. `/^\s*\[(?:combat|roll|state|scene|npc|lore|invented|hand_off|ooc)\]/i` — a transcript tag line.
4. `/^\s*\[hand_off\]\s*$/i` followed by a JSON-looking line, and any line that is only a JSON object containing `"target"` or `"kind"` (`/^\s*\{.*"(?:target|kind)"\s*:/`).
5. `/^\s*\*\*Current Status:?\*\*\s*$/i` and `/^\s*Current Status:?\s*$/i` — the heading the DM wrote above its readout.

Keep the existing three patterns. The strip stays line-based, and everything else about the rule (trim, flag, DM-only note, reject when nothing is left) is unchanged.

- [ ] **Step 1: Write the failing tests.** One per new shape, taken verbatim from the block above, plus these must NOT be flagged: `"The room is quiet."`, `"He wears heavy plate, well cared for."`, `"She takes a hit and keeps her feet."`, `"The AC unit rattles."` (no number after AC).
- [ ] **Step 2: Run** `npx vitest run packages/core`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(core): strip every shape of leaked prompt state from narration`.

---

### Task 2: A malformed `hand_off` string is a shape error again (finding 2)

**Files:**

- Modify: `packages/core/src/tools/narrative.ts` (`HandOffTargetArg`)
- Test: the narrative tool tests

Session 007 twice sent `target: "<parameter=kind>\npcs"`, which the string coercion read as a list of player ids, so the model was told `Unknown player character ids: <parameter=kind>` — a confusing error about ids when the shape was wrong.

Accept a string only when, after trimming, it is exactly `party`, `open`, or a single id matching `/^[a-z0-9][a-z0-9-]*$/` (the id shape used everywhere else). Anything else fails with:

`hand_off target must be an object like {"kind": "party"}, {"kind": "open"}, or {"kind": "pcs", "ids": ["kira"]}.`

An unknown but well-formed id keeps today's `Unknown player character ids: …` message, which is the useful one.

- [ ] **Step 1: Write the failing tests.** `"party"`, `"open"` and `"kira"` still work; `"<parameter=kind>\npcs"`, `"party, open"` and `""` give the shape error; an unknown well-formed id (`"nobody"`) still gives the ids error; the object forms are untouched.
- [ ] **Step 2: Run** `npx vitest run packages/core`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(core): reject a malformed hand_off target as a shape error`.

---

### Task 3: Show the DM each character's attacks, and resolve an NPC id to its combatant (findings 3 and 4)

**Files:**

- Modify: `packages/core/src/prompts.ts` (`describeCombatant`), `packages/core/src/tools/mechanics.ts` (the spell/attack target lookup)
- Test: `packages/core/test/prompts.test.ts`, the mechanics tool tests

**Finding 3.** `describeCombatant` prints name, id, HP, AC and conditions. Add the attacks, since the DM invented "Shortsword", "Blade" and "Longsword" for characters carrying something else:

`- Kira Vale (id: kira) HP 24/24, AC 15, attacks: Light Hammer`

A combatant with no attacks says `attacks: none`. Keep the dying and stable markers the death-save work added, and keep the player-safe view unchanged (it must not gain monster attacks — check `view.ts` and its tests before touching anything shared).

**Finding 4.** `cast_spell` (and any other tool that resolves a target id through the same helper) failed with `Unknown combatant id "npc-silas-vane"` while the combatant was `silas-vane-1`. When a target id is not a combatant:

- if exactly one combatant's id starts with the NPC id with its `npc-` prefix removed (`npc-silas-vane` → `silas-vane` → `silas-vane-1`), use it;
- otherwise keep today's error listing the known ids.

Find the lookup rather than guessing: `grep -n "Unknown combatant id" packages/core/src`. Fix it in one place so every tool using it benefits.

- [ ] **Step 1: Write the failing tests.** The DM prompt shows a character's attacks and `attacks: none` for one without; the player view is unchanged; `npc-silas-vane` resolves to `silas-vane-1`; an NPC id matching two combatants still errors; an unrelated unknown id still errors.
- [ ] **Step 2: Run** `npx vitest run packages/core`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run packages/core packages/rules`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): show attacks in the DM prompt and resolve NPC ids to combatants`.

---

### Task 4: Catch a repeat across recent beats (finding 6)

**Files:**

- Modify: `packages/core/src/director.ts` (where `cutRepeats` is called)
- Test: the director tests that cover `repeated_text`

`cutRepeats` already takes `narratedThisBeat`. The DM repeated "The room is utterly silent." (events 56 and 78) and a two-sentence recap (605 and 632) across beats, so widen what is passed in: the narration text of this beat **plus the DM's narrations from the previous 3 committed beats**, taken from `this.history` (a beat is the span between `turn_end` events with `actor: 'dm'`).

Do not change `cutRepeats` itself, its flag, or its note. Keep the reject-when-nothing-is-left path. Name the widened list clearly (for example `recentNarrations`).

- [ ] **Step 1: Write the failing tests.** A sentence repeated from the previous beat is cut and flagged `repeated_text`; a sentence repeated from five beats ago is kept; the existing same-beat tests still pass.
- [ ] **Step 2: Run** `npx vitest run packages/core`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(core): cut narration that repeats a recent beat`.

---

### Task 5: Tune the checker prompt (finding 5)

**Files:**

- Modify: `packages/core/src/prompts.ts` (`PC_CONTROL_SYSTEM`)
- Test: `packages/core/test/prompts.test.ts`

The checker rejected or trimmed 27 narrations in session 007, four times session 006, many for the DM saying where a character stands or that a wound bleeds. The current prompt already says the DM may describe a character carrying out the declared action and the world's response; make the allowed side explicit, since that is where the false positives are:

Add, after the existing "may describe" sentence:

`Describing where a player character is, what their injuries and conditions look like, and what the world does to them is allowed, even when the player did not say it.`

And sharpen the forbidden side to what it is really about:

`A violation is the DM inventing a player character's words, thoughts, feelings, or decisions, or having them take an action their player did not declare.`

Keep every other line, the JSON reply format, and the rule name. Test that the prompt contains both new sentences.

The checker's catch rate is worth watching after this: session 006 had 7 flags, 007 had 27. Note the expectation in the commit message.

- [ ] **Step 1: Write the failing test.**
- [ ] **Step 2: Run** `npx vitest run packages/core`. Expected: it fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): let the checker allow position and injury description`.

---

### Task 6: Documentation

**Files:**

- Modify: `docs/status.md`, `docs/running-a-session.md`

- [ ] **Step 1:** In `docs/status.md`, add a "Fixes after the third run" list under the session 007 section, one line per finding 1–6 (finding 7, death saves never firing live, stays open — say so). Update the test counts, verified with `npm test`.
- [ ] **Step 2:** In `docs/running-a-session.md`, update the `dm_state_leak` description with the new shapes, the `hand_off` target error, the attacks line in the DM prompt, and the NPC-id resolution.
- [ ] **Step 3: Commit** `docs: record the fixes from the third 1-hour run`.
