# cartyx-sim v1 — Plan Roadmap

**Spec:** `docs/superpowers/specs/2026-09-13-cartyx-sim-v1-design.md`

The v1 spec covers four independent subsystems. Each gets its own implementation plan, and each plan ends in working, testable software. Later plans are written after the earlier plan lands, so they build on the real interfaces rather than guessed ones.

| # | Plan | Delivers | Depends on | Status |
|---|---|---|---|---|
| 1 | `2026-09-13-cartyx-sim-plan-1-engine-core.md` | Monorepo, `rules` package (dice, checks, attacks, HP, conditions, slots, initiative, inventory), `core` package (event log schema, state projection, tools, validators, scheduler, session clock, director turn loop with resume), `sim run` against a scripted fixture model. Fully tested with no AI models. | — | Written |
| 2 | Plan 2 — Live AI session | `models` package (Vercel AI SDK, OpenAI-compatible seats, fallbacks), `sim bench`, `lore` package (ingest `cartyx-lore`, embeddings, LanceDB, `sim index`), SRD 5.2.1 import (classes, equipment, monsters) and SRD-backed spell validation and `award_milestone`, production prompts (DM persona, player personas, class primers, knowledge isolation), scribe (scene summaries, recap, DM notes, journals), `sim chargen` (text only), `sim prep`, `sim run` with real models, `sim audit`, 5-minute end-to-end smoke. | 1 | Not written |
| 3 | Plan 3 — Media production | Ampere ARM64 spike (ComfyUI + Z-Image-Turbo on the 3090, Qwen3-TTS on the 4070, with fallbacks), `media` package, chargen portraits and PC voices, `sim cast`, `sim art`, `sim voice`, `timeline.json`. | 1 (event log), 2 (chargen, scribe model) | Not written |
| 4 | Plan 4 — Playback page | `apps/playback` (React + Vite): 20/80 video-call layout, stage rules (PC / DM-with-scene / NPC nameplate / overlap split), subtitles, live stats, roll callouts, review controls, `sim play`, Playwright layout checks. | 1 (event types), 3 (timeline format) | Not written |

The Plan 3 Ampere spike needs no code from Plans 1–2 and can be run on the hardware at any time. Running it early de-risks the machine assignment.

## Deviations from the spec

- **`state.sqlite` is deferred.** Plan 1 rebuilds state by folding `events.jsonl` in memory, which is fast at session scale (a 1-hour session is a few thousand events). A SQLite projection is added in Plan 2 only if the audit or the scribe needs indexed queries. The event log remains the source of truth either way, so nothing is lost.
- **DM validator fallback.** When the DM keeps breaking a table rule, Plan 1 re-prompts with the specific violation up to 2 times, then accepts the output with a `validator_flag` (resolution `accepted_with_flag`). The spec's extra "narrower instruction" re-prompt is left to Plan 2's production prompts, where it can be tuned against real models.
- **Heuristic validators.** Plan 1's validators are pattern-based. An optional checker-model pass for subtler violations belongs with the scribe/checker model in Plan 2.
- **Resume is atomic per turn** rather than idempotent per roll. The engine buffers each turn's events and appends them in one synced write when the turn completes. A crash mid-turn discards only unseen, uncommitted work, so no recorded roll is ever repeated. This meets the spec's guarantee with less machinery.
