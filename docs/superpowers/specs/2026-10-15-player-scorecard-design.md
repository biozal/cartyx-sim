# Player scorecard — design

**Status:** approved in conversation 2026-10-15; written for review.
**Part of:** the player fine-tuning project (`docs/fine-tuning/guide.md`), sub-project 1. Depends on
sub-project 1a (`2026-10-15-srd-markdown-design.md`) for rules excerpts.

## Goal

Measure how well each model plays a player seat, on the four goals the user set — reliable and fast,
engaged roleplay, rules-savvy play, knows the world — so that "the fine-tuned model plays better"
becomes a number we can compare. Its first use is a baseline of today's player models; later
sub-projects use it to filter training data and to evaluate trained models.

## Approach

Measured numbers from the logs, plus a local judge model grading a sample of turns against a fixed
rubric (approach B, chosen 2026-10-15). Head-to-head comparison of two models on the same prompts
(approach C) is deferred to sub-project 5.

## Components

### 1. Model-call log

The sim records what happened in the story (`events.jsonl`) but not the model calls behind it: the
prompt a player saw, which model answered, how long it took, its thinking, retries and fallbacks.

- `OpenAICompatibleModelClient` (in `packages/models`) takes an optional `onCall(record)` hook,
  called once per attempt — every retry and fallback attempt included, successful or not.
- A record holds: `ts`, `seat`, `turnId` (when given), `purpose`, `endpoint`, `model`,
  `attempt` (its index within the request), the `messages` and `tools` sent, `toolChoice`,
  `maxOutputTokens`, the reply's `toolCalls`, `text` and `reasoning` (thinking text, when the server
  returns it), `finishReason`, `usage` (prompt, completion and reasoning tokens as reported),
  `durationMs`, `recovered` (calls recovered from text), and `error` (message) on failure.
- `ModelRequest` (in `packages/core`) gains two optional fields: `turnId` and `purpose`
  (`'turn' | 'checker' | 'rewrite' | 'judge' | 'prep' | 'audit'`). The director fills them in for
  the calls it makes, so a call can be tied to the turn it served in the event log. Both are optional,
  so nothing else changes.
- The CLI writes the records to `campaigns/<id>/sessions/NNN/calls.jsonl` during `sim run`
  (appending on `--resume`), with the same atomic-append approach as the event log. The event log and
  `EVENT_SCHEMA_VERSION` are unchanged.
- The file holds full prompts (a 60-minute session is tens of MB). It sits beside the event log in the
  git-ignored campaign folder.

### 2. Measured scores (`packages/core`, pure functions)

Computed per player seat from a session's events, and from its calls when `calls.jsonl` exists.

| Goal              | Measure                                                                                                                                          | Source              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Reliable and fast | first-try valid rate (turn calls answered with a usable tool call on attempt 0)                                                                  | calls               |
|                   | retries, fallbacks, and replies that ended at the token limit, per turn                                                                          | calls               |
|                   | median and 90th-percentile seconds per turn; median thinking tokens per turn                                                                     | calls               |
|                   | pauses caused by the seat                                                                                                                        | events              |
| Engaged           | share of all player words; spoken turns vs passes; interjections                                                                                 | events              |
|                   | mentions of other PCs, and of NPCs present, per spoken turn                                                                                      | events              |
|                   | repeated-text flags against the seat                                                                                                             | events              |
| Rules-savvy       | engine refusals of the seat's calls (tool errors) per turn                                                                                       | events              |
|                   | declared spells per turn; declared checks with a skill named                                                                                     | events              |
| Knows the world   | lore entity names used in the seat's lines (from the campaign's lore index entities)                                                             | events + lore index |
|                   | invention candidates: capitalized names in the seat's lines found in none of the lore entities, the transcript so far, the persona, or the party | events + lore index |

Each measure is a function from typed inputs to numbers, tested against fixture sessions with known
answers. Where an input is missing (no `calls.jsonl`, no lore index) the measure reports "not recorded"
rather than zero.

