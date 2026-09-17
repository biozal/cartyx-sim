# cartyx-sim status

_Last updated: 2026-09-17_

cartyx-sim is an autonomous D&D 5e simulation (one AI DM and four AI players on local models) built to test the Cartyx lore in `cartyx-lore`. It records a session as an event log, and later plans add voices, art, and a video-call-style playback page for recording. See the spec (`docs/superpowers/specs/2026-09-13-cartyx-sim-v1-design.md`) and the roadmap (`docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md`).

## Where things stand

| Plan                                                      | Status                                                  |
| --------------------------------------------------------- | ------------------------------------------------------- |
| 1 — Engine core                                           | Implemented, hardened, merged, pushed to GitHub         |
| 2A — Live models                                          | Implemented, reviewed, pushed; running on real hardware |
| 2B — Lore                                                 | Not written                                             |
| 2C — Characters, prep, and prompts                        | Not written                                             |
| 3 — Media production (art, voices)                        | Not written                                             |
| 4 — Playback page                                         | Not written                                             |
| Avalon Artificers Academy lore (rival school, Alpharetta) | Separate sub-project, not started                       |

**Repository:** `main` is pushed to GitHub.

**Checks on `feat/dm-pc-control-checker`:** `npm run typecheck`, `npm test` (56 files, 1006 tests plus 1 expected failure), and `npm run format:check` all pass.

## What works today

- **`sim run --fixture`**: plays a session against a scripted fixture model (Plan 1).
- **`sim run --campaign <id>`**: plays a session against real OpenAI-compatible endpoints (LM Studio, llama.cpp, mlx_lm, Ollama), with per-seat model, temperature, timeout, tool choice, and fallback endpoints. Every event is appended to `campaigns/<id>/sessions/NNN/events.jsonl`.
- **`sim bench --campaign <id>`**: checks each seat's reachability, whether the server lists the model, tokens per second, and tool-call reliability; saves a report under `campaigns/<id>/bench/` and exits 1 on failure.
- **Pause and resume**: seat failures and the runaway-loop backstop pause the session (exit code 2) with a logged `session_paused` event; `--resume` continues from the log with a fresh backstop budget.
- **Campaign config**: `campaign.json` (endpoints, seats) plus `characters/*.json`; an example lives in `apps/cli/examples/local-campaign/`.
- **`sim script --campaign <id> --session <n>`**: turns an event log into `script.json` (speaker-attributed, TTS-ready lines and cues) and `script.md` (a readable script); see `docs/running-a-session.md` §8.

Operator guide: `docs/running-a-session.md`.

## First real runs (2026-09-14)

The `avalon` campaign (git-ignored, under `campaigns/`) seats the DM and four players across four machines. All five seats pass `sim bench`, and two 5-minute sessions ran start to finish with no pauses, validator flags, repeated lines, or leaked markup.

| Seat  | Machine              | Server    | Model                        | Output tokens | Tool choice | Avg turn |
| ----- | -------------------- | --------- | ---------------------------- | ------------- | ----------- | -------- |
| DM    | M5 Max               | LM Studio | `qwen/qwen3.6-35b-a3b`       | 4000          | auto        | ~20 s    |
| kira  | Mac Studio M2 Ultra  | LM Studio | `qwen3.8-27b-mlx` (8-bit)    | 2000          | required    | ~40 s    |
| tomas | Mac Studio M2 Ultra  | LM Studio | `google/gemma-4-26b-a4b-qat` | 2000          | required    | ~25 s    |
| mira  | Ampere (RTX 3090)    | Ollama    | `glm-4.7-flash:latest`       | 2000          | required    | ~3 s     |
| bram  | Windows PC (5070 Ti) | LM Studio | `google/gemma-4-12b-qat`     | 2000          | required    | ~10 s    |

What the runs taught us:

- **Output tokens include thinking.** Qwen3.6 thinks 690–860 tokens before its first DM call, and Gemma 4 thinks 430–900 tokens on a player turn. At the original limits (800 and 400) those seats ran out mid-thought and paused the session.
- **LM Studio does not enforce `tool_choice: required`.** After a tool result, Qwen often narrates in plain text, so the DM seat uses `auto` (text becomes narration). Players stay on `required`, so Gemma's occasional garbled tool call is retried rather than spoken.
- **Rejected on the Ampere:** Gemma-4-31B-Storymaxxed (spills past 24 GB, ~4 tok/s), Cydonia-24B-v4 (writes Mistral tool calls Ollama cannot parse; no license), and Muse Glimmer (thinks past its limit on real turns unless `reasoning_effort` is `none`). GLM-4.7-Flash thinks briefly and calls tools reliably.
- **Engine fixes from the runs:** DM prose that arrives alongside tool calls is narrated (after those calls, before `hand_off`) instead of dropped; identical narration within one beat is skipped and flagged `duplicate_narration`; quote marks wrapped around a whole spoken line are removed; a "Hand off to …" line written in DM narration is removed and, when the DM made no hand_off call, treated as one.
- **The DM plays the players.** Session 001's DM wrote dialogue for three player characters; the verb-list validator missed it. An optional checker seat now reviews each narration (`docs/running-a-session.md` §7), and the verb-list rule yields to the checker once one is configured. Across three 10-minute sessions with the checker on (002–004) no narration wrote a player character's dialogue and every checker catch was a real violation; a checker-off control run reproduced the original failure, with the DM writing lines for three PCs and four later player turns building on them.

Lore lookups always report a gap until Plan 2B, so the DM invents and records details.

## Script stage on real sessions (2026-09-16)

`sim script` ran on avalon sessions 002–004 (labeling seat: `checker`, GLM-4.7-Flash) and on the checker-off control session. The control campaign had no checker seat, so a `script` seat with the same model was added to its `campaign.json`. With a labeling seat, no quote fell back to rules, and no script kept markdown, a `DM:` prefix, or a hand-off line.

| Session     | Voiced lines | Spoken words | Quotes labeled | Stage directions dropped | Unlisted NPC speakers                                          |
| ----------- | ------------ | ------------ | -------------- | ------------------------ | -------------------------------------------------------------- |
| avalon 002  | 47           | 1870         | 0              | 0                        | none                                                           |
| avalon 003  | 61           | 2074         | 1              | 6                        | `npc-faceless-figure`                                          |
| avalon 004  | 38           | 1937         | 0              | 1                        | none                                                           |
| control 001 | 71           | 2022         | 13             | 1                        | `npc-spice-merchant`, `npc-elderly-woman`, `npc-guard-captain` |

What the scripts show:

- **Stage directions:** all six of Kira's asides in 003 ("I keep my voice low…", "I let that sit for a beat.") were dropped from her lines and kept as asides in `script.md`; the spoken parts around them were kept whole. 004's stray trailing quote and 002's markdown are gone.
- **Embedded NPC speech:** 003's "You... opened... the door." became a line for a new speaker, `npc-faceless-figure`. The control session's merchant, elderly woman, and guard captain were each named from the narration.
- **DM-written player lines:** in the control session the model marked 7 quotes as a player character's words (Kira, Bram, Mira, Tomas), and each stayed in the DM's voice as `DM (as …)`. Two are flyers a PC reads aloud, which the DM narrated rather than invented dialogue.
- **Rules only:** without a model, every quote of three or more words goes to `npc-unnamed`, including the control session's DM-written player lines. The model is needed to catch those.
- **One awkward split:** "She mutters something about "outsiders bringing bad luck" and pulls her shawl tight" was labeled as the elderly woman's speech, so the sentence splits around a reported-speech fragment. The labeling prompt could treat a quote inside reported speech as `none`.

### Fixes after review

Before the 1-hour run, review of the script stage above turned up ten issues, now fixed:

