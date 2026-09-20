# cartyx-sim status

_Last updated: 2026-09-19_

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

**Checks on `feat/dm-pc-control-checker`:** `npm run typecheck`, `npm test` (56 files, 1197 tests plus 1 expected failure), and `npm run format:check` all pass.

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

## Second 1-hour run (session 006, 2026-09-18)

The same command on the fixed engine (HEAD `dd50ea2`): 68.8 wall minutes, `session_end: target_reached` at 63.0 spoken minutes (9,444 words), **no pauses**. All six seats passed `sim bench` first, after the DM's LM Studio wedged mid-`GENERATING` and needed the model reloaded.

| Measure                    | 005                                                 | 006                                                                                                                          |
| -------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Wall time / spoken minutes | 80.5 / 63.7                                         | 68.8 / 63.0                                                                                                                  |
| Pauses                     | 1 (player-bram)                                     | none                                                                                                                         |
| DM share of words          | 70%                                                 | 64% (Kira 20%, Bram 7%, Mira 5%, Tomas 3%)                                                                                   |
| Combat                     | opened, never closed, ran past the end              | opened at 51.9 spoken min, closed at 61.2, then a scene cut                                                                  |
| Prompt-state leaks         | 1 voiced into the script                            | none (`dm_state_leak` never fired)                                                                                           |
| Repeated narration         | 2 duplicated sentences, 3 re-quoted player lines    | `repeated_text` trimmed 5 narrations, including two echoes of the prompt's "What do you do?"                                 |
| Checker                    | 13 catches                                          | 7 catches (5 re-prompted, 2 trimmed)                                                                                         |
| Script                     | 1 NPC split in two, 1 monster invented as a speaker | 4 unlisted NPC speakers, all genuinely never introduced; no notes, no rules fallbacks, 38 dropped stage directions, all real |

The fixes hold: combat closes, no state leaked, the DM stopped repeating itself and the players, tool errors are now in the log, and the script needed no fallback. Death saves never fired, because no PC dropped to 0 HP.

What the run still shows:

1. **Combat is still a DM monologue.** Over the session the DM is down to 64%, but in the last 20 spoken minutes (the fight) it is 88% and then 99%. The three-sentence cap applies to monster turns; resolving a PC's declared action has no cap, and each fight round still costs far more DM words than player words.
2. **Players repeat themselves.** `repeated_text` only watches the DM. Kira reuses her own phrasing across the session: "my voice stays low and flat" (3 events), "voice low and even as stone" (5), and one sentence verbatim twice ("My numbers are what you breathe on — same rule as the drip.").
3. **The tool errors we can now see are mostly avoidable.** 15 re-prompts came from shapes the engine could accept or correct: `hand_off` with a string instead of `{kind}` (4), an emotion outside the enum (3), an attack named loosely ("melee weapon attack", Kira asking for a "Longsword" when she carries a Light Hammer, Mira a "rapier") (4), `declare_spell` with no slot left (2), `request_check` missing `skill` (1). Each one costs a re-prompt and a retry.
4. **A fight started after the wrap-up steer,** at 51.9 of 60 spoken minutes, and needed 9 minutes to finish. It landed, but the clock had no say in whether a new fight should begin that late.
5. **Minor:** a quote from a diary the DM read aloud became a speaker (`npc-diary-writer`) rather than `none`.

### Fixes after the second run

All five findings above are fixed on `feat/dm-pc-control-checker`:

