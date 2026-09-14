# cartyx-sim

An autonomous Dungeons & Dragons 5e session simulator: one AI Dungeon Master and four AI players, each running on local models spread across a home LAN, playing in the Cartyx world.

It exists for two reasons:

1. **Test the lore.** Find out how well the `cartyx-lore` repository (story, NPCs, locations, factions) holds up in a real game, and where it is thin, missing, or contradictory.
2. **Produce watchable recordings.** Voice every speaker, show art for every character, and play the session back in a video-call-style web page that can be screen-recorded.

The party are students of **Avalon Artificers Academy** (Alpharetta), rival school to Axe-Ford Park Adventurer Academy (Brookhaven). The simulation never writes back into `cartyx-lore` or the real table campaign.

> **Status:** the engine and live-model support work (Plans 1 and 2A). Lore retrieval, character generation, art, voices, and playback are not built yet. See [`docs/status.md`](docs/status.md) for the current state and next steps.

## How it works

- **Generate, then produce.** `sim run` plays the whole session first and writes an append-only event log (`events.jsonl`). Art, voices, the timeline, the lore audit, and the playback page are all derived from that log afterward.
- **The engine owns the rules bookkeeping** (dice, checks, saves, attacks, HP, spell slots, conditions, initiative, inventory). The DM model adjudicates everything else. There is no grid.
- **Models act through tools.** The DM narrates, voices NPCs, rolls, changes state, starts and ends combat, looks up lore, records invented facts, and ends each beat with `hand_off`. Players `speak`, `act`, `interject`, or `pass`. Validators check every response and flag rule violations into the log.
- **Players see only what their characters would.** Player prompts get a `PlayerView` (own sheet, allies' vitals, other combatants by coarse status), never the full game state.
- **Sessions pause instead of crashing.** A seat that keeps failing, or a table that stalls, pauses the session (exit code 2) with a logged reason; `--resume` continues from the log.
- **The engine is a library.** `core` and `rules` have no network or filesystem access, so they can later be embedded in `cartyx-app`.

## Repository layout

npm workspaces, TypeScript, Node 22.22 or newer.

| Path                               | What it is                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rules`                   | 5e bookkeeping: dice and seeded RNG, checks, attacks, HP, conditions, spell slots, initiative, inventory.                                |
| `packages/core`                    | The director turn loop, event schema, state projection, DM and player tools, validators, scheduler, session clock, and the `PlayerView`. |
| `packages/models`                  | An OpenAI-compatible model client (Vercel AI SDK) with per-seat timeouts and fallback endpoints, plus seat benchmarking.                 |
| `apps/cli`                         | The `sim` command: campaign loading, the JSONL event sink with session locking, `sim run`, and `sim bench`.                              |
| `apps/cli/examples/local-campaign` | An example campaign to copy and edit.                                                                                                    |
| `apps/cli/fixtures`                | Scripted sessions that run without any model.                                                                                            |
| `docs/`                            | Status, the operator guide, and the design spec, roadmap, and implementation plans.                                                      |

Planned but not built: `packages/lore` (Plan 2B), `packages/media` (Plan 3), and `apps/playback` (Plan 4).

## Quick start

```bash
npm ci
npm run sim -- run --campaign demo --fixture apps/cli/fixtures/demo-session.json
```

The fixture run plays a short scripted scene with no models and writes `campaigns/demo/sessions/001/events.jsonl`. (`campaigns/` is git-ignored.)

To play against real models, follow [`docs/running-a-session.md`](docs/running-a-session.md). In short:

```bash
mkdir -p campaigns && cp -R apps/cli/examples/local-campaign campaigns/avalon
# edit campaigns/avalon/campaign.json: endpoints, model ids, one seat per character
npm run sim -- bench --campaign avalon
npm run sim -- run --campaign avalon --target-minutes 10
```

## The `sim` command

Run it with `npm run sim -- <command>`.

### `sim run`

Plays a session and appends every event to `campaigns/<id>/sessions/NNN/events.jsonl`.

| Option                   | Meaning                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `--campaign <id>`        | Required. A folder under the campaigns directory.              |
| `--fixture <path>`       | Play a scripted fixture instead of the campaign's model seats. |
| `--session <n>`          | Session number (default 1).                                    |
| `--target-minutes <n>`   | Target spoken minutes; overrides the campaign or fixture.      |
| `--seed <n>`             | Seed for reproducible dice.                                    |
| `--resume`               | Continue an existing session log.                              |
| `--campaigns-dir <path>` | Campaigns directory (default `campaigns`).                     |

Exit codes: `0` ended, `2` paused (fix the cause, then rerun with `--resume`), `130`/`143` interrupted by Ctrl-C or SIGTERM (the session lock is released).

### `sim bench`

Checks every seat: whether the endpoint answers, whether it lists the configured model, tokens per second, and how many tool-call trials come back well-formed. Saves a report to `campaigns/<id>/bench/<timestamp>.json` and exits `1` if any seat fails.

| Option                   | Meaning                                    |
| ------------------------ | ------------------------------------------ |
| `--campaign <id>`        | Required.                                  |
| `--trials <n>`           | Tool-call trials per seat (default 5).     |
| `--campaigns-dir <path>` | Campaigns directory (default `campaigns`). |

## A campaign folder

```text
campaigns/<id>/
  campaign.json          name, targetMinutes, endpoints, seats (dm + one per player)
  characters/<pc>.json   one file per party member; each needs a seat under seats.players
  sessions/NNN/events.jsonl
  bench/<timestamp>.json
```

Campaign files are plain JSON. Campaign ids are lowercase letters, digits, and dashes. Any OpenAI-compatible `/v1` server works for a seat: LM Studio, llama.cpp (`llama-server --jinja`), or `mlx_lm.server`. Seat options are `temperature`, `maxOutputTokens`, `timeoutMs`, `toolChoice` (`required` or `auto`), and `fallbacks`. The operator guide covers each one.

## Development

```bash
npm test               # vitest
npm run test:watch
npm run typecheck      # the whole repo, plus core and rules without Node types
npm run format         # Prettier
npm run format:check
```

All three checks (`typecheck`, `test`, `format:check`) must pass before a commit. `core` and `rules` are typechecked without Node types to keep them free of Node APIs.

## Documentation

- [`docs/status.md`](docs/status.md): where the project stands, what works, next steps, and the backlog highlights.
- [`docs/running-a-session.md`](docs/running-a-session.md): setting up model servers, a campaign, `sim bench`, `sim run`, and pauses.
- [`docs/superpowers/specs/2026-09-13-cartyx-sim-v1-design.md`](docs/superpowers/specs/2026-09-13-cartyx-sim-v1-design.md): the v1 design (event log contract, session flow, tools, media, playback).
- [`docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md`](docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md): the plan sequence, deviations from the spec, and the full backlog.

## Roadmap

| Plan | Delivers                                                                             | Status      |
| ---- | ------------------------------------------------------------------------------------ | ----------- |
| 1    | Engine core: rules, director, event log, `sim run` against fixtures                  | Implemented |
| 2A   | Live models: model client, campaign config, `sim bench`, `sim run` on real endpoints | Implemented |
| 2B   | Lore: ingest `cartyx-lore`, embeddings, `sim index`, `sim audit`                     | Not written |
| 2C   | SRD import, production prompts, scribe, `sim chargen`, `sim prep`                    | Not written |
| 3    | Media: ComfyUI art and TTS voices, rendered after the run                            | Not written |
| 4    | Playback page for OBS recording                                                      | Not written |

Later: MP4 export, live streaming, and play inside `cartyx-app`.