### 3. Judge

- A new optional `judge` seat in `campaign.json` (same shape as `checker`, fallbacks allowed). The
  avalon campaign starts with a local model on the M5 Max or Mac Studio, chosen when the baseline is run.
- **Sample:** up to 10 spoken or acted turns per player seat per session, chosen deterministically
  (seeded by session number and seat) so a rescore grades the same turns.
- **What the judge sees for each turn:** the player's persona; the last 12 transcript lines before the
  turn; the turn itself (the tool call and its text); and, for turns that declare an action or a spell,
  the top 3 rules excerpts from the rules index for that declaration. Once sub-project 2 lands, also
  the lore the player was given.
- **Rubric**, each 1–5 with a one-sentence reason, or `null` when it does not apply:
  `persona` (sounds like this character), `reactive` (responds to what just happened, including other
  PCs), `drives` (gives the scene somewhere to go), `rules` (the declaration is legal and sensible under
  the 2024 rules, judged against the excerpts; `null` for pure dialogue), `world` (fits the Cartyx
  setting and tone, invents nothing that contradicts what the player was told).
- The judge replies in JSON, parsed with the same tolerant reader as the checker's replies
  (`json-reply.ts`). An unreadable reply or a failed seat leaves that turn "not judged"; the score run
  never fails because of the judge.

### 4. Checking the judge

- `sim score --sample-for-rating --campaign avalon --sessions 15-19 --count 30` writes
  `campaigns/avalon/ratings/<date>.json`: 30 sampled turns with their context and an empty rating per
  rubric field, for the user to fill in (JSON, per the user's preference).
- `sim score --agreement --campaign avalon --ratings <file>` runs the judge on those turns and reports,
  per rubric field, the mean absolute difference and the share of turns within one point.
- **Trust threshold:** a field's judge scores are reported as trusted when the mean absolute difference
  is at most 0.75 and at least 80% of turns are within one point; otherwise the report marks that
  field "untrusted" next to its numbers.

### 5. `sim score`

- `sim score --campaign avalon --session 19` writes `score.md` and `score.json` next to `audit.md`:
  one row per player seat (seat, character, model), the measures as columns, the judge's mean per
  rubric field with its trust mark.
- `sim score --campaign avalon --sessions 15-19` also writes a comparison across sessions to
  `campaigns/avalon/scores/<range>.md`.
- `--no-judge` skips the judge (measured columns only).

## Baseline (the sub-project's deliverable)

1. Rescore sessions 15–19: event-log and judge columns (they predate the call log).
2. Play one fresh 15-minute session with the call log on, and score it with every column.
3. The user rates the 30-turn sample; record the judge's agreement.
4. Record the baseline, per model, in `docs/status.md` and in a new guide chapter.

## Error handling

- No `calls.jsonl`: reliability columns read "not recorded".
- No lore index: world measures read "not recorded"; the judge still runs.
- Judge down or unreadable: affected turns "not judged"; counts of judged turns shown per seat.
- A call-log write failure is logged once and does not stop the session.

## Testing

- Call log: client tests with the fake server in `packages/models/src/testing.ts` — one record per
  attempt across a retry and a fallback, error records, recovered calls, and the director passing
  `turnId` and `purpose`.
- Measures: fixture event logs and call logs with known answers, including sessions without a call log.
- Judge: prompt rendering (snapshot), reply parsing with canned good, partial and malformed replies.
- Agreement: the arithmetic and the trust threshold, tested directly.
- CLI: `sim score` end to end on a fixture session with a fake judge.

## Constraints

- `packages/core` stays free of file, network and native dependencies (measures are pure; I/O is in
  the CLI).
- Every new field is optional; sessions 001–019 still parse and audit; `EVENT_SCHEMA_VERSION` stays 1.
- Prettier passes on the whole repo; the existing tests keep passing, and new ones add to the count.

## Out of scope

- Player lore in prompts (sub-project 2), training data export (3), training (4), head-to-head
  comparison (5).
- Scoring the DM seat.