1. **Combat is still a DM monologue.** The three-sentence narration cap that already applied to a monster's turn now also applies when the DM resolves a PC's declared combat action while combat is running ("Keep this turn's narration to at most three sentences: what the character's action achieves and what it costs. Save detail for scene beats."), so a round no longer lets the DM spend unlimited words narrating the player's own action.
2. **Players repeat themselves.** A new `player_repeats_self` check compares a `speak`/`interject` line against every public dialogue line that PC has spoken this session (not just the recent window), catching a 5-word-or-longer sentence that exactly repeats (after case/whitespace normalization) one already said. The first repeat in a turn is re-prompted, as long as the turn still has a re-prompt left ("You already said that this session: \"<sentence>\". Say something new, in your own words."); a repeat that survives that one re-prompt, or that happens after the turn's re-prompts are already spent, is still spoken exactly as given — a repeated line is never dropped or trimmed — but the turn is flagged `player_repeats_self`. The player system prompt also now asks for fresh wording.
3. **The tool errors we can now see are mostly avoidable — the genuine shape mismatches are fixed.** `hand_off` now accepts a bare string ("party", "open", or a player character id) alongside the `{kind}` object form; an emotion outside the fixed list is coerced to "neutral" instead of failing the call; and attack-name matching now accepts, after an exact name and a case-insensitive name, a unique case-insensitive substring match in either direction ("pickaxe" finds "Rusty Pickaxe"). A generic phrase such as "melee weapon attack" still errors, deliberately: accepting it by falling back to a combatant's only attack would also accept a wrong weapon name (the DM asking Kira for a longsword when she carries a Light Hammer), which is an error worth keeping. `declare_spell` with no slot left and `request_check` missing `skill` are unchanged — those are real errors, not shape mismatches.
4. **A fight started after the wrap-up steer.** The `wrap_up` clock instruction now tells the DM outright not to start a new fight, and once the clock reaches `hard_stop`, `start_combat` itself refuses ("Time is up: no new fight can start. Close the scene and call scene_change.") rather than relying on instruction wording alone.
5. **Minor: a read-aloud diary quote became a speaker.** The script labeling prompt's rules now include: "'none' for words read from something written — a diary, a letter, a sign, a ledger, an inscription — even when a character reads them aloud." `LABEL_PROMPT_VERSION` is bumped 3 → 4 so old cached labels aren't reused.

## Third 1-hour run (session 007, 2026-09-18)

Run on HEAD `9e8cd89`, after the second batch of fixes. It reached `target_reached` at 60.7 spoken minutes, but took **154 wall minutes** and paused once when the Ampere machine (Mira's seat, the checker's primary) dropped off the network for half an hour; `--resume` continued cleanly once it was back.

| Measure               | 005         | 006         | 007                 |
| --------------------- | ----------- | ----------- | ------------------- |
| Wall / spoken minutes | 80.5 / 63.7 | 68.8 / 63.0 | 154.4 / 60.7        |
| Pauses                | 1 (seat)    | none        | 1 (machine offline) |
| DM share              | 70%         | 64%         | 72%                 |
| Fights                | 1           | 1           | 3                   |
| Checker flags         | 13          | 7           | 27                  |
| Tool errors           | 12          | 5           | 19                  |

The session was combat-heavy (three fights, 77 rolls), which explains part of the DM share, but the wall-clock cost and the flag counts point at real problems:

1. **Prompt state still reaches the story, in shapes the strip does not match.** Event 108 narrates an initiative list plus `**Current Status:** - Kira: 20/24 HP (Dagger wound)` and `All three Hooded Figures: 11 HP each, AC 12`, and several beats end with `[combat] Round 1: Kira Vale's turn` or `[hand_off]` followed by the raw JSON. `dm_state_leak` matches `HP 20/24`, not `20/24 HP`, and knows nothing about the transcript's `[tag]` lines. All of it is voiced in `script.md` (lines 193–197, 245–259) — and monster HP and AC reaching players breaks the hidden-stat rule (v1 design §5.5).
2. **The `hand_off` string coercion accepts nonsense.** Twice the DM sent a malformed string (`<parameter=kind>\npcs`), which the coercion read as a list of player ids, so the error came back as `Unknown player character ids: <parameter=kind>` instead of saying the shape was wrong.
3. **The DM invents weapons its characters do not carry** (`Mira … no attack named "Shortsword"`, `Bram … "Blade"`, `Mira … "Longsword"`). The party block in the DM prompt lists HP, AC and conditions, but not each character's attacks, so there is nothing to copy from.
4. **A spell aimed at an NPC id fails.** `cast_spell` was called with `npc-silas-vane` while the combatant was `silas-vane-1`; the engine lists valid ids but does not resolve the NPC to its combatant.
5. **The checker rejected or trimmed 27 narrations**, four times as many as session 006, many of them the DM describing where a character is standing or that a wound is bleeding. Each rejection costs a DM turn, and the run's wall time shows it.
6. **The DM repeats itself across beats.** `cutRepeats` only compares within one beat, so "The room is utterly silent." (events 56 and 78) and a two-sentence recap (605 and 632) were narrated twice.
7. **Death saves have still never fired in a live run.** Kira dropped to 11 HP at the lowest.