1. The labeling prompt labels a quote inside reported speech as `none`, and `LABEL_PROMPT_VERSION` is now 3.
2. PC speech also splits when every quote is a sentence and every clause outside the quotes parses completely under a small fixed grammar: a speech tag ("she says", "I say quietly, drawing my blade") or a short gesture ("I nod slowly", "I glance at Bram"). Names must belong to the party or an introduced NPC, and a question is never a direction; anything else keeps the whole line voiced (spec §5.1). Five review rounds each found real speech the looser versions dropped.
3. An NPC the model named with `new:` before its `npc_introduced` event is promoted to the introduced NPC.
4. A hidden HP change uses core's `hpTrend`: equal values print no markdown line, and non-numbers read "condition changes".
5. Each `session_paused` event gets its own pause cue.
6. The invariants check that a voiced line's source event is public and that each dropped span's offsets and text match its source.
7. A label is cached under the key of the model that answered (`ModelResponse.model`).
8. `sim script --refresh` with no model labeling quotes (`--no-model`, or no `script`/`checker` seat) says so instead of doing nothing silently.
9. `sim script` reads the event log once, hashing the exact bytes it parses for `eventsSha256`, and writes `script.md` and `script.json` as a pair, with `script.json` last.
10. `sim run`, `sim bench`, and `sim script` print a clean error message and exit 1 on any other failure, with `SIM_DEBUG=1` for the stack.

## 1-hour run (session 005, 2026-09-17)

`sim run --campaign avalon --session 5 --target-minutes 60` ran for 80 minutes of wall time (much faster than the 10-minute runs) and ended with `session_end: target_reached` at 63.7 spoken minutes (9,548 words). The same seats as above passed `sim bench --trials 3` first. The log is in `campaigns/avalon/logs/session-005.log`.

