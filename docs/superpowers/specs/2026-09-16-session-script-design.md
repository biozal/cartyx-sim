# Session script (post-processing) — Design

**Date:** 2026-09-16
**Status:** Approved design; implementation plan not yet written. §5.1 amended 2026-09-16 to add the direction rule.
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

1. Remove markdown emphasis markers (`*`, `_`, `**`, `__`), heading marks (`#` at line start), and bullet markers (`-`, `*`, `+`, `1.` at line start).
2. Remove a leading `DM:` (optionally bold) at the start of the text or a paragraph.
3. Remove every double quote mark (straight or curly) from PC and NPC speech, action text, and narration.
4. After whitespace is collapsed, a line ending in `,` `;` or `:` ends in `.` instead, and a line with no ending punctuation (`. ! ? … — – - ' ’ ) ]`) gets a `.`; text with no letters or digits produces no line.
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
- `flags` (optional): `dmWrotePc` with the PC id (§5.3).
- Silent lines have `sources` entries with `seq` only (no offsets) and carry structured data only: `roll` (actor, label, total, target, outcome, mode, subject), `scene` (location, artPrompt, loreEntityId), `combat` (`start` with order, `turn` with round and combatant, `end`), `state` (entity, field, before, after), `pause` (reason).
- A note may carry `dropped` spans for an event that produced no line.

### 4.3 `speakers.json`

```json
{ "npc-thing": { "id": "npc-faceless-creature", "name": "The Faceless One" } }
```

Each key is a speaker id as the build produces it. `id` (optional) merges it into another speaker; `name` (optional) sets the display name. It is applied after attribution and wins on every run. An unknown key, a merge into an unknown id, or a merge into a PC or the DM is an error.

## 5. Processing

The build reads the log in order and uses public events only. State needed for names (party from `session_start`, `combatant_added`, `npc_introduced`) is folded as it goes.

### 5.1 PC `dialogue` (from `speak` and `interject`), rules only