The script stage itself held up: 41 model labels, no rules fallbacks, no notes, and only 5 stage directions dropped (the players wrote fewer asides this time).

### Fixes after the third run

Findings 1–6 above are fixed on `feat/dm-pc-control-checker`; finding 7 (death saves) is **not** — they have still never fired in a live run.

1. **Prompt state still reaches the story, in shapes the strip does not match.** `dm_state_leak` now also catches the reversed `20/24 HP` form, a bare `AC 12` readout, a `[combat]`/`[roll]`/`[state]`/`[scene]`/`[npc]`/`[lore]`/`[invented]`/`[hand_off]`/`[ooc]` transcript tag line, a `{"target": …}`/`{"kind": …}` JSON line, and the `**Current Status:**` heading (bold or plain, with or without a colon) — five new line-shape patterns alongside the three it already had.
2. **The `hand_off` string coercion accepts nonsense.** A bare string is now accepted only when, trimmed, it is exactly `party`, `open`, or a single id shaped like `kira` (`/^[a-z0-9][a-z0-9-]*$/`); anything else — including the garbled `<parameter=kind>\npcs` the DM actually sent — fails with a shape error naming the object forms, instead of being misread as an unknown player id.
3. **The DM invents weapons its characters do not carry.** `describeCombatant` now lists each combatant's attack names (`attacks: Light Hammer`, or `attacks: none`), so the DM prompt's party block gives it something to copy from.
4. **A spell aimed at an NPC id fails.** The shared `getCombatant` lookup (used by every tool, including `cast_spell`) now resolves an id like `npc-silas-vane` to the one combatant whose id starts with `silas-vane`, when exactly one matches; two or more matches, or no match, still give today's "Unknown combatant id" error.
5. **The checker rejected or trimmed 27 narrations.** The checker prompt now says outright that describing a player character's position, injuries, and conditions is allowed even when the player didn't say so, and narrows a violation to the DM inventing a PC's words, thoughts, feelings, or decisions, or having them act without their player declaring it. Whether this brings the catch rate back down (7 in session 006, 27 in 007) is worth watching on the next run.
6. **The DM repeats itself across beats.** The repeat check that already caught a sentence repeated within one beat now also checks the DM's narration from the previous 3 committed beats, so a sentence like "The room is utterly silent." repeated one beat later is cut and flagged `repeated_text`; a repeat from five beats back is out of the window and kept.

## Fourth 1-hour run (session 008, 2026-09-19)

Run on HEAD `d083871`, after the third batch of fixes. It reached `target_reached` in **63 wall minutes** (the fastest of the four) with no pauses; every seat benched 5/5 beforehand.

| Measure               | 005         | 006         | 007                 | 008        |
| --------------------- | ----------- | ----------- | ------------------- | ---------- |
| Wall / spoken minutes | 80.5 / 63.7 | 68.8 / 63.0 | 154.4 / 60.7        | 63.1 / ~65 |
| Pauses                | 1 (seat)    | none        | 1 (machine offline) | none       |
| DM share              | 70%         | 64%         | 72%                 | 71%        |
| Fights                | 1           | 1           | 3                   | 1 (+1 cut) |
| Checker flags         | 13          | 7           | 27                  | 10         |
| Tool errors           | 12          | 5           | 19                  | 2          |

The third batch held: checker flags fell from 27 to 10, tool errors from 19 to 2, no `[tag]` or JSON line leaked, and no weapon was invented. The script stage gave 72 model labels, no rules fallbacks, and dropped 12 stage directions. Findings:

