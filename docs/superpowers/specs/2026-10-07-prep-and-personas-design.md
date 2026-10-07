# Session prep, PC personas, and ambient lore — Design

**Date:** 2026-10-07
**Status:** Approved design
**Related:** v1 design §6.1 (campaign layout and `tone`), §7 (`sim prep`), §10 (lore audit) (`2026-09-13-cartyx-sim-v1-design.md`); the lore subsystem (`2026-10-07-lore-index-design.md` — see note below); session 014 in `docs/status.md`; the roadmap's Plan 2C row

> The lore design doc is dated 2026-09-20 in its filename: `2026-09-20-lore-index-design.md`.

## 1. Why

Session 014 was the first run against a real lore index: 6,833 chunks from 2,073 files, retrieval answering in ~40 ms, the audit working end to end. Its coverage section reads, verbatim:

> No lore was used.
>
> NPCs introduced: 0 (0 invented).
>
> Scenes: 3 (0 tied to lore).

The session consulted the index **once**, for "Whispering Crossroads" — a place the DM had just invented. That lookup correctly returned a gap, because the phrase appears nowhere in `cartyx-lore`.

This is not a retrieval defect. The cause is visible in the prompt. A DM's first turn sees:

```
Party: (4 PCs with stats)
Other combatants: - none
NPCs: - none
Scene: not set
Recent events: (the session is just starting)
```

Nothing identifies the world. The system prompt says "You are the Dungeon Master for a Dungeons & Dragons 5e session" and, six lines later, "Look up lore with lookup_lore before inventing details." The model is asked to search a world it does not know exists, for a place it has not thought of yet. Inventing a location is the only move available.

The same hole exists on the player side: "You are playing Kira Vale (id: kira) in a Dungeons & Dragons 5e session", plus mechanics. The models improvise a personality from a name and a stat block, with no backstory, no motivation, and no tie to the world.

Lookups per session across the whole history — 005: 3, 008: 6, 010: 1, 011: 4, 012: 2, 013: 3, 014: 1 — show this was never about the index. Plan 2B made retrieval correct. It did not give anyone a reason to use it.

## 2. Scope

**In:** a standing campaign premise; PC personas with optional lore-entity ties; ambient lore retrieval on scene change and at session start; `sim prep`; the prompt changes that carry all three; and the measurement loop that tells us whether it worked.

**Out:** the rest of Plan 2C — SRD 5.2.1 import, SRD-backed spell validation, `award_milestone`, the scribe (scene summaries, recap, DM notes, journals), `sim chargen`, class primers, a class field on PCs, player target-id validation. Also out: the audit's "backstory hooks" section, which this design unblocks but does not build.

The narrow scope is deliberate. The fastest way to learn whether prompting is really the bottleneck is to change only prompting, and measure.

## 3. Standing premise

`campaign.json` gains an optional `premise`:

```json
"premise": {
  "world": "Cartyx — a fantasy version of the real world. Steampunk, fantasy and modern elements mixed.",
  "region": "The Atlanta metro area, Georgia.",
  "party": "Students at Avalon Artificers Academy in Alpharetta.",
  "tone": "Cozy suburban mystery: pranks, bake-offs, lost prototypes. Nobody is evil; nothing is a conspiracy."
}
```

All four fields are optional strings; the object itself is optional, so every existing campaign, fixture and test loads unchanged. It threads `Campaign` → `DirectorConfig` → the DM system prompt.

**It goes before the mechanical rules.** A model needs to know what world it is in before it is told how dice work. v1 design §6.1 already listed a `tone` field for `campaign.json` that was never built; this is that field, widened to carry the world, the region and the party's place in it.

A campaign with no `premise` behaves exactly as today.

## 4. PC personas

`characters/<pc>.json` gains an optional `persona`:

```json
"persona": {
  "backstory": "...",
  "motivation": "...",
  "personality": "...",
  "ties": "...",
  "loreEntityIds": ["kanka-2418574"]
}
```

