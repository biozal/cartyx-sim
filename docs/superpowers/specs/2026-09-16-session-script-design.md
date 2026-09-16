# Session script (post-processing) — Design

**Date:** 2026-09-16
**Status:** Approved design; implementation plan not yet written
**Related:** v1 design §4 (event log), §8 (media), §9 (playback) (`2026-09-13-cartyx-sim-v1-design.md`); roadmap Plans 3 and 4 (`../plans/2026-09-13-cartyx-sim-v1-roadmap.md`); checker design (`2026-09-14-dm-pc-control-checker-design.md`)

## 1. Purpose

The pipeline has three stages: the AIs play a session (the event log), the session becomes a script that reads like a book, and the script is produced as voices, art, and a playback page. This design covers the middle stage, plus the TTS-ready contract that Plan 3 consumes.

`sim script` turns `events.jsonl` into:

- `script.json`: an ordered list of speaker-attributed lines, cleaned for TTS, with silent cues for rolls, scenes, combat, and state. This is the contract Plan 3 (voices, `timeline.json`) and Plan 4 (playback) read instead of raw events.
- `script.md`: a book-style rendering of `script.json` for reading.

**Out of scope:** audio, images, `timeline.json`, and the playback page (Plans 3 and 4); lore audit (Plan 2B); fixing the engine or prompts (the backlog item on keeping stage directions out of `speak` stays with Plan 2C).

### 1.1 The rule: reformat, never invent

The event log is the source of truth. Post-processing may only **drop** spans of source text, **split** source text into lines, **attribute** lines to speakers, and apply the fixed normalizations in §4.1. It never rewrites, paraphrases, or adds spoken words. Where a model is used, it returns labels only, never text (§5.3).

## 2. Evidence: what real logs contain

From avalon sessions 002–004 (checker on) and the checker-off control campaign:

- **No `npc_say` calls.** Across 002–004 the DM never used the NPC dialogue tool. Every NPC line is embedded in narration, e.g. 003 #73: `*"You... opened... the door,"* it rasps, the voice sounding like grinding stones.` The speaker has no `npc_introduced` event.
- **Stage directions inside `speak`**, mostly Kira: `"Holding its breath, you say. Or holding us for it." I keep my voice low, eyes drifting along the tree line… "Whatever made this place empty…"`.
- **Stray quotes**: unbalanced trailing quotes (Mira 003 #62, Kira 004 #7) and quotes wrapping part of a line.
- **Self-correction slips**: "Kira's — I mean, _my_ — take is this".
- **Markdown in narration**: bold, italics, bullets, and a leftover `**Hand off.**` (003 #73).
- **Leftover `DM:` prefixes** in narration.
- **DM-written PC dialogue** in checker-off runs.

## 3. Architecture

| Unit                     | Responsibility                                                                                                                                                    | Depends on                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `packages/script`        | Pure logic, no Node APIs (typechecked like `core`): script schema, normalization, speech and narration passes, attribution protocol, build, markdown rendering.   | `core` (event types, text helpers, hand-off detector) |
| `apps/cli/src/script.ts` | `sim script`: reads the log, checks the lock, loads `speakers.json`, implements `Labeler` with a `models` seat, caches answers, writes outputs, prints a summary. | `script`, `models`, `core`                            |

`packages/script` files:

| File             | Contents                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `schema.ts`      | zod schemas for `script.json` and `speakers.json`; `SCRIPT_SCHEMA_VERSION`.                           |
| `normalize.ts`   | Normalization passes (§4.1); each maps output text back to source offsets.                            |
| `speech.ts`      | PC `speak`/`interject` splitting and stage-direction drops (§5.1).                                    |
| `narration.ts`   | `DM:` and hand-off removal, markdown, paragraph split, quoted-span detection, applying labels (§5.2). |
| `attribution.ts` | `Labeler` interface, prompt builder, reply parser and validation, rules fallback (§5.3).              |
| `build.ts`       | Events → script: speaker table, line ids, overlaps, cues, notes (§5.4–5.6).                           |
| `markdown.ts`    | Script → book markdown (§6).                                                                          |

Plan 3 reads `script.json`; its `timeline.json` references script line ids instead of event seqs. This is recorded as a roadmap deviation.

## 4. Files and data model

```
campaigns/<id>/sessions/NNN/
  events.jsonl        input, never modified
  speakers.json       optional, hand-edited speaker renames and merges
  script.json         output
  script.md           output
  .script-cache/      cached model answers, one JSON file per content hash
```

### 4.1 Normalizations

These are the only transformations applied to kept source text. Each is implemented once in `normalize.ts` and used by both the build and the invariant test:

1. Remove markdown emphasis markers (`*`, `_`, `**`, `__`), heading marks (`#` at line start), and bullet markers (`-`, `*`, `+`, `1.` at line start). A bullet item's text becomes its own sentence: a terminal period is added when it has no terminal punctuation.
2. Remove a leading `DM:` (optionally bold) at the start of the text or a paragraph.
3. Remove wrapping, doubled, and unbalanced straight or curly double quotes around a spoken line.
4. When a quote is split out of narration, a comma directly before its closing quote becomes a period.
5. Collapse runs of whitespace within a line to one space and trim the ends.

### 4.2 `script.json`

```json
{
  "scriptSchemaVersion": 1,
  "campaign": "avalon",
  "session": 3,
  "eventsSha256": "…",
  "speakers": [
    { "id": "dm", "name": "Dungeon Master", "kind": "dm" },
    { "id": "kira", "name": "Kira Vale", "kind": "pc" },
    {
      "id": "npc-faceless-creature",
      "name": "Faceless creature",
      "kind": "npc",
      "unlisted": true,
      "firstSeq": 73
    }
  ],
  "lines": [
    {
      "id": "L0012",
      "kind": "dialogue",
      "speaker": "kira",
      "text": "Holding its breath, you say. Or holding us for it.",
      "emotion": "neutral",
      "sources": [{ "seq": 7, "start": 1, "end": 51 }],
      "dropped": [
        {
          "seq": 7,
          "start": 52,
          "end": 139,
          "reason": "stage_direction",
          "text": "I keep my voice low, …"
        }
      ]
    },
    {
      "id": "L0040",
      "kind": "roll",
      "sources": [{ "seq": 18 }],
      "roll": { "actor": "kira", "label": "…", "total": 16, "target": 12, "outcome": "success" }
    }
  ],
  "notes": [{ "seq": 73, "text": "Quote 2 attributed by rules fallback: model reply invalid." }]
}
```

Line fields:

- `id`: `L` plus a zero-padded ordinal, stable for a given log, cache, and `speakers.json`.
- `kind`: voiced kinds `narration`, `dialogue`, `action`; silent kinds `roll`, `scene`, `combat`, `state`, `pause`.
- Voiced lines carry `speaker`, `text`, `emotion` (from the event; embedded NPC quotes take `neutral`), and `sources` with character offsets into the event's text field (`text` for narration and dialogue, `intent` for actions).
- `dropped` (optional): removed spans with a reason (`stage_direction`, `hand_off`, `dm_prefix`), kept for `script.md` and review.
- `overlaps` (optional): the line id of the line an interjection talks over (from the event's `overlaps` seq, mapped to the first line built from that event).
- `flags` (optional): `dm_wrote_pc` with the PC id (§5.3).
- Silent lines have `sources` entries with `seq` only (no offsets) and carry structured data only: `roll` (actor, label, total, target, outcome, mode, subject), `scene` (location, artPrompt, loreEntityId), `combat` (`start` with order, `turn` with round and combatant, `end`), `state` (entity, field, before, after), `pause` (reason).

### 4.3 `speakers.json`

```json
{ "npc-thing": { "id": "npc-faceless-creature", "name": "The Faceless One" } }
```

Each key is a speaker id as the build produces it. `id` (optional) merges it into another speaker; `name` (optional) sets the display name. It is applied after attribution and wins on every run. An unknown key, a merge into an unknown id, or a merge into a PC or the DM is an error.

## 5. Processing

The build reads the log in order and uses public events only. State needed for names (party from `session_start`, `combatant_added`, `npc_introduced`) is folded as it goes.

### 5.1 PC `dialogue` (from `speak` and `interject`), rules only

- If the text contains at least one balanced quoted span **and** non-whitespace text outside quotes, each quoted span becomes a `dialogue` line and each outside span is dropped as `stage_direction`.
- Otherwise the whole text is one line, with stray or wrapping quotes removed (§4.1.3).
- Markdown emphasis is removed. Slips such as "Kira's — I mean, _my_ — take" are kept as spoken: fixing them would need rewriting.

### 5.2 DM `narration`

1. Remove leading `DM:` markers (dropped as `dm_prefix`).
2. Remove hand-off prose with core's `extractHandOffProse` (dropped as `hand_off`), so `**Hand off.**` and "Hand off to …" lines are caught by the engine's own detector.
3. Remove markdown (§4.1.1).
4. Split on blank lines; each paragraph is processed separately.
5. Find double-quoted spans (straight or curly, optionally wrapped in emphasis). A paragraph with none becomes one `narration` line.
6. A paragraph with quoted spans is labeled (§5.3) and split: text before a speech span stays `narration`, the span becomes a `dialogue` line for its speaker, and the text after continues as `narration` (for example `it rasps, the voice sounding like grinding stones.`). Spans labeled `none` stay inside the narration.

### 5.3 Attribution of quoted spans

`Labeler` interface: `label(request) → Promise<SpanLabel[] | null>`. One request per narration event with at least one quoted span. It contains the full cleaned narration with spans numbered in place, the NPCs introduced so far (id, name, description), the PC ids and names, and the `new:` labels already assigned this session.

Each label is one of:

- an existing NPC id;
- `new:<short label>`: creates speaker `npc-<slug>` (core's `slugify`), `unlisted: true`, `firstSeq` set; a later `new:` label with the same slug reuses it;
- a PC id: the DM wrote that PC's dialogue. The line stays in the **DM's voice** with `flags: { dm_wrote_pc: <id> }`, so the script never presents it as the player's words;
- `none`: not speech (a scare quote, an inscription, a single word); stays in the narration.

Validation (zod): every span labeled exactly once, every id known or in `new:` form. An invalid reply gets one retry with the error; after that, the **rules fallback** labels each span: the single NPC introduced since the last `scene_change` if there is exactly one, else `npc-unnamed`. Each fallback adds a `notes` entry. A `--no-model` run uses the fallback for every span.

Because the model returns labels only, all text in the script comes from the log.

**Cache:** key = SHA-256 of prompt version, model id, and request JSON. A hit skips the model. `--refresh` ignores hits and overwrites them.

**Seat:** a new optional `seats.script` in `campaign.json`, same shape as other seats. When absent, `seats.checker` is used; when neither exists, the run behaves as `--no-model` and says so. The seat's fallbacks and timeout apply as usual. A seat failure after fallbacks uses the rules fallback for that event, adds a note, and continues.

### 5.4 PC `action`

Each `action` event becomes one `action` line in the actor's voice: the intent with markdown removed. Its `emotion` is `neutral`.

### 5.5 Silent cues

| Event                                                           | Line     |
| --------------------------------------------------------------- | -------- |
| `roll`                                                          | `roll`   |
| `scene_change`                                                  | `scene`  |
| `combat_start`, `combat_turn`, `combat_end`                     | `combat` |
| `state_change` on `hp`, `conditions`, or `dead` (becoming true) | `state`  |
| `session_paused` followed by a resume                           | `pause`  |

Not in the script: `hand_off`, `turn_end`, `pass`, `validator_flag`, `ooc_note`, `lore_lookup`, `lore_invention`, `npc_introduced` (used for speakers only), `combatant_added`, `session_start`, `session_end`, and other `state_change` fields.

### 5.6 Invariants

- For every voiced line, applying §4.1 to the concatenated `sources` spans yields `text`.
- For every spoken event, its kept spans plus dropped spans plus normalization-removed characters cover the whole source text.
- No two lines share an id; lines are in log order.

## 6. `script.md`

Rendered from `script.json` only:

- Title and header: campaign, session, spoken words, line counts, unlisted speakers.
- A `##` heading per `scene` line.
- Narration as plain paragraphs under a bold `DM` label when the previous line had a different speaker.
- Dialogue as `**Name:** text`; NPC names from the speaker table; `dm_wrote_pc` lines labeled `**DM (as Name):**`; interjections marked `(interrupting)`.
- Dropped stage directions as an italic aside after the line (`*— I keep my voice low, …*`).
- Actions as `> *Name:* intent`.
- Rolls as `> 🎲 label — total N, outcome`; monster AC and HP hidden, as in the player transcript.
- Combat and state cues as short italic lines; pauses as a horizontal rule with a note.

## 7. Command

```
npm run sim -- script --campaign avalon --session 3 [--no-model] [--refresh] [--campaigns-dir <dir>]
```

- Refuses when the session lock is held by a live process, or when `session_start` carries an unknown schema version.
- Reads the log with the existing torn-line recovery.
- Writes `script.json` and `script.md` atomically (temp file, then rename). Never writes to `events.jsonl`.
- Prints a summary: lines by kind, speakers (unlisted marked), labels by source (model, cache, fallback), stage directions dropped, notes.
- Exit 0 on success; 1 on a bad `speakers.json`, a missing session, a held lock, or an unknown schema version.

## 8. Testing

- **Unit tests per pass**, with fixtures copied from the real quirks in §2 (trimmed excerpts; `campaigns/` is git-ignored).
- **Invariant tests** (§5.6) run over every fixture and over the full build of each fixture log.
- **Attribution**: a scripted fake `Labeler` covering a valid reply, an invalid reply then a valid retry, two invalid replies then fallback, a `new:` label reused across events, a PC label producing `dm_wrote_pc`, and `none`.
- **Cache**: hit, miss, and `--refresh`.
- **`speakers.json`**: rename, merge, and each error case.
- **CLI**: a small fixture session end to end, checking both files and a `script.md` snapshot.
- **Manual (not CI)**: run on avalon 002–004 and the checker-off control session; read the output and record findings in `docs/status.md`.

Every commit passes `npm run typecheck`, `npm test`, and `npm run format:check`.

## 9. Documentation

- `docs/running-a-session.md`: new §8 "Make a script".
- `docs/status.md`: the new command and the manual-run findings.
- Roadmap: Plan 3 reads `script.json` and `timeline.json` references line ids (deviation); `seats.script` noted.

## 10. Next

After this lands, run a 1-hour session and script it. That run is the first long real input for this stage and is planned separately.