1. **Hit points and turn order still reach the story in prose.** "its health dwindled to 9 out of 22 hit points", "it drops to just 3 hit points" (monster HP, which players must never hear), and "Bram's HP rises to 19/28" were all voiced, and so were two full initiative readouts (`**Initiative Order:**` with `1. Bram Holloway (21)` … and "Initiative is rolled. The order of combat is as follows:" with seven numbered names).
2. **A correct leak cut took a whole paragraph.** "…bringing him to 19/28 HP." ended a five-sentence paragraph on Silas dressing Bram's wound, and `dm_state_leak` strips whole lines, so all five sentences went (the backlog item, now seen live).
3. **The checker flags NPCs as player characters.** Two of its 10 flags were about Silas Vane ("Silas remains poised, his dagger ready…"), costing a rewrite and a cut. The other 8 were real, the DM writing PC lines ("Contact!" Bram shouts; "Clear," Kira calls back).
4. **A fight started in the closing beat.** Past the target, the DM called `scene_change` and then `start_combat` in the same turn; the session ended at that scene change with initiative rolled and no round played. `start_combat` was refused only past 115%.
5. **A repeat cut broke an NPC's quote.** The DM re-narrated Borin's line; cutting its repeated first and last sentences also cut the quote marks, so "That place... it's been quiet. Too quiet." was voiced as DM narration.
6. **`request_check` for an NPC outside combat** failed with a bare "Unknown combatant id" (the DM recovered on its own).
7. **Death saves have still never fired live.** Bram's 15/28 was the lowest anyone fell.

### Fixes after the fourth run

Findings 1–6 are fixed (`bc334ff..656f4ce`); finding 7 is still open.

1. **Hit points and turn order in prose.** `dm_state_leak` now catches hit-point readouts (`HP rises to 19/28`, `9 out of 22 hit points`, `to just 3 hit points`, `4 hit points left`) and turn-order sentences (`initiative order`, `order of combat`, `initiative is rolled`, `Initiative:`), and removes turn-order entries as whole lines: a numbered item that is only a combatant's name (`1. Mira Ashdown`, `3. Shadow Stalker #3`) or a name followed by its initiative (`2. Hooded Figure (2)`, `Kira Vale — 18`). Left alone on purpose: "Kira loses 3 hit points." (the mechanics rule's), "drops to 0 hit points" (a PC going down is public), "order of battle", "turn order", and bulleted names with no number. Replaying the strip over sessions 005–008 removes only real leaks.
2. **Whole-paragraph cuts.** Leaks are now stripped one sentence at a time, and a quote mark the cut sentence held is added back to the speech around it. Only the `Current Status` heading and turn-order entries go as whole lines. Sentence splitting no longer breaks after a title (`Mr.`, `St.`, `Dr.` …), so a cut never strands one.
3. **Checker findings about NPCs.** A finding counts only when it names a party member — an id, or any name word of three or more letters, however written (`Kira Vale's`, `kira-vale`) — and is not exactly an NPC's name.
4. **A fight in the closing beat.** `start_combat` is refused from 100% of the target on, not only past 115%.
5. **Broken quotes after a repeat cut.** `cutRepeats` adds back a quote mark a cut sentence held, in the style of the mark that opened that quote.
6. **Tools aimed at an NPC outside combat.** The error now says the NPC is not a combatant and has no stats, and tells the DM to decide what happens in narration or add them with `start_combat`.

The batch had one review; its findings (a leak cut breaking quotes, over-broad `order of battle`/`0 hit points`/bulleted-name matches, titles splitting sentences, exact-only checker name matching, turn-order shapes missed) are fixed in the follow-up commit.

## Eighth 1-hour run (session 012, 2026-09-20)

Run on HEAD `e81074d`, the first under the one-fight rule. It ran 60 wall minutes with no pauses and ended at **`hard_stop`**, not `target_reached`: the DM never closed the scene.

| Measure               | 010      | 011      | 012      |
| --------------------- | -------- | -------- | -------- |
| Wall / spoken minutes | 77 / ~64 | 86 / ~66 | 60 / ~74 |
| Pauses                | none     | none     | none     |
| DM share              | 66%      | 67%      | **79%**  |
| Fights                | 0        | 2        | 1        |
| Checker flags         | 6        | 12       | 8        |
| Tool errors           | 2        | 11       | 1        |

**The new rules did their job.** The one-action-per-turn rule refused Kira attacking twice and was the session's only tool error; the fight ran clean. The one fight that happened was the session's only one, and the DM never pushed for another, so the one-fight rule cost nothing. No retelling reached the players.