**It is kept out of `Combatant`.** That schema is purely mechanical and shared with monsters and NPCs — a goblin has no motivation, and `Combatant` is serialized into `session_start.party` in every log. `loadCampaign` reads the persona and returns it beside the party, leaving the mechanical shape untouched.

**The director copies it into `session_start`.** The log stays self-contained: an audit of session 14 reads the personas session 14 was played with, not whatever the files say months later. That is the principle every other part of this engine follows, and it is what will let the audit's "backstory hooks" section work later without a redesign. Cost is a few KB per log against thousands of events.

**Who sees what:**

- Each player seat gets **its own** persona in its system prompt, in full.
- Players do **not** see each other's personas — the same isolation `PlayerView` already enforces for monster stats.
- The DM gets **one line per PC** (name, motivation, ties). A DM that does not know Kira's motivation cannot write a hook for it.

**`loreEntityIds`** are optional wiki entity ids. They seed ambient retrieval at session start (§5), so the DM opens a session already holding lore about the party's own families, mentors and home town. This turns a backstory from a floating paragraph into a hook into the world.

## 5. Ambient lore

The director retrieves lore itself, rather than waiting to be asked:

- **At session start**, from the union of the party's `persona.loreEntityIds`.
- **On `scene_change`** with a location, from that location's name.

Results go into the next DM prompt. `lookup_lore` remains available for anything else the DM wants.

**Ambient retrieval emits a normal `lore_lookup` event**, with a new optional field:

```ts
trigger: z.enum(['scene', 'party', 'tool']).optional();
```

Optional, so sessions 001–014 still parse, and `EVENT_SCHEMA_VERSION` stays 1.

This is the decision that holds the measurement together. `sim audit` needs **no changes**: coverage counts entities on used hits, and a gap is still "nothing cleared the threshold". An ambient lookup that finds nothing becomes a genuine finding — _the DM moved somewhere the lore does not cover_ — which is exactly what the audit exists to report. And there is one definition of "lore was used", not two.

Retrieval goes through the existing `lore` seat, inheriting its retry-and-pause path. **A retrieval failure degrades to no ambient lore for that turn rather than failing the turn**, matching the call made for the audit's contradiction pass: a lore outage should not end a session.

## 6. `sim prep`

```
sim prep --campaign <id> --session <n> [--location "<name>"] [--force]
```

Writes `campaigns/<id>/prep/session-<NNN>.md` (v1 design §7).

### 6.1 Choosing the place

- With `--location`, prep retrieves that name and uses the best-scoring real entity.
- Without it, prep retrieves candidates anchored to `premise.region` and asks the DM seat to choose one, recording which it picked.

Either way the opening scene is an **indexed entity with a real `entityId`** — never invented.

**If nothing clears the relevance threshold, prep fails loudly** with the queries it tried. It does not invent a location. A prep file naming a made-up place would reintroduce the exact problem this design exists to fix, one step earlier in the pipeline.

### 6.2 What it writes

The spec's shape — hook, 3–5 scenes, NPCs with motives, secrets and clues, likely endings — under a machine-readable header:

```markdown
---
session: 14
location: Alpharetta
locationEntityId: kanka-1465238
loreChunkIds: [dm/regions/south/cities/alpharetta.md#alpharetta, kanka-export/...]
generatedAt: 2026-10-07T18:00:00.000Z
---

## Hook

...
```

**Only the header is parsed.** The body is prose for the model and for the operator. Task 13 established that parsing model-written markdown is a failure mode worth designing around, so nothing structural depends on the prose. A malformed header is an error; malformed prose is not.

### 6.3 Editing and overwriting

The outline is the operator's to edit, and runs do not require review (§7). Without `--force`, prep refuses to overwrite an existing file; with it, it rewrites.

### 6.4 Injection

The whole outline — header and body — goes into the DM system prompt, every turn, for the session.

Every turn rather than once: the transcript window is 30 lines, and session 005 showed an NPC introduced at event 98 being contradicted 40 minutes later because its description had scrolled out of view. The fix then was to put NPC descriptions in the prompt permanently. The same reasoning applies to a session outline.

