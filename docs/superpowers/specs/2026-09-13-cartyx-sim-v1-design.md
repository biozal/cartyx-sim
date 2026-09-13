# cartyx-sim v1 — Design

**Date:** 2026-09-13
**Status:** Draft for review
**Related:** Avalon Artificers Academy lore build-out (separate spec, `cartyx-lore`) — v1's first adventure depends on it.

## 1. Purpose

Run an autonomous Dungeons & Dragons 5e session — one AI Dungeon Master and four AI players, each on local models spread across the LAN — set in the Cartyx world, in order to:

1. **Test the lore.** Find out how well `cartyx-lore` (story, NPCs, locations, factions) carries a real game, and where it is thin, missing, or contradictory.
2. **Produce watchable recordings.** Voice every speaker distinctly, show art for every character, and play the session back in a video-call-style web page that can be screen-recorded for YouTube.
3. **Persist a campaign.** Sessions continue from one another with memory, state, and consistent NPC voices and portraits.

Later phases (out of scope here): direct MP4 export, live streaming to YouTube/Twitch, and play inside `cartyx-app` (Phase 2).

## 2. Locked Decisions

| Area             | Decision                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Approach         | Custom TypeScript "director" engine. Not LangGraph/Mastra; not SillyTavern.                                                      |
| Run mode         | Generate-then-produce: the session is simulated first; art, voices, and playback are produced afterward.                         |
| Session length   | Configurable target in minutes of spoken runtime; first experiment = 60.                                                         |
| Campaign         | New party and new adventure; never writes back into the real table campaign or `cartyx-lore`.                                    |
| Story            | Party are students of **Avalon Artificers Academy** (Alpharetta), rival school to Axe-Ford Park Adventurer Academy (Brookhaven). |
| Rules            | Engine owns bookkeeping; the DM adjudicates everything else; no grid.                                                            |
| Characters       | AI drafts from lore; user approves editable files.                                                                               |
| Lore test output | Per-session lore audit report.                                                                                                   |
| Language         | TypeScript (Node ≥ 22). TTS and image generation run as external Python services reached over HTTP.                              |
| Playback         | Local web page; bottom 20% player tiles, top 80% speaker stage.                                                                  |
| Recording (v1)   | OBS screen capture of the playback page in real time.                                                                            |
| Hardware         | Art on the Ampere server; avoid the Alienware laptop unless required.                                                            |

## 3. Architecture

### 3.1 Repository layout (npm workspaces)

| Unit              | Responsibility                                                                                                                                                                                                                                      | Depends on             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `packages/core`   | Turn loop, seat scheduler, session clock, event types, validators. Pure logic behind interfaces: `ModelClient`, `LoreIndex`, `StateStore`, `EventSink`, `Rng`. No direct network or filesystem access, so it can later be embedded in `cartyx-app`. | `rules`                |
| `packages/rules`  | 5e bookkeeping: dice, ability checks, saves, attacks, damage, healing, HP, spell slots, conditions, initiative, inventory, milestone level-up validation.                                                                                           | SRD data               |
| `packages/lore`   | Ingest `cartyx-lore` markdown, chunk by heading with entity/location/Kanka-ID metadata, embed, store in LanceDB, answer queries, record lookups.                                                                                                    | embedding endpoint     |
| `packages/models` | Seat → OpenAI-compatible endpoint mapping via the Vercel AI SDK; retries, health checks, per-turn idempotency keys, fallback endpoints.                                                                                                             | seat config            |
| `packages/media`  | Clients for ComfyUI (images) and the TTS service; content-hash caching; cast sheet generation.                                                                                                                                                      | ComfyUI, TTS endpoints |
| `apps/cli`        | The `sim` command; SQLite state projection; filesystem event sink.                                                                                                                                                                                  | all packages           |
| `apps/playback`   | Local web app (React + Vite) that plays a session timeline.                                                                                                                                                                                         | session files          |

### 3.2 SRD data