**The session got worse in another way.** Findings:

1. **The DM took 79% of the words**, narrating 187 words a beat against the players' 50, for 8,796 words of narration against a usual ~6,400.
2. **One scene for the whole session**, where 008–011 had two or three.
3. **It never closed.** The DM narrated past the closing instruction for 14 spoken minutes until the hard stop cut the session mid-scene.
4. **"\*\*hand_off\*\* to the party." was voiced** — the tool call in bold, which the sentence-start pattern missed.
5. **The DM apologized to the engine, in the script**: "My apologies for the error. Let me correct the narration of Kira's turn."

Whether 1–3 follow from the one-fight rule is unproven, but the shape fits: with combat off the table, the DM filled the time with prose instead of handing over.

### Fixes after the eighth run

All five are fixed (`5cc2095..912f2e3`).

1. Past 3,000 words and a 78% share, the DM is told its share and asked for two or three sentences, on scene beats only. Replaying 005–012 word by word, only 012 trips it.
2. — (see 3: the closing press is what moves a session on).
3. Past the target, the closing instruction is repeated as its own message after each step instead of sitting at the end of a long prompt; once the scene is cut it becomes "call hand_off now", so no second scene change.
4. `dm_state_leak` strips a sentence opening with a bold or backticked tool name.
5. It also strips meta-talk that names what went wrong ("My apologies for the error."), while a correction introduced after a colon keeps its correction, and an NPC's "My apologies, my lady" is untouched.

The review of this batch also caught two traps in the one-fight rule itself: `start_combat` still told a mid-fight DM to call `end_combat` first, which would have destroyed the fight it meant to extend, and a refused `start_combat` threw away the narration and `hand_off` sent with it — a beat that contributes nothing. Its refusals are now recoverable: the rest of the response still runs.

## Seventh 1-hour run (session 011, 2026-09-19)

Run on HEAD `80ac5e0`, after the sixth batch of fixes. It reached `target_reached` at ~66 spoken minutes in **86 wall minutes** with no pauses.

| Measure               | 009      | 010      | 011      |
| --------------------- | -------- | -------- | -------- |
| Wall / spoken minutes | 83 / ~65 | 77 / ~64 | 86 / ~66 |
| Pauses                | 1        | none     | none     |
| DM share              | 65%      | 66%      | 67%      |
| Fights                | 1        | 0        | 2        |
| Checker flags         | 13       | 6        | 12       |
| Tool errors           | 7        | 2        | 11       |

**No retelling was flagged and no turn hit the retell cap**, so the sixth batch cost nothing; one turn still hit the step limit, for the reason in finding 1. The leak strip caught six leaks before they were voiced, including four hit-point readouts in the DM's own words. Findings:

1. **A monster attacked four times in one round.** `giant-rat-5` bit Kira at seq 286, 294, 301 and 314 — once out of turn (Mira held the spotlight) and three more times on its own turn — taking her from 24 HP to 6, while the DM also narrated another rat's turn in between. Nothing tied an action to the initiative order or counted how many a combatant had taken. This also drove that turn into the step limit.
2. **Four hand-offs to monsters.** The DM tried to pass the spotlight to `giant-rat-2`/`giant-rat-3` when initiative said they were next.
3. **Items spent that nobody carried.** Three `remove_item` errors for a glass vial and a potion of healing: the party files give the PCs no inventory, and the DM prompt never listed it.
4. **Two voiced turn announcements.** "Giant Rat 2's turn is complete. Giant Rat 3's turn is complete." and "Giant Rat 3, it is your turn." — the DM's own wording, which the engine-phrasing pattern missed.
5. **Four of twelve checker flags cut a miss.** "Mira twists away", "she sidesteps", "Mira's form blurs just out of reach" — the DM describing an enemy's attack missing.
6. **Death saves have still never fired live.** Kira reached 6/24, the closest yet, in two fights.

### Fixes after the seventh run

Findings 1–5 are fixed (`7b4d55d..HEAD`); finding 6 is still open. The review caught that the first version of fix 1 restricted **who** could act but not **how often**, so it stopped only one of the four bites; the per-turn count came out of that.