| Measure                  | Result                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Events                   | 478; 3 scenes (tavern, streets, manor foyer); one combat of 5 rounds (5 mercenaries)                                                                                                                                           |
| Pauses                   | 1 at 49 min: `player-bram` (Gemma 4 12B) answered 4 times without a tool call; `--resume` continued cleanly                                                                                                                    |
| Clock                    | 80% steer at 62.9 wall min (spoken 48), 100% at 77.6 (spoken 60); the DM cut to the manor foyer at 62.4 spoken min and the session ended one turn later                                                                        |
| Word share               | DM 70%, Kira 12%, Mira 7%, Bram 5%, Tomas 4%, NPC Elias (via `npc_say`) 2%                                                                                                                                                     |
| Turn time (avg by third) | DM 43 / 83 / 71 s; Kira 80 / 86 / 47 s; Tomas 31 / 23 / 15 s; Bram 13 / 41 / 12 s; Mira 4–5 s                                                                                                                                  |
| DM prompt transcript     | Bounded by the 30-line window: 0.8k–15.6k characters, largest at 28 min when narrations were longest; no growth trend                                                                                                          |
| Validator flags          | 37: DM `tool_error` 12, `dm_controls_pc_checker` 13 (8 re-prompted, 5 trimmed), DM `invalid_tool_call` 5, player `invalid_tool_call` 6 (Mira 3, Tomas 3), `duplicate_narration` 1. The checker never failed or disabled itself |
| Lore                     | 3 lookups (all gaps, as expected before Plan 2B) and 4 inventions (the Old Stone Bridge, the salt-line ward, Warden Silas Thorne's paranoia, his manor)                                                                        |

What went wrong, most serious first:

1. **Players go silent in combat.** From spoken minute 40 to the end the DM had 96–98% of the words: player combat turns are an action and a roll, and the DM narrates each monster turn at length. Most of the clock went to combat narration.
2. **A downed PC is out for good.** Kira dropped to 0 HP in round 2 and got no further turns: there are no death saves, so downed PCs stay in the initiative order but are skipped. Her seat was silent for the last 40% of the session.
3. **Combat was never closed.** The DM resolved the fight in the story (the mercenary fled into the manor) and called `scene_change`, but never `end_combat`. `combat_turn` events continued after the cut, and the session ended in round 5 with combat still running.
4. **Prompt state leaked into narration.** Event 228 ends with a copy of the prompt's combatant list (`Kira Vale (id: kira) | HP 24/24, AC 15`, … monster HP and AC) and "It is Kira's turn." No validator caught it, and it is voiced in `script.md`.
5. **The DM repeats what players just said.** Event 114 re-narrates Tomas's, Mira's, and Kira's dialogue word for word. The checker allows this because the players did say it, so the script voices each line twice (the second time as `DM (as …)`).
6. **Near-duplicate narration within a beat.** At events 291 and 293 the DM narrated, a later call in the same batch failed with a tool error, and the DM re-sent a reworded version of the same narration. The exact-match duplicate check missed it, so two sentences were narrated twice.
7. **Continuity drift.** The DM introduced "The Innkeeper" of the Gilded Griffin (event 98) and 40 minutes later had him arrive at the manor with guards and call himself Silas's steward. The DM prompt lists NPCs by name only, so the description fell out of view once event 98 left the 30-line window.
8. **Tool errors leave no trace.** The DM's 12 tool errors and 5 invalid calls are flagged, but the error text is only sent back to the model, not logged, so they cannot be reviewed.
9. **Script speakers split in two.** The labeler named the innkeeper `new:innkeeper` before the DM introduced `npc-the-innkeeper`, so the script has both speakers (10 and 18 lines). It also named a combatant `npc-overhang-mercenary`, because the label request lists introduced NPCs but not monsters.
10. **Minor:** `record_invention` at event 167 carries the previous lookup's query; one of Bram's lines has an odd number of quote marks (the script removes them).

What went well: the checker kept catching DM-written player lines and thoughts (13 catches; 4 more quotes were labeled `DM (as …)` in the script), the DM voiced its main NPC with `npc_say` for the first time, nothing drifted in the transcript size or latency, and the resume after the pause was seamless.

Script output (`sim script`, labeling seat `checker`): 005 has 10,492 spoken words (the script also voices actions), 80 model labels, no rules fallbacks, and 22 dropped stage directions, all real (mostly Kira's parenthetical asides such as "(A small, steady smile.)"). The re-run scripts for 002–004 match the counts above; 003's unnamed speaker is now `npc-faceless-creature`, since the new prompt version missed the cache.

### Fixes after the run

All ten findings above are fixed on `feat/dm-pc-control-checker`:

1. **Players go silent in combat.** A monster turn's narration is capped at three sentences ("Keep this turn's narration to at most three sentences..."), and a player's prompt, on their own combat turn, now asks for "one short line in character as you act, unless silence fits the moment better."
2. **A downed PC is out for good.** Death saving throws are implemented (design: `docs/superpowers/specs/2026-09-17-death-saves-design.md`). A downed PC keeps its place in initiative and the engine rolls a d20 death save for them each round, with no model call: a natural 20 wakes them at 1 HP, a natural 1 counts as two failures, three failures kill, three successes stabilize (saves reset), and damage taken at 0 HP adds a failure (two on a critical); healing above 0 HP clears the tally. The DM's prompt marks a dying PC `DYING (death saves x/y)` and a stabilized one `STABLE at 0 HP`; the transcript, `PlayerView`, and `sim script`'s cues all show the roll and the running tally.
3. **Combat was never closed.** `scene_change` now throws (`Combat is still running. Call end_combat first, then scene_change.`) while combat is running; the clock's end-of-session instruction tells the DM to end combat before cutting the scene; and the director itself emits `combat_end` immediately before every `session_end` if combat is somehow still open, so a log can no longer end mid-fight.
4. **Prompt state leaked into narration.** A new `dm_state_leak` validator rule catches a combatant `(id: …)` reference, an `HP x/y` block, or an "It is `<name>`'s turn" line inside DM prose. Rather than rejecting the whole narration, the director strips just the offending lines (flagged `dm_state_leak`, resolution `trimmed`) and logs what it cut in a DM-only note.
5. **The DM repeats what players just said.** A new `repeated_text` validator rule (`cutRepeats`, `packages/core/src/repeats.ts`) drops any sentence of the DM's narration that, once case, whitespace, and quote/emphasis marks are normalized, quotes back four or more words of a player's recent line. A narration left with nothing after the cut is rejected, same as a fully-cut violation today.
6. **Near-duplicate narration within a beat.** The same `repeated_text` rule also drops a narration sentence that exactly matches (after the same normalization) a sentence the DM already narrated this beat, so a reworded resend after a tool error still loses any sentence it repeats verbatim from the first attempt.
7. **Continuity drift.** The DM prompt's NPC list now carries each NPC's description (`- <name> (npcId: <id>): <description>`, collapsed to one line and truncated to 200 characters), not just its name, so an NPC introduced many turns ago no longer disappears once it scrolls out of the transcript window.
8. **Tool errors leave no trace.** Every place the director flags `invalid_tool_call` or `tool_error` — the DM's prepare and execution failures, and the same two cases on the player path — now also writes a DM-only `ooc_note` (`Invalid tool call (<tool>): <message>` or `Tool error (<tool>): <message>`), so the errors show up in the log instead of only being sent back to the model.
9. **Script speakers split in two.** `sim script`'s label request now lists monster and NPC combatants alongside introduced NPCs, so a monster's line is attributed to its existing combatant id instead of inventing a new speaker; and `promote` now also merges an unlisted `new:` speaker into an introduced NPC whose id differs only by a leading article ("the"/"a"/"an"), rewriting any lines already drafted under the old id onto the merged one.
10. **Minor: stale invention query.** `record_invention` no longer takes a `query` from the model; it derives one from this turn's own lore lookup, if there was one, so a later invention no longer inherits an earlier turn's stale query.

## What Plan 2A added

- **Engine hardening:** a runaway-loop backstop (12 stalled turns, 3 idle hand-offs, 24 DM tool calls per beat), a validator flag for every DM outcome, a player-safe `PlayerView` for prompts, downed PCs kept in initiative, turn ids and tool choice on model requests, an event schema version, a Node-free typecheck for `core` and `rules`, and recovery from a torn final log line.
- **`models` package:** an OpenAI-compatible client with seat fallbacks and timeouts, and seat benchmarking.
- **CLI:** campaign loading, `sim bench`, and `sim run` against real endpoints.

## Hardware

| Machine              | Role today                        | Later                     |
| -------------------- | --------------------------------- | ------------------------- |
| M5 Max               | Engine and DM                     | OBS recording             |
| Mac Studio M2 Ultra  | Players kira and tomas            |                           |
| Ampere (RTX 3090)    | Player mira (Ollama)              | ComfyUI art after the run |
| Ampere (RTX 4070)    | Not used yet (Ollama sees ~24 GB) | Scribe; TTS               |
| Windows PC (5070 Ti) | Player bram                       |                           |
| Alienware            | Avoid (loud fans)                 |                           |

## Next steps

1. Fix what the 1-hour run broke (above), then re-run a 1-hour session.
2. Write Plan 2B (lore: ingest `cartyx-lore`, embeddings, `sim index`, `sim audit`).
3. Start the Avalon Artificers Academy lore expansion (in `cartyx-lore`) before Plan 2C, since chargen drafts the party from it. It can run alongside Plan 2B.
4. Write Plan 2C (SRD import, production prompts, scribe, `sim chargen`, `sim prep`, 5-minute smoke run), using the real-run findings above.
5. Optionally run the Plan 3 Ampere ARM64 spike (ComfyUI and TTS) early; it needs no code from Plans 1–2.

## Open backlog

The full list is in the roadmap's Backlog section. Highlights:

- **Plan 2B:** entity ids on lore hits; link lore inventions to their narration.
- **Plan 2C:**
  - a class field on PCs;
  - player target-id validation;
  - a sticky fallback for a timed-out primary;
  - `sim bench` checks fallback targets;
  - backstop limits exposed in `campaign.json`;
  - player prompts that keep stage directions out of `speak` (kira mixes them into quoted lines);
  - a `sim bench` tool trial realistic enough to expose thinking overflow (the dice-roll trial passes models that fail on real turns);
  - the script's quote-majority split can drop outside text that is speech (`"Who scouts first tonight?" We send Molly.`); consider applying the direction rule's clause check there too, after reviewing real sessions.
- **Unscheduled:**
  - director-side response validation retries the primary, not the fallbacks;
  - `ModelRequest.signal` is never set;
  - a seeded run's dice restart on resume;
  - kira's 8-bit Qwen3.8 is the slowest seat; a 4-bit build would roughly halve its turns;
  - plus the older cleanup items.