- Rules, spells, and species are synced from `cartyx-app/app/server/data/srd/` (SRD 5.2.1) by a sync script into `packages/rules/data/`.
- Classes, subclasses available in the SRD, equipment, and monsters are **not** present in `cartyx-app`; v1 adds an import of those from SRD 5.2.1 (CC-BY-4.0) with the required attribution.
- Mechanics are limited to SRD 5.2.1 content. Non-SRD species from `races.md` (e.g., Tabaxi, Kenku) may be used as **flavor** over SRD mechanics only, consistent with the `cartyx-lore` README.

### 3.3 Machine assignment (initial; every seat is just an endpoint in config)

| Machine                    | During `sim run`                                   | After the run                         |
| -------------------------- | -------------------------------------------------- | ------------------------------------- |
| MacBook Pro M5 Max, 128 GB | Engine, lore index + embeddings, **DM**            | Cast sheet, audit, playback page, OBS |
| Mac Studio M2 Ultra, 64 GB | **Players 1 and 2** (different models if they fit) | —                                     |
| Ampere ARM64, RTX 3090     | **Player 3** (llama.cpp server)                    | **ComfyUI art** (portraits, scenes)   |
| Ampere ARM64, RTX 4070     | **Scribe / checker / validator** model             | **TTS** (voices)                      |
| Windows PC, RTX 5070 Ti    | **Player 4** (LM Studio)                           | Art fallback                          |
| Alienware, RTX 5080M       | Not used                                           | Not used unless required              |

Model choices are validated by `sim bench` on real hardware before being fixed in config. Different model families per player are preferred so personalities diverge.

## 4. The Event Log (the contract)

Each session writes `campaigns/<id>/sessions/<NNN>/events.jsonl`. It is the single source of truth; everything else (state, art jobs, voices, timeline, audit, playback) is derived from it.

### 4.1 Common fields

`seq` (monotonic int), `ts` (ISO wall time), `turnId` (idempotency key), `type`, `visibility` (`public` | `dm`).

### 4.2 Event types

| Type                            | Key fields                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `session_start` / `session_end` | session number, lore commit hash, target minutes, reason for ending                       |
| `narration`                     | speaker `dm`, text, emotion                                                               |
| `dialogue`                      | speaker (PC id or NPC id), text, emotion, optional `overlaps: <seq>`                      |
| `action`                        | actor, intent, target                                                                     |
| `roll`                          | actor, kind (check/save/attack/damage/initiative), dice, modifiers, total, DC/AC, outcome |
| `state_change`                  | entity, field (hp, slots, conditions, inventory, level), before, after, cause seq         |
| `lore_lookup`                   | query, hits (chunk id, source path, score), used chunk ids                                |
| `lore_invention`                | fact, reason, related query                                                               |
| `npc_introduced`                | npc id, name, lore entity id (if any), invented flag, public description                  |
| `scene_change`                  | location, lore entity id, art prompt                                                      |
| `combat_start` / `combat_end`   | combatants, initiative order                                                              |
| `validator_flag`                | seat, rule violated, retries, resolution                                                  |
| `ooc_note`                      | engine notices (resumes, fallbacks)                                                       |
| `session_paused`                | reason, seat, kind (`seat` or `backstop`)                                                 |

Spoken events (`narration`, `dialogue`) are the only events that produce audio.

## 5. Session Flow

### 5.1 Prep (`sim prep`)

Before each session the DM model uses lore retrieval to write a DM-only outline to `campaigns/<id>/prep/session-<NNN>.md`: hook, 3–5 scenes, NPCs with motives, secrets and clues, likely endings, and threads carried forward from `dm-notes.md`. The user may edit it; runs do not require review.

### 5.2 Exploration / roleplay loop

1. **DM beat.** The DM narrates (optionally voicing NPCs and calling tools) and ends by calling `hand_off(to)` — a specific PC, the whole party, or open floor.
2. **Player responses.** Each addressed player takes exactly one turn, calling `speak(text, emotion)`, `act(intent, target?)`, `interject(text, emotion)`, or `pass()`. The scheduler tracks each seat's share of spoken words and prioritizes under-heard players on open-floor hand-offs.
3. **Resolution.** The DM resolves declared actions through tools, narrates outcomes, and the loop repeats.