1. `attack` and `cast_spell` refuse anyone but the combatant whose turn it is, **and a second action on the same turn**, since the engine models no multiattack. The turn is counted from the last `combat_turn` (or `combat_start`) across the log, so an ambusher who attacks in the beat that starts the fight cannot attack again in the next beat before initiative moves on. A combatant outside the initiative order — a trap or a watching NPC — is not gated. Replaying sessions 007–011, the rule refuses 16 out-of-turn attacks and no legitimate one.
2. In combat, a `hand_off` naming only combatants is taken as a hand-off to the party, since initiative decides who acts next.
3. The DM prompt lists each combatant's carried items beside its attacks (players see their own too), and the `remove_item` error names what the character does carry. **Worth deciding:** only Kira and Mira carry anything in the Avalon party files (a healing potion each); Bram and Tomas carry nothing, which is why the DM reached for a vial that did not exist.
4. `dm_state_leak` strips "<Name>'s turn is complete/over/done/finished", anchored to a capitalized name or a number so prose like "before its turn is complete the rope snaps" survives. Table talk like "Kira, it is your turn. What do you do?" stays, since a DM says that aloud at a real table.
5. The checker prompt allows a miss told as the character avoiding it (twisting away, ducking, catching it on a shield), because the dice decided the miss; words, thoughts, decisions, or an action of the character's own are still violations.

## Sixth 1-hour run (session 010, 2026-09-19)

Run on HEAD `95785ad`, after the fifth batch of fixes. It reached `target_reached` at ~64 spoken minutes in **77 wall minutes** with no pauses (the Ampere stayed up).

| Measure               | 008        | 009                 | 010      |
| --------------------- | ---------- | ------------------- | -------- |
| Wall / spoken minutes | 63.1 / ~65 | 83 / ~65            | 77 / ~64 |
| Pauses                | none       | 1 (machine offline) | none     |
| DM share              | 71%        | 65%                 | 66%      |
| Fights                | 1 (+1 cut) | 1                   | 0        |
| Checker flags         | 10         | 13                  | 6        |
| Tool errors           | 2          | 7                   | 2        |

A puzzle session at a monolith and a chasm, with no fight, so the combat-side fixes were not exercised and death saves had no chance to fire. No HP, AC, health, or initiative readout was voiced, no `hand_off` went to a monster, and the script stage gave 17 model labels with no fallbacks and 6 stage directions dropped. Findings:

1. **The DM retold one moment seven times in a turn.** Kira counting "One... two... three!" and stepping toward the monolith was narrated seven times, each in new words, until the DM hit its 24-call limit and the engine forced a hand-off (`dm_step_limit`); it also rolled the same two Perception checks twice. Exact-sentence repeat cuts (12 this run) trimmed pieces but let every paraphrase through, and the tool reply "Narrated. Removed repeated sentences: …" seemed to invite another try. Replaying sessions 005–010 found the same loop in 007 (one miss told seven ways) and single retellings in every session.
2. **A tool call written as bare lines was voiced.** Two narrations ended in `hand_off` and `target: party` on their own lines; the script voiced "hand_off target: party."

### Fixes after the sixth run

Both fixed (`c75717c`, `c321063`, and a follow-up after review).

1. A narration is turned away (`duplicate_narration`, re-prompted) when, after exact repeats are cut, 60% or more of its content words (at least 5 distinct words of four or more letters, filler dropped, possessives folded) were already narrated this turn since the last game event, and the shared words are a quarter or more of both texts together. After three retellings in one turn the turn ends with a forced hand-off (`dm_retell_limit`). The check runs before the checker, so a retelling no longer costs a checker call, and the repeat-cut tool reply now says the cut text was already told. The review caught two false-positive shapes in the first version — a new beat after a long opening, and a second monster's attack in the same turn — which the game-event window and the two-sided share now spare. Replaying sessions 005–010 flags 15 narrations, all retellings.
2. `dm_state_leak` strips a sentence that opens with a snake_case tool name (`hand_off`) or a tool-argument key (`target:`, `kind:`, `ids:`).

## Fifth 1-hour run (session 009, 2026-09-19)

