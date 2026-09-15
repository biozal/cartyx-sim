# DM player-character control checker — Design

**Date:** 2026-09-14
**Status:** Implemented on `feat/dm-pc-control-checker`; live verification pending
**Related:** v1 design §5.6 Validators (`2026-09-13-cartyx-sim-v1-design.md`), roadmap "Heuristic validators" deviation and Plan 2C checker model (`../plans/2026-09-13-cartyx-sim-v1-roadmap.md`)

## 1. Problem

In the first 10-minute session on real hardware (campaign `avalon`, session 001), the DM repeatedly played the player characters. Its second narration wrote whole lines of dialogue for Kira, Mira, and Tomas and gave Tomas actions nobody declared. The existing `dm_controls_pc` validator flagged only once in the session, in the beat that resolved Mira's own declared action; the invented dialogue went through unflagged.

The validator is a verb list ("Kira says / draws / attacks…"). It misses verbs outside the list ("steps", "turns", "leans") and quoted speech set beside a name. A longer list cannot fix it, because the rule is not about wording: the DM may narrate a character carrying out the action its player declared ("Kira presses her palm flat against the stone"), and may not go beyond it.

## 2. The rule

The DM **may** describe a player character carrying out and experiencing the action that player declared, and the world's response to it, including effects on the character (being hit, knocked prone, a vision that comes to them).

The DM **must not** write a player character's dialogue, thoughts, feelings, or decisions, or have them do anything their player did not declare.

## 3. Evidence for the approach

A throwaway probe sent three real narrations from session 001 to local models, each with the players' declarations since the DM last spoke: the violating narration (invented dialogue for three PCs), a narration resolving Kira's declared palm-on-stone, and a narration resolving Kira's declared channeling that also introduces an NPC.