`interject` produces a short `dialogue` event with `overlaps` set to the line it reacts to; playback starts it during that line.

### 5.3 Combat loop

`start_combat` rolls initiative (engine) and fixes turn order. On a PC's turn, that player declares; on a monster's turn, the DM acts through tools. Action economy (one action, one bonus action, movement, one reaction per round) is tracked loosely and noted, not spatially simulated. `end_combat` returns to the exploration loop.

### 5.4 Tools

**DM tools**

| Tool                                                           | Effect                                             |
| -------------------------------------------------------------- | -------------------------------------------------- |
| `lookup_lore(query)`                                           | Retrieval; emits `lore_lookup`                     |
| `record_invention(fact, reason)`                               | Emits `lore_invention`                             |
| `introduce_npc(name, lore_entity?, description)`               | Emits `npc_introduced`                             |
| `npc_say(npc, text, emotion)`                                  | Emits `dialogue` from the NPC                      |
| `request_check(pc, skill\|ability\|save, dc, reason)`          | Engine rolls; result returned before narration     |
| `attack(attacker, target, weapon\|attack)`                     | Engine rolls hit and damage                        |
| `cast_spell(caster, spell, level, targets)`                    | Engine validates and spends slots; rolls if needed |
| `apply_damage` / `heal` / `add_condition` / `remove_condition` | State changes                                      |
| `give_item` / `remove_item`                                    | Inventory                                          |
| `start_combat(monsters)` / `end_combat()`                      | Combat mode                                        |
| `scene_change(location, art_prompt)`                           | Emits `scene_change`                               |
| `award_milestone()`                                            | Level-up at session end                            |
| `hand_off(to)`                                                 | Ends the DM beat                                   |

**Player tools:** `speak`, `act`, `interject`, `pass`, `cast_spell` (declaration only; the DM resolves).

### 5.5 Knowledge isolation

Players receive only `public` events, their own character file (sheet, backstory, personality, private goals), their own journal, the public recap, and a class primer generated from SRD data. DM-only material (prep outline, NPC motives, monster stats, `dm` visibility events) never enters a player prompt.

### 5.6 Validators

Output is checked before it is committed to the log:

- A player narrates outcomes, or speaks or acts for another character.
- The DM decides a PC's choices.
- Mechanical results appear in text without a corresponding tool call (e.g., damage stated without `apply_damage`).
- Tool arguments fail schema validation.

On failure the seat is re-prompted with the specific violation, up to 2 retries. If it still fails: a player turn resolves as `pass` ("hesitates"); a DM beat is re-prompted with a narrower instruction. Every case emits `validator_flag`.

### 5.7 Context budget

A scribe model runs after each scene to write a scene summary and extract new facts (NPC attitudes, open threads). Each prompt is assembled from: role instructions, state snapshot, running summaries, and the last ~30 events, capped at ~24K tokens.

### 5.8 Session clock

Spoken runtime = spoken words in the log ÷ 150 words per minute. At 80% of the target the DM is instructed to steer toward a cliffhanger; at 100% the session ends at the next scene break (hard stop at 115%).

## 6. Persistence

### 6.1 Campaign directory

```
campaigns/<id>/
  campaign.yaml            seats, endpoints, models, target minutes, tone, lore repo path, art style prompt
  characters/<pc>.yaml     sheet, backstory, personality, private goals, portrait, voice
  cast/npcs/<npc>.yaml     portrait prompt, voice description, voice reference, lore entity id
  prep/session-NNN.md
  assets/                  portraits, scene art, voice references (content-hash named)
  sessions/NNN/
    events.jsonl
    recap.md               public "previously on…"
    dm-notes.md            DM-only open threads, NPC attitudes, revealed secrets
    journals/<pc>.md       first-person memory per PC
    audio/                 per-line clips
    timeline.json
    audit.md, audit.json
  state.sqlite             projection rebuilt from events
```