Run on HEAD `0bb260d`, after the fourth batch of fixes. It reached `target_reached` at ~65 spoken minutes in **83 wall minutes**, including one pause of about 10 minutes when the Ampere machine (Mira's seat, the checker's primary) dropped off the network again; `--resume` continued cleanly.

| Measure               | 007                 | 008        | 009                 |
| --------------------- | ------------------- | ---------- | ------------------- |
| Wall / spoken minutes | 154.4 / 60.7        | 63.1 / ~65 | 83 / ~65            |
| Pauses                | 1 (machine offline) | none       | 1 (machine offline) |
| DM share              | 72%                 | 71%        | 65%                 |
| Fights                | 3                   | 1 (+1 cut) | 1                   |
| Checker flags         | 27                  | 10         | 13                  |
| Tool errors           | 19                  | 2          | 7                   |

The fourth batch held: no checker finding named an NPC, the session closed on a scene change with no fight started past the target, a leak cut removed one sentence and kept its paragraph ("The heavy blow drops Bram to 16/28 HP…"), and no initiative list was voiced. The script stage gave 32 model labels, no rules fallbacks, and dropped 2 stage directions. Findings:

1. **The DM echoes its own engine instruction.** "Act for it with tools, narrate, then call hand_off." — the monster-turn instruction from `director.ts` — was voiced twice.
2. **More hit-point shapes reach the story.** The fight against a Silverscale Enforcer voiced its health after almost every blow ("dropping the creature's health to 36/52", then 30/52, 19/52, 13/52, 8/52), plus "the guard's HP drops to a critical 8" and "clinging to consciousness at 4/28 hit points".
3. **The checker flags an enemy's blow landing on a PC.** "The enforcer's greatsword … slams into Tomas" was cut because Tomas "declared nothing" (it was the monster's turn), and "Mira sidesteps the blow" cost a rewrite. The other flags were real (invented Kira dialogue, a Bram attack he never declared).
4. **The DM hands off to monsters.** Three `hand_off` calls named `hooded-merchant-1` or `silverscale-enforcer-1` and got a bare "Unknown player character ids" error.
5. **Death saves have still never fired live.** Tomas fell to 4/28, the closest yet.

### Fixes after the fifth run

Findings 1–4 are fixed in `197b339` plus a follow-up after review; finding 5 is still open.

1. `dm_state_leak` catches the instruction echo (`Act for … with tools`, `then call hand_off`, `Continue with other tools`) and tool-call syntax (`hand_off(`, `attack(goblin-1)`).
2. It catches any `HP` figure (`HP drops to a critical 8`), and `health` or `hit points` with a readout against a two-digit maximum (`health to 36/52`, `36/52 health`, `at 4/28 hit points`, `hit points: 36 of 52`), so `3/4 of a vial` stays. Replaying the strip over sessions 005–009 removes only real leaks.
3. The checker prompt says the result of an enemy's action on a PC (a hit, miss, wound, or knockback) is allowed and that players declare nothing on a monster's turn, while a reaction, spell, or line the player did not declare is still a violation.
4. `hand_off` naming a monster or NPC explains that only player characters take the spotlight, lists every bad id at once, and points to handing off by id or to the party.

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

## Where we are (2026-09-20)

**Branch `feat/dm-pc-control-checker`: 117 commits ahead of `origin/main`, nothing pushed.** `npm run typecheck`, `npm test` (56 files, 1197 passed plus 1 expected failure) and `npm run format:check` all pass on the branch head.

The expected failure is deliberate: it documents the quote-majority split's known cost (`"Who's next?" I nod to You.`), and will start passing only if that rule is revisited.

**Not pushing until a live session comes back clean.** Eight 1-hour sessions have run (005–012), each followed by a reviewed batch of fixes. Session 012 was the first under the one-fight rule: the combat rules held and tool errors fell to one, but the DM took 79% of the words, stayed in one scene, and ran to the hard stop without closing. Those fixes are reviewed but not yet run live.

### What each batch did