- **Thinking on** (GLM-4.7-Flash, Gemma 4 12B, Qwen3.6 35B): every model flagged exactly the invented dialogue and nothing in the two legitimate narrations. 7–34 s per check.
- **Thinking off** (`reasoning_effort: "none"`): 0.1–4 s per check. The violation was caught every time, but some replies flagged "sentences" that were not in the narration (copied from the player's declaration), one borderline sentence was flagged, and one reply ran out of tokens.

Verifying that each flagged sentence actually appears in the narration removes the invented-sentence false positives. The design is the checker plus that verification, with one retry before any cut so a borderline flag costs at most a rewrite. The first draft chose thinking off for speed. Sessions are generated offline and the session clock counts spoken words, so run time does not matter (decided 2026-09-15): the recommended configuration leaves thinking on, which was the most precise in the probe, with generous timeouts.

## 4. Configuration

The checker is an optional seat in `campaign.json`, configured and called like any other seat, so it gets timeouts, fallbacks, and `sim bench` coverage:

```json
"seats": {
  "dm": { "endpoint": "m5", "model": "qwen/qwen3.6-35b-a3b", "maxOutputTokens": 4000, "toolChoice": "auto" },
  "checker": {
    "endpoint": "ampere",
    "model": "glm-4.7-flash:latest",
    "temperature": 0.2,
    "maxOutputTokens": 4000,
    "timeoutMs": 300000,
    "fallbacks": [{ "endpoint": "m5", "model": "qwen/qwen3.6-35b-a3b" }]
  },
  "players": {
    "kira": { "endpoint": "m2", "model": "qwen3.8-27b-mlx", "maxOutputTokens": 2000 }
  }
}
```

Without `seats.checker`, the engine behaves exactly as it does today (fixtures, tests, and campaigns that do not want it).

## 5. Components

### 5.1 `packages/models`

- `SeatConfig` gains `reasoningEffort?: 'none' | 'low' | 'medium' | 'high'`. `OpenAICompatibleModelClient` passes it as `providerOptions: { cartyxSim: { reasoningEffort } }`, keyed by the camelCase provider name (the provider is `cartyx-sim`), which `@ai-sdk/openai-compatible` sends as `reasoning_effort`. Unset means the field is not sent. This also resolves the backlog item for a per-seat reasoning setting (which makes Muse Glimmer usable).
- A request with no tools already sends no `tools` or `tool_choice`; a test pins that.

### 5.2 `packages/core`

- **`pc-control.ts`** (new, pure):
  - `declarationsSinceDm(history, state)` (state supplies character names): the player characters' `dialogue`, `action`, and `pass` events after the DM's most recent `turn_end`, rendered as lines (`Kira Vale says: "…"`, `Kira Vale attempts: …`, `Kira Vale holds back.`). In combat this includes the declared action the DM is resolving.
  - `PcControlFinding`: `{ pc: string; sentence: string; why: string }`, with a zod schema for the checker reply `{ violations: PcControlFinding[] }`.
  - `parseCheckerReply(text)`: ignores closed `<think>…</think>` blocks (case-insensitive), then tries each "{" in order against each later "}" from last to first and returns the first candidate that parses as JSON of the reply shape, so code fences, surrounding text, stray braces, and a second object are tolerated. Returns the findings, or `null` when no candidate is readable.
  - `verifyFindings(narration, findings)`: keeps only findings whose sentence appears in the narration. Both are normalized alike: whitespace collapsed, straight/curly quotes treated alike, "…" read as "...", em and en dashes read as " - ", lowercased, and quote marks around the finding ignored. An occurrence counts only at word boundaries (it may not start or end inside a word). A finding is kept only if it occurs and is at least three words long or covers a whole narration sentence (quote marks aside), so a bare name or a short fragment such as "she nods" is dropped.
  - `cutSentences(narration, findings)`: removes the narration sentences a finding's text overlaps, wherever that full text occurs at word boundaries, using the same matching and keep rule as `verifyFindings` (so a finding that would be dropped cuts nothing). A finding spanning several sentences removes all of them, a finding that is one clause removes its whole sentence, and a sentence merely contained in a finding, such as an NPC's repeated `"Yes."`, stays unless the finding's occurrence overlaps it. Returns the remainder with paragraph breaks kept, or an empty string when nothing remains.
- **`prompts.ts`:** `PromptBuilder` gains `pcControlCheck({ party, declarations, narration })`, and `basicPrompts` implements it with the rule in §2 and the reply format. `DM_SYSTEM` gains: "Narrate the world and the results of what players declared. Never write a player character's dialogue, thoughts, feelings, or choices."
- **`events.ts`:** the `validator_flag` resolution enum gains `trimmed`.
- **`director.ts`:**
  - `DirectorConfig.seats` gains `checker?: string`; `DirectorConfig` gains `maxCheckerFailures?: number` (default 3).
  - The DM beat runs the check on every `narrate` call (§6). The checker is called through `deps.model.complete` directly with `tools: []` and `toolChoice: 'auto'`, not through the director's retry-and-pause wrapper.

### 5.3 `apps/cli`

- The campaign loader accepts an optional `seats.checker` (same fields as other seats, plus `reasoningEffort`, which every seat now accepts) and exposes it as seat id `checker` in `Campaign.seats` and `Campaign.models`.
- `sim run` passes the checker seat to the director.
- `sim bench` benchmarks the checker seat's reachability, model listing, and speed, with zero tool-call trials, so it passes when reachable.

### 5.4 Docs

`docs/running-a-session.md` gains a short checker section: what it does, the example seat, why it leaves thinking on and how `reasoningEffort` turns it off, and that it is optional.

### 5.5 Out of scope

- Checking `npc_say` lines and player turns.
- Context from earlier beats (the checker sees only this beat's declarations and the one narration).
- Lore contradiction checks (the Plan 2B/2C audit).
- Skipping the check for narrations that name no player character.

## 6. Flow for each `narrate` call in a DM beat

Applies both to the DM's own `narrate` calls and to prose the engine turns into a narrate call.

1. **Existing checks first.** The duplicate-narration check and `validateDmText` run as today. If either rejects the call (asks the DM to retry, or drops engine-made prose), the checker is not called. A narration `validateDmText` flags after its retries are used up is accepted with a flag and still goes through the checker; its `accepted_with_flag` flag is emitted only if the narration is then executed.
2. **Check.** If a checker seat is configured and not disabled for this run, send `pcControlCheck` with the party names, `declarationsSinceDm(history, state)`, and the narration text.
3. **Verify.** Parse the reply and keep verified findings. With none, the narration proceeds unchanged.
4. **First offense in the beat (the DM's own call only) → retry.** Nothing is narrated. The tool result names each verified sentence, its character, and the reason, and asks the DM to rewrite without them and call `narrate` again. Emit `validator_flag` (`seat: dm`, `rule: dm_controls_pc`, `resolution: re_prompted`). Later calls in the same response are not executed ("an earlier call was rejected"), as with other rejections. Each beat allows one such retry.
5. **Second offense in the beat, or engine-made prose → cut.** Narrate `cutSentences(narration, findings)` if it is not empty. Emit `validator_flag` with `resolution: trimmed` and a DM-only `ooc_note` listing each cut sentence with its character and reason. The tool result tells the DM what was removed. Later calls in the response still run.

The DM's rewrite is a new `narrate` call and goes through the whole flow again.

## 7. Failure handling

The checker never pauses a session. When it cannot give a verdict, the narration proceeds unchecked and the gap is logged.

| Failure                                                                             | Behavior                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every checker target errors or times out (the model client already tries fallbacks) | Narration proceeds unchecked. DM-only `ooc_note`: `Checker unavailable (<error>); narration not checked.` No retry delays.                                                                                                                                                                                                                                                          |
| Reply empty (no text, no tool calls) or cut off by the output-token limit           | A thinking checker sometimes spends its whole output budget thinking and returns nothing. The client (`incompleteReplyAttempts: 2`) retries the same target once, then tries each fallback the same way, before counting it as a failure; only once every target's attempts have failed (errors or incomplete replies) does it fall through to the "every target errors" row above. |
| Reply unreadable (no JSON, wrong shape)                                             | Narration proceeds unchecked. DM-only `ooc_note`: `Checker reply unreadable; narration not checked.`                                                                                                                                                                                                                                                                                |
| Findings present, none verified                                                     | Treated as clean. Nothing logged.                                                                                                                                                                                                                                                                                                                                                   |
| `maxCheckerFailures` consecutive failures                                           | The checker is disabled for the rest of this run, with one DM-only `ooc_note`. A resume starts with it enabled again. A successful check resets the count.                                                                                                                                                                                                                          |

## 8. Logging and state

- `validator_flag` `dm_controls_pc` with `re_prompted` (retry) or `trimmed` (cut), plus the DM-only `ooc_note` for cuts and checker failures. Clean checks are not logged.
- A retry also logs the DM's rejected draft in full, right after the `re_prompted` flag: `Rejected DM draft (dm_controls_pc): <the full narration text the DM sent>`. Retries, cuts, and unreadable replies also log the checker's raw reply text right after their existing note — `Checker reply: <raw reply text>` — so the checker's exact wording is kept for review even though only verified findings drive the outcome. A checker error with no reply (every target down or timed out) logs nothing beyond the existing `Checker unavailable (…)` note. A blank reply (`reply.trim() === ''`) is not logged as `Checker reply:` — there is nothing to review.
- All of it is DM-only: none of it reaches player prompts or playback, and it does not count as progress for the stalled-turn backstop.
- The one-retry budget is per beat and beats commit atomically, so resume needs no new state. The failure count and disabled flag live only in the running director.
- **Event schema version stays 1.** `session_start.schemaVersion` is `z.literal(1)`, so a bump would make every existing log unreadable. Adding `trimmed` is additive, as adding `re_prompted` was in Plan 2A: all existing logs stay valid. Only an older build reading a new log would fail, which is acceptable.

## 9. Testing

**Automated (no real models).** The checker seat is scripted with `ScriptedModelClient`.

- `pc-control.ts`:
  - `declarationsSinceDm` resets at each DM `turn_end` and includes dialogue, actions, passes, and a combat declaration.
  - `parseCheckerReply` handles plain JSON, fenced JSON, and extra text, and returns `null` for the wrong shape, cut-off JSON, and no JSON.
  - `verifyFindings` tolerates whitespace and quote-style differences and drops sentences not in the narration.
  - `cutSentences` handles a multi-sentence quote, keeps paragraph breaks, and returns empty when everything is cut.
- Prompt: `pcControlCheck` includes the party names, declarations, and narration.
- Director:
  - Clean narration passes with no flags.
  - A violation then a clean rewrite gives one `re_prompted` and one narration.
  - A second violation is `trimmed`: the remainder is narrated and a note lists the cut sentences.
  - A later offense in the same beat skips the retry.
  - Engine-made prose is cut without a retry, and the DM's real calls still run.
  - When everything is cut, nothing is narrated and the beat still reaches `hand_off`.
  - A checker error or unreadable reply leaves the narration unchecked with a note, and no pause.
  - `maxCheckerFailures` consecutive failures disable the checker with one note.
  - An unverified finding is ignored.
  - A `validateDmText` rejection skips the checker.
  - With no checker seat, behavior is unchanged and every existing test passes untouched.
- `models`: `reasoningEffort` is sent as `reasoning_effort` and omitted when unset; a no-tools request sends no `tools` or `tool_choice`.
- `cli`:
  - The loader accepts `seats.checker` and `reasoningEffort`, and names an unknown checker endpoint.
  - `sim run` passes the checker seat.
  - `sim bench` reports the checker seat with zero tool trials and passes it.
- Events: `trimmed` parses, and existing logs still load.

**Live (on the real machines, not in CI).**

1. Replay the three session-001 cases through the configured checker seat. The violating narration must be flagged; the two legitimate narrations must pass.
2. Play a 10-minute `avalon` session and read the transcript. Success means:
   - No narration writes a player character's dialogue.
   - Each `re_prompted` and `trimmed` flag points at a real violation.
   - The session has no checker-caused pauses.
3. Play a 10-minute session of the same party with no checker seat, and compare how often a player turn builds on words the DM wrote for a player character.