`campaigns/` lives outside version control by default (listed in `.gitignore`); its location is configurable. The lore index lives in `.cache/lore-index/` (also ignored).

### 6.2 Event sourcing and resume

State is a fold over `events.jsonl`. `state.sqlite` is a cache that can be rebuilt at any time. A crashed or paused run resumes with `sim run --resume`, replaying the log to the exact prior state. Rolls are recorded once per `turnId`, so retries never re-roll.

### 6.3 Between sessions

At session end the scribe writes `recap.md`, `dm-notes.md`, and one journal per PC. The next session's prep and prompts start from these. `award_milestone` triggers level-up: each player model selects options, validated against SRD data.

### 6.4 Lore versioning

Each session records the `cartyx-lore` git commit. If it differs from the indexed commit, the index is rebuilt before the run. The simulation never writes to `cartyx-lore`.

## 7. Characters (`sim chargen`)

- The generator drafts four PCs as Avalon Artificers Academy students using lore retrieval (races, regions, families, factions, Avalon faculty) so backstories tie to real Cartyx places and NPCs.
- Starting level is configurable; **default 3** (subclass features available).
- Each PC file includes an SRD-legal sheet, a multi-paragraph backstory, personality traits, private goals, relationships, a portrait prompt, and a voice description.
- ComfyUI produces 4 portrait options per PC; the user picks one. Qwen3-TTS voice design produces a reference clip per PC voice.
- Nothing runs until the user approves the character files.

## 8. Media Production

### 8.1 Cast sheet (`sim cast`)

After a run, every NPC from `npc_introduced` / `npc_say` events is collected. For each NPC not already in `cast/npcs/`, the lore entry (race, age, role, personality) is used to generate a portrait prompt and a distinct voice description. The DM voice is fixed per campaign. A distinctness check ensures no two NPCs sharing a scene have near-duplicate voice descriptions. Previously cast NPCs keep their voice and portrait. Invented NPCs are cast too and appear in the audit. The sheet is editable before the next step; the pipeline does not wait for review by default.

### 8.2 Art (`sim art`)

ComfyUI on the Ampere RTX 3090 with Z-Image-Turbo (Apache 2.0). A campaign-wide style prompt applies to all images. Jobs: PC portraits (at chargen), NPC portraits, and scene art from `scene_change`. Outputs are content-hash cached; failures produce a flagged placeholder and are retried on re-run.

### 8.3 Voices (`sim voice`)

TTS service on the Ampere RTX 4070. Qwen3-TTS (Apache 2.0) is the single v1 TTS model: voice design creates each reference voice, and the same model renders every line. Chatterbox-Turbo (MIT) is a later option for more expressive delivery, not part of v1. One clip per spoken event, content-hash cached. Output `timeline.json`: for each spoken event, start time, duration, clip path, speaker, and overlap placement. Non-spoken events are placed on the timeline at their position between spoken lines. A content filter runs before synthesis, per the campaign tone setting (default PG-13).

### 8.4 Licensing constraints

Only models licensed for commercial use may be used for published output: Z-Image-Turbo, Qwen3-TTS, Chatterbox-Turbo, Kokoro (fallback). Excluded: XTTS-v2, Higgs Audio, Fish Audio S2 (without paid license), FLUX.2 [dev] (without paid license). No cloning of real people's voices.

## 9. Playback Page (`sim play`)

Local web app served on localhost that plays `timeline.json` with its audio clips.

- **Bottom 20%:** four player tiles — portrait, name, class and level, HP bar, AC, conditions, six ability scores. The active speaker's tile gets a highlight ring.
- **Top 80% stage:**
  - PC speaking → that PC's portrait fills the stage.
  - DM narration → current scene art fills the stage with a small DM inset.
  - NPC speaking → NPC portrait fills the stage with a nameplate "`<NPC name>` (DM)".
  - Overlapping lines → the stage splits to show both speakers.
- **Subtitles** from event text, synced to clips.
- **Live stats:** tiles update as `state_change` events pass on the timeline; rolls appear as a brief on-stage callout.
- **Review controls:** play/pause, scrub, jump to timestamp (audit links open at the matching moment). Controls hide for recording.