- The text is split into quoted spans and dialogue lines when either path holds. When it splits, each quoted span becomes a `dialogue` line and each outside span is dropped as `stage_direction`.
  - **The quote-majority path** (unchanged): it contains at least one balanced quoted span; the first kept character is a quote mark; the text outside the quotes has words; and the quoted text is at least half of the text's non-space characters.
  - **The direction path**: every quote span is closed and reads as a whole sentence (its first kept letter is uppercase, its last kept non-space character one of `. , ! ? … — –`); the text outside the quotes has words; and every clause of every outside gap with words is a direction. A gap is split into clauses at `[.!?…]` followed by whitespace, at `;`, `:`, `—`, `–`, and at newlines, each clause trimmed with any trailing `.!?…` stripped before matching (apostrophes `’‘ʼ` are normalized to `'` first). A clause whose trailing punctuation contains `?` is never a direction; this is checked before the punctuation is stripped. Otherwise a clause is a direction only when it **parses completely** under this fixed grammar (a tiny token-based matcher, not one giant regex, since a couple of slots need case-sensitivity a case-insensitive regex can't mix in) — not just a match at its start:
    - **ADVERB** (closed list, case-insensitive): `quietly`, `softly`, `slowly`, `firmly`, `sharply`, `calmly`, `grimly`, `flatly`, `dryly`, `coldly`, `gently`, `lowly`, `finally`, `quickly`, `again`, `barely`, `carefully`, `evenly`, `tightly`, `warmly`, `wearily`. Every adverb slot uses this list, not a generic `\w+ly` match, so a real word that happens to end in "ly" ("early", "only") never passes as one.
    - **GERUND** (closed list): `drawing`, `stepping`, `pointing`, `glancing`, `nodding`, `looking`, `turning`, `leaning`, `gesturing`, `shrugging`, `smiling`, `grinning`, `frowning`, `sighing`, `raising`, `lowering`, `backing`, `keeping`, `reaching`, `gripping`, `tightening`, `crossing`, `shaking`, `tilting`, `narrowing`, `moving`, `watching`, `holding`, `resting`, `straightening`, `crouching`, `kneeling`. A word merely ending in "ing" ("morning", "burning", "knowing", "meaning") is not on this list and cannot start a participle clause.
    - **PRONOUN** = `him`/`her`/`them`/`you`/`it`/`me`/`us`, lowercase only (a capitalized `You` in `I nod to You.` is an address, not an object).
    - **DET** = `the`/`my`/`his`/`her`/`their`/`a`/`an`/`our`/`your`.
    - **NOUN_SLOT** = a DET plus exactly one lowercase word (`the door`), and that word must not be a stoplist word (below).
    - **NAME_SLOT** = a single token that is a **known name** (`Bram`), matched case-sensitively, that is not (case-insensitively) a stoplist word. The known names are passed in by the builder: every word of every party member's name and of every NPC introduced so far (`npc_introduced`), keeping only words matching `^[A-Z][a-z]+$` (Tomas Reed gives `Tomas` and `Reed`). They apply to PC and NPC speech alike. With no known names, NAME_SLOT never matches, so a capitalized interjection is never taken for a name (`I nod, looking at Once!`, `I nod to Everyone.`). The speaker's own names are separate: they are TAG subjects (below), as before.
    - **OBJECT** has two forms, depending on context. The only two places a clause can carry a word not on a fixed list are NOUN_SLOT's noun and NAME_SLOT's name.
      - **After a PREP** (inside a GERUND_PHRASE, or as TARGET): PRONOUN | NOUN_SLOT with any DET | NAME_SLOT.
      - **BARE_OBJECT**, directly after a GERUND with no PREP: only `him`/`her`/`them`/`it`/`me`/`us` (not `you`), or a NOUN_SLOT whose DET is a possessive `my`/`his`/`her`/`their`/`our` (not `your`). A NAME_SLOT or a `the`/`a`/`an`/`your` noun slot is not allowed here (`, keeping the peace` and `, pointing Ready` do not parse).
    - A word that can be both a DET and a PRONOUN (`her`) is tried both ways; the clause parses if either choice reaches its end (`I glance at her sword.`, `I glance at her.`).
    - **The stoplist**, checked only at NOUN_SLOT and NAME_SLOT: `I`, `I'm`, `I'll`, `we`, `we're`, `you`, `you're`, `he`, `she`, `they`, `it's`, `let's`, `is`, `are`, `am`, `was`, `were`, `be`, `will`, `would`, `should`, `must`, `can`, `could`, `shall`, `may`, `might`, `do`, `does`, `did`, `have`, `has`, `had`, `go`, `going`, `want`, `wants`, `need`, `needs`, `say`, `says`, `said`, `tell`, `mean`, `meaning`, `know`, `knowing`, `think`, `nothing`, `something`, `everything`, `yes`, `no` (case-insensitive).
    - **PREP** (general, inside a participle) = `at`/`toward`/`towards`/`to`/`between`/`from`/`over`/`through`/`past`/`behind`/`into`/`on`. `in` is not a PREP; it is only a PARTICLE, so `, stepping in` parses but `, stepping in her way`, `, stepping in your turn` and `, looking back in Wait` do not.
    - **PARTICLE** = `back`/`away`/`forward`/`still`/`down`/`up`/`out`/`in`/`aside`.
    - **GERUND_PHRASE** = `(ADVERB)? GERUND (PARTICLE (PREP OBJECT)? | PREP OBJECT | BARE_OBJECT)? (ADVERB)?`. After a PARTICLE an object needs its PREP (`, stepping back toward Bram` parses; `, stepping back Wait` and `, looking back my lord` do not).
    - **A participle clause** = a comma, one GERUND_PHRASE, optionally `and` and a second GERUND_PHRASE, and it must end the clause — nothing may follow it, and a second comma always fails the match, so there is no free-form tail left anywhere (`, drawing my blade and stepping between them` passes; `, holding this bridge costs too many lives` fails because "this" is not a DET and "costs" isn't a recognized continuation).
    - **TAG**: `I` plus a bare speech verb (`say`, `add`, `reply`, `mutter`, `murmur`, `whisper`, `call`, `ask`, `answer`, `hiss`, `snap`, `shout`, `continue`, `grumble`), or `he`/`she`/`they`/one of the speaker's own names (PCs only) plus its conjugated form (`says`/`said`, `adds`/`added`, …, with `ask`/`call`/`answer` left out for third person, since "they ask about the road" reads as a reported habit, not an attribution); then only an optional "it", one ADVERB, and at most one participle clause — nothing else.
    - **ACTION**: `I` plus a short body-language verb (`nod`, `shrug`, `sigh`, `grin`, `smile`, `frown`, `wince`, `exhale`, `swallow`, `glance`, `straighten`, `crouch`, `kneel`), then only an ADVERB, a TARGET (`nod` and `glance` only — see below), another ADVERB, and at most one participle clause — nothing else. `step` and `lean` were removed from this list: both take a direction word too easily mistaken for a real TARGET (`I step up to the plate.`, `I lean towards mercy.`).
    - **TARGET** (only after `nod`/`glance`) = `at`/`toward`/`towards`/`to` plus one OBJECT, parsed with the same OBJECT grammar as a participle's object — so a trailing adverb is never swallowed into it (`I glance at Bram quietly.`: TARGET is "at Bram", "quietly" is the trailing ADVERB).
    - Every list matches case-insensitively except that `I` itself must stay uppercase, and PRONOUN and NAME_SLOT, which are checked case-sensitively on purpose.
- Otherwise the whole text is one line, with stray or wrapping quotes removed (§4.1.3).
- **The guarantee:** a clause is dropped only when it does not end in `?` and parses completely under this grammar, whose only open slots are NOUN_SLOT's one lowercase noun after a determiner and NAME_SLOT's one known name after a preposition — neither of which may be a stoplist word. **Known cost:** this is a rules heuristic, not a proof, and it has two costs. A real direction that doesn't parse is voiced whole. Speech that happens to parse is dropped. The grammar is kept narrow to make the second case unlikely. Separately, and unchanged from the approved design, the quote-majority path above can still drop outside text that is itself speech when the quoted text is at least half the line (for example `"Who scouts first tonight?" We send Molly.` drops "We send Molly." whole); the clause check is not applied there.
- Markdown emphasis is removed. Slips such as "Kira's — I mean, _my_ — take" are kept as spoken: fixing them would need rewriting.

### 5.2 DM `narration`

1. Remove leading `DM:` markers (dropped as `dm_prefix`).
2. Remove hand-off prose with core's `extractHandOffProse` (dropped as `hand_off`), so `**Hand off.**` and "Hand off to …" lines are caught by the engine's own detector.
3. Remove markdown (§4.1.1).
4. Split on blank lines; each paragraph is processed separately. Heading and list-item lines are paragraphs of their own.
5. Find double-quoted spans (straight or curly, optionally wrapped in emphasis). A paragraph with none becomes one `narration` line.
6. A paragraph with quoted spans is labeled (§5.3) and split: text before a speech span stays `narration`, the span becomes a `dialogue` line for its speaker, and the text after continues as `narration` (for example `it rasps, the voice sounding like grinding stones.`). Spans labeled `none` stay inside the narration.

### 5.3 Attribution of quoted spans

`Labeler` interface: `label(request) → Promise<SpanLabel[] | null>`. One request per narration event with at least one quoted span. It contains the full cleaned narration with spans numbered in place, the NPCs introduced so far (id, name, description), the PC ids and names, and the `new:` labels already assigned this session.

Each label is one of:

- an existing NPC id;
- `new:<short label>`: creates speaker `npc-<slug>` (core's `slugify`), `unlisted: true`, `firstSeq` set; a later `new:` label with the same slug reuses it;
- a PC id: the DM wrote that PC's dialogue. The line stays in the **DM's voice** with `flags: { dmWrotePc: <id> }`, so the script never presents it as the player's words;
- `none`: not speech (a scare quote, an inscription, a single word); stays in the narration.

Validation (zod): every span labeled exactly once, every id known or in `new:` form. An invalid reply gets one retry with the error; after that, the **rules fallback** labels a quote of fewer than 3 words `none`, and every other quote as the single NPC introduced since the last `scene_change` if there is exactly one, else `npc-unnamed`. Each fallback adds a `notes` entry. A `--no-model` run uses the fallback for every span.

Because the model returns labels only, all text in the script comes from the log.

**Cache:** key = SHA-256 of prompt version, model id, and request JSON. A hit skips the model. `--refresh` ignores hits and overwrites them.

**Seat:** a new optional `seats.script` in `campaign.json`, same shape as other seats. When absent, `seats.checker` is used; when neither exists, the run behaves as `--no-model` and says so. The seat's fallbacks and timeout apply as usual. A seat failure after fallbacks uses the rules fallback for that event, adds a note, and continues.

### 5.4 PC `action`

Each `action` event becomes one `action` line in the actor's voice: the intent with markdown removed. Its `emotion` is `neutral`.

### 5.5 Silent cues

| Event                                                                                                        | Line     |
| ------------------------------------------------------------------------------------------------------------ | -------- |
| `roll`                                                                                                       | `roll`   |
| `scene_change`                                                                                               | `scene`  |
| `combat_start`, `combat_turn`, `combat_end`                                                                  | `combat` |
| `state_change` on `hp`, `conditions`, or `dead` (becoming true)                                              | `state`  |
| `session_paused` followed by a resume (detected regardless of visibility; the engine logs pauses as DM-only) | `pause`  |

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
- Dialogue as `**Name:** text`; NPC names from the speaker table; `dmWrotePc` lines labeled `**DM (as Name):**`; interjections marked `(interrupting)`.
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
- **Attribution**: a scripted fake `Labeler` covering a valid reply, an invalid reply then a valid retry, two invalid replies then fallback, a `new:` label reused across events, a PC label producing `dmWrotePc`, and `none`.
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