| Batch          | Trigger                     | Commits            | What changed                                                                                                                   |
| -------------- | --------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Script stage   | Reviews of sessions 002–004 | `cc4eb6e..bf09ef5` | The ten script findings, including the speech-direction grammar (5 review rounds)                                              |
| First run      | Session 005                 | `347f6d7..dd50ea2` | Death saves, combat closing, state-leak strip, repeat cutting, NPC continuity, tool-error logging                              |
| Second run     | Session 006                 | `2deb439..86cdeb0` | Combat narration caps, player repeat re-prompt, tool-shape coercions, hard-stop rule, read-aloud labels                        |
| Third run      | Session 007                 | `1d2f823..643befb` | Wider leak patterns, strict `hand_off` shape, attacks in the DM prompt, NPC-id resolution, cross-beat repeats, checker tuning  |
| Fourth run     | Session 008                 | `bc334ff..0bb260d` | Sentence-level leak strip, HP-in-prose and turn-order leaks, NPC checker findings, no fight past the target, quote repair      |
| Fifth run      | Session 009                 | `197b339..95785ad` | Instruction-echo and HP/health leaks, checker allows enemy blows on PCs, `hand_off` to monsters explained                      |
| Sixth run      | Session 010                 | `c75717c..80ac5e0` | Retelling (paraphrase loop) rejection with a per-turn cap, bare-line tool-call leaks                                           |
| Seventh run    | Session 011                 | `7b4d55d..e036678` | One action per combatant per turn, combat hand-offs, carried items in the DM prompt, turn announcements, checker allows a miss |
| One-fight rule | Aaron's call after 011      | `3a2606d..e81074d` | One fight a session, in the engine, the prompt and the spec                                                                    |
| Eighth run     | Session 012                 | `5cc2095..HEAD`    | DM word-share nudge, repeated closing press, bold tool call and meta-talk leaks, recoverable refusals                          |

### Rule added after session 011: one fight a session

Aaron's call (2026-09-19): a session has room for a single fight, as a rule of the simulation, not a nudge. `start_combat` refuses once one has started ("This session has already had its fight…"), the DM prompt says each turn whether the fight is still to come, the tool description says it, and it is written into the spec (§5.3) beside the one-action-a-turn rule. The reason: the session is a script to read, and a second fight crowds out the talking, searching, and travelling that carry the lore. Sessions 007 (three fights) and 011 (two) show how easily a run fills with combat.

### Next steps, in order

1. **Run session 013.** Watch for: whether the DM's share falls back toward the 64–72% of earlier runs and the session closes on a scene change rather than the hard stop, whether the closing press produces exactly one scene cut, how the DM takes a refused second fight now that its narration and hand_off survive, and whether death saves finally fire (no player has taken damage in the last two sessions).
2. **Push or merge once a session surfaces no new fix-worthy findings.**
3. Consider giving Bram and Tomas starting gear in the Avalon party files.
4. Then the plan work already queued: Plan 2B (lore), the Avalon Artificers Academy lore expansion, Plan 2C, and optionally the Plan 3 Ampere spike.

### Operating notes from these runs

- **A run takes 1–2.5 hours of wall time** for 60 spoken minutes. Shorter narration makes the word-based clock advance more slowly, so the caps added in the second batch lengthen wall time.
- **The DM's LM Studio wedged once** mid-`GENERATING`, answering nothing while still listing its model. `lms unload` then `lms load` fixed it; run `sim bench` before every session.
- **The Ampere machine dropped off the network** mid-session 007 and again mid-session 009 (back within ~10–30 minutes both times) (Mira's seat, the checker's primary). `--resume` picked up cleanly once it was back.
- **`player-bram` has a fallback target** in `campaign.json` after its seat paused session 005 by answering four times without a tool call.
- The SDD workspaces for all four batches are under `.superpowers/sdd/` (git-ignored) with their ledgers, briefs, reports and review packages.

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
  - the three narration trims record their flag and note just before the tool runs, so a `narrate` call that then fails leaves a record for a narration that never happened (DM-only review data, no behaviour depends on it);
  - a leaked state line that shares a line with real prose costs the whole line, since `dm_state_leak` strips whole lines;
  - the label request now lists monsters, so re-scripting a session with combat misses the label cache once;
  - a player validator violation (e.g. `player_narrates_outcome`) on the turn's last allowed attempt drops the line and forces a pass — the one remaining path where a player's words never reach the log;
  - plus the older cleanup items.