## 10. Lore Audit (`sim audit`)

Built from `lore_lookup`, `lore_invention`, `npc_introduced`, and `scene_change` events plus one checker-model pass. `audit.md` sections:

1. **Gaps** — queries with no hit above the relevance threshold, grouped by topic, ranked by frequency.
2. **Inventions** — invented facts with transcript quote and playback timestamp; candidate canon.
3. **Possible contradictions** — narrated statements that the checker model judges to conflict with retrieved chunks; always labeled "possible".
4. **Coverage** — NPCs, locations, and factions used and their frequency; prepped items never reached.
5. **Backstory hooks** — which PC backstory threads the DM engaged or ignored.

`audit.json` carries the same data for cross-session comparison.

## 11. CLI Summary

| Command                                   | Purpose                                                    |
| ----------------------------------------- | ---------------------------------------------------------- |
| `sim bench`                               | Health, tokens/sec, and tool-call reliability per endpoint |
| `sim index`                               | Build or refresh the lore index                            |
| `sim chargen`                             | Draft PCs, portraits, voices for approval                  |
| `sim prep`                                | DM session outline                                         |
| `sim run [--target-minutes N] [--resume]` | Simulate a session                                         |
| `sim cast`                                | NPC cast sheet                                             |
| `sim art`                                 | Generate images                                            |
| `sim voice`                               | Generate audio and timeline                                |
| `sim audit`                               | Lore audit report                                          |
| `sim play`                                | Serve the playback page                                    |

## 12. Error Handling

- **Endpoints:** health check on every seat before a run. Mid-run failures retry with backoff; persistent failure switches to the seat's configured fallback endpoint if any, else pauses the session (a `session_paused` event: reason, seat, kind) for `--resume`.
- **Malformed tool calls:** schema validation, one retry with the error text, then the validator fallback (§5.6).
- **Runaway loops:** cap on DM tool calls per beat; watchdog when N consecutive turns produce no spoken output.
- **Media failures:** placeholders (initials tile, default voice) plus a flag; re-runs regenerate only missing content-hash outputs.
- **Lore index stale:** detected by commit hash; rebuilt before run.

## 13. Testing

- **`rules`:** unit tests with a seeded `Rng` against SRD data (checks, attacks, damage, slots, conditions, level-up).
- **`core`:** a scripted fake `ModelClient` replays canned tool calls to produce golden event logs; a replay test asserts that folding the log reproduces the live state.
- **`lore`:** known-answer retrieval tests (e.g., "who teaches applied crystal engines at Avalon?" → Professor Sella Vaunt).
- **`media`:** client tests against recorded ComfyUI/TTS responses; cache-key tests.
- **`playback`:** component tests on a fixture timeline; Playwright check of the 20/80 layout, overlap split, NPC nameplate, and HP updates.
- **End-to-end smoke:** a 5-minute session with small models entirely on the M5 Max.

## 14. Risks

1. **ARM64 + CUDA for PyTorch services.** ComfyUI and the TTS models on the Ampere server are newly supported and lightly tested. The implementation plan begins with a spike on the Ampere 3090/4070. Fallbacks: TTS on the M5 Max via mlx-audio (idle after the run); art on the RTX 5070 Ti PC.
2. **Model quality and speed are unverified on this hardware.** Mitigated by `sim bench` and config-only seat changes.
3. **Coherence drift across a long session.** Mitigated by engine-owned state, scene summaries, validators, and the context cap.
4. **Voice distinctness across many NPCs.** Mitigated by voice-design descriptions and the distinctness check; worst case the user edits the cast sheet.
5. **Platform policy.** YouTube's synthetic-content disclosure applies; human framing and editing recommended for published videos.

## 15. Out of Scope for v1

Direct MP4 export (e.g., Remotion), live streaming and multistreaming, animated lip-sync, grid or tactical maps, `cartyx-app` integration, writing back into `cartyx-lore`, and the Avalon Academy lore itself (separate spec).
