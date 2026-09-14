# cartyx-sim status

_Last updated: 2026-09-14_

cartyx-sim is an autonomous D&D 5e simulation (one AI DM and four AI players on local models) built to test the Cartyx lore in `cartyx-lore`. It records a session as an event log, and later plans add voices, art, and a video-call-style playback page for recording. See the spec (`docs/superpowers/specs/2026-09-13-cartyx-sim-v1-design.md`) and the roadmap (`docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md`).

## Where things stand

| Plan                                                      | Status                                          |
| --------------------------------------------------------- | ----------------------------------------------- |
| 1 — Engine core                                           | Implemented, hardened, merged, pushed to GitHub |
| 2A — Live models                                          | Implemented, reviewed, merged, pushed to GitHub |
| 2B — Lore                                                 | Not written                                     |
| 2C — Characters, prep, and prompts                        | Not written                                     |
| 3 — Media production (art, voices)                        | Not written                                     |
| 4 — Playback page                                         | Not written                                     |
| Avalon Artificers Academy lore (rival school, Alpharetta) | Separate sub-project, not started               |

**Repository:** `main` is pushed to GitHub, including Plan 2A, this status page, and the README.

**Checks on `main`:** `npm run typecheck`, `npm test` (36 files, 524 tests), and `npm run format:check` all pass.

## What works today

- **`sim run --fixture`**: plays a session against a scripted fixture model (Plan 1).
- **`sim run --campaign <id>`**: plays a session against real OpenAI-compatible endpoints (LM Studio, llama.cpp, mlx_lm), with per-seat model, temperature, timeout, tool choice, and fallback endpoints. Every event is appended to `campaigns/<id>/sessions/NNN/events.jsonl`.
- **`sim bench --campaign <id>`**: checks each seat's reachability, whether the server lists the model, tokens per second, and tool-call reliability; saves a report under `campaigns/<id>/bench/` and exits 1 on failure.
- **Pause and resume**: seat failures and the runaway-loop backstop pause the session (exit code 2) with a logged `session_paused` event; `--resume` continues from the log with a fresh backstop budget.
- **Campaign config**: `campaign.json` (endpoints, seats) plus `characters/*.json`; an example lives in `apps/cli/examples/local-campaign/`.

Operator guide: `docs/running-a-session.md`.

## What Plan 2A added

- **Engine hardening:** a runaway-loop backstop (12 stalled turns, 3 idle hand-offs, 24 DM tool calls per beat), a validator flag for every DM outcome, a player-safe `PlayerView` for prompts, downed PCs kept in initiative, turn ids and tool choice on model requests, an event schema version, a Node-free typecheck for `core` and `rules`, and recovery from a torn final log line.
- **`models` package:** an OpenAI-compatible client with seat fallbacks and timeouts, and seat benchmarking.
- **CLI:** campaign loading, `sim bench`, and `sim run` against real endpoints.

### Review outcome

Three batch reviews and a whole-branch review with fake-server probes, then two fix waves and a final re-check (approved). The fixes:

- The pause backstop counts stalled turns (no words and no game-state progress), so terse mechanics-only combat no longer pauses, while a DM that never resolves anything still does.
- A pause is logged as `session_paused` and resets the backstop counters, so resuming makes progress.
- Pause messages distinguish a seat failure from a backstop pause, without doubled prefixes.
- Tool schemas sent to model servers no longer carry `$schema`, `$defs`, or `$ref`.
- `sim bench` counts a `toolChoice: auto` seat's text replies as usable.
- The campaign loader guards config-supplied ids; campaign resume is tested.

## Not yet tried

- **No run on the real hardware yet.** All model tests use a fake OpenAI-compatible server. The first real step is:
  1. `mkdir -p campaigns && cp -R apps/cli/examples/local-campaign campaigns/avalon`
  2. Fill in real model ids and machine addresses in `campaigns/avalon/campaign.json`.
  3. `npm run sim -- bench --campaign avalon`
  4. `npm run sim -- run --campaign avalon --target-minutes 10`
- Lore lookups always report a gap until Plan 2B, so the DM invents and records details.

## Hardware plan

| Machine     | Role                              |
| ----------- | --------------------------------- |
| M5 Max      | Engine, DM, OBS                   |
| M2 Ultra    | Players                           |
| Ampere 3090 | Player; ComfyUI art after the run |
| Ampere 4070 | Scribe; TTS                       |
| 5070 Ti     | Player                            |
| Alienware   | Avoid (loud fans)                 |

## Next steps

1. Run `sim bench` and a 10-minute `sim run` on the real machines. Its findings (tool-choice support, real speeds, backstop fit) feed Plan 2C.
2. Write Plan 2B (lore: ingest `cartyx-lore`, embeddings, `sim index`, `sim audit`).
3. Start the Avalon Artificers Academy lore expansion (in `cartyx-lore`) before Plan 2C, since chargen drafts the party from it. It can run alongside Plan 2B.
4. Write Plan 2C (SRD import, production prompts, scribe, `sim chargen`, `sim prep`, 5-minute smoke run).
5. Optionally run the Plan 3 Ampere ARM64 spike (ComfyUI and TTS) early; it needs no code from Plans 1–2.

## Open backlog

The full list is in the roadmap's Backlog section. Highlights:

- **Plan 2B:** entity ids on lore hits; link lore inventions to their narration.
- **Plan 2C:**
  - a class field on PCs;
  - player target-id validation;
  - a sticky fallback for a timed-out primary;
  - `sim bench` checks fallback targets;
  - backstop limits exposed in `campaign.json`.
- **Unscheduled:**
  - director-side response validation retries the primary, not the fallbacks;
  - `ModelRequest.signal` is never set;
  - a seeded run's dice restart on resume;
  - plus the older cleanup items.
