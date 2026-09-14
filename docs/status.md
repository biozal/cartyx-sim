# cartyx-sim status

_Last updated: 2026-09-14_

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

**Checks on `main`:** `npm run typecheck`, `npm test` (36 files, 545 tests), and `npm run format:check` all pass.

## What works today

- **`sim run --fixture`**: plays a session against a scripted fixture model (Plan 1).
- **`sim run --campaign <id>`**: plays a session against real OpenAI-compatible endpoints (LM Studio, llama.cpp, mlx_lm, Ollama), with per-seat model, temperature, timeout, tool choice, and fallback endpoints. Every event is appended to `campaigns/<id>/sessions/NNN/events.jsonl`.
- **`sim bench --campaign <id>`**: checks each seat's reachability, whether the server lists the model, tokens per second, and tool-call reliability; saves a report under `campaigns/<id>/bench/` and exits 1 on failure.
- **Pause and resume**: seat failures and the runaway-loop backstop pause the session (exit code 2) with a logged `session_paused` event; `--resume` continues from the log with a fresh backstop budget.
- **Campaign config**: `campaign.json` (endpoints, seats) plus `characters/*.json`; an example lives in `apps/cli/examples/local-campaign/`.

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
- **Engine fixes from the runs:** DM prose that arrives alongside tool calls is narrated (after those calls, before `hand_off`) instead of dropped; identical narration within one beat is skipped and flagged `duplicate_narration`; quote marks wrapped around a whole spoken line are removed.

Lore lookups always report a gap until Plan 2B, so the DM invents and records details.

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

1. Play a full 10-minute session (`--resume` session 001) and read the transcript for lore gaps and character voice.
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
  - a per-seat `reasoningEffort` option (would make Muse Glimmer usable);
  - a `sim bench` tool trial realistic enough to expose thinking overflow (the dice-roll trial passes models that fail on real turns).
- **Unscheduled:**
  - director-side response validation retries the primary, not the fallbacks;
  - `ModelRequest.signal` is never set;
  - a seeded run's dice restart on resume;
  - kira's 8-bit Qwen3.8 is the slowest seat; a 4-bit build would roughly halve its turns;
  - plus the older cleanup items.