## 7. Missing prep

`sim run` **warns and plays** when a lore-backed campaign has no prep file for the session, with the premise still in the prompt.

This keeps `sim run` usable alone, matches §7's "runs do not require review", and means a prep failure never blocks a session. The audit will show the difference between a prepped and an unprepped run, which is itself the measurement.

## 8. How we will know it worked

The three numbers that read **zero** in session 014 are the test:

| Measure             | Session 014 | Target        |
| ------------------- | ----------- | ------------- |
| Entities covered    | 0           | > 0           |
| Scenes tied to lore | 0 of 3      | most of them  |
| Lore lookups        | 1 (a gap)   | several, hits |

**Iterate with 10–15 minute sessions**, reading `audit.md`'s coverage section after each. A full 1-hour run only once coverage is real — an hour per iteration is too slow a loop for prompt work, and the coverage numbers are visible within a few scenes.

Two cautions on the measurement itself. Ambient retrieval will raise the lookup count mechanically, so **the number to watch is entities covered and scenes tied to lore**, not lookups. And `sim bench`'s trials have already proved misleading for live behaviour (v1 §13 and the session-010 notes), so a short session is the shortest honest test, not a bench trial.

## 9. Risks

1. **Prompt growth.** Premise, persona summary, outline and ambient chunks land on every DM turn, against prompts that measured 0.8–15.6k characters in session 005. Watch DM latency and watch the word share, which the session-012 batch worked hard to bring down from 79%.
2. **Ambient lore crowding the transcript.** Eight chunks of prose per scene competes with the 30-line window for the model's attention. The result may be that ambient hits need a tighter cap than `lookup_lore`'s eight.
3. **The threshold is still untested in anger.** 0.69 was calibrated on five clean queries with a 0.102 margin, and session 014 never exercised it. Ambient retrieval will exercise it hard and immediately — if the audit reports gaps for lore that demonstrably exists, lower `loreThreshold` in `campaign.json`.
4. **A premise is a prompt, not a guarantee.** Session 014 already carried an instruction to look lore up and ignored it. This design's bet is that the instruction failed for want of a world to look up, not for want of emphasis — and ambient retrieval is the hedge that does not depend on the model choosing to be curious.
5. **Prep adds a model call chain before a session.** A bad prep outline will steer a whole session. `--force` and hand-editing are the escape hatches.

## 10. Testing

- **Pure and unit-testable:** premise rendering, persona rendering (including the DM's one-line-per-PC summary and the player's full block), prep header parsing, and the "who sees what" isolation.
- **Director tests with a stub `LoreIndex`:** ambient retrieval fires at session start and on `scene_change`, emits `lore_lookup` with the right `trigger`, and a retrieval failure degrades to no ambient lore instead of failing the turn.
- **`sim prep` tests** with a `FakeEmbedder` and a stub `ModelClient`: a pinned `--location`, a model-chosen location, the refusal when nothing clears the threshold, the refusal to overwrite without `--force`.
- **Backward compatibility:** a campaign with no `premise`, characters with no `persona`, and a session log with no `trigger` field all behave as today. Sessions 001–014 must still parse and audit.
- No test may make a network call. The gated known-answer tests remain the only live-endpoint tests.

## 11. Deviations from the v1 spec

- **`campaign.json`'s `tone` becomes a `premise` object.** §6.1 listed a bare `tone`; a single adjective cannot anchor a world, so it carries `world`, `region`, `party` and `tone`.
- **Ambient retrieval is new.** §7 and §5.4 describe lore reaching the DM only through `lookup_lore`. Session 014 showed that a model with the tool and the instruction still does not use them, so the engine now retrieves on the DM's behalf and records it as a lookup with a `trigger`.
- **PC personas live beside the mechanical party, and in `session_start`.** The v1 spec puts backstories in `sim chargen` (Plan 2C); this design adds the data shape and the injection without the generator, so personas are hand-written for now.
- **Prep carries a parsed front-matter header.** §7 describes prose only. The header exists so no engine behaviour depends on parsing model-written prose.
