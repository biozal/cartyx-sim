# Plan 2B — Lore index, retrieval, and audit — Design

**Date:** 2026-09-20
**Status:** Approved design
**Related:** v1 design §3 (packages), §4.2 (events), §5.4 (tools), §6.1 (layout), §6.4 (lore versioning), §10 (lore audit), §11 (CLI), §13 (testing) (`2026-09-13-cartyx-sim-v1-design.md`); the roadmap's Plan 2B row and backlog (`../plans/2026-09-13-cartyx-sim-v1-roadmap.md`); the run findings in `docs/status.md`

## 1. Why

The simulation exists to test `cartyx-lore`. Today it cannot: there is no lore index, so every `lookup_lore` reports a gap, the DM invents a detail and records it, and the audit that was supposed to measure coverage has nothing to measure. Across nine 1-hour sessions the lore lines of every run read the same way — session 005's "3 lookups (all gaps, as expected before Plan 2B) and 4 inventions".

Plan 2B makes lore real: ingest the lore repository, embed it, answer `lookup_lore` from it, and report afterwards what the lore covered, what it missed, and where the DM may have contradicted it.

## 2. Scope

**In:** a `packages/lore` package (ingest, chunking, entity resolution, embeddings, a LanceDB store, retrieval); `sim index`; the campaign's lore commit taken from the lore repository; entity and Kanka-ID metadata on `LoreHit` and on logged `lore_lookup` hits; `lore_invention` linked to the narration it supports; `sim audit` with four sections; an `embed` seat in `campaign.json` and in `sim bench`.

**Out:** writing back to `cartyx-lore` (v1 §15); `sim prep` and PC backstories, and therefore the audit's "prepped items never reached" and "backstory hooks" sections (Plan 2C); playback timestamps on audit entries (Plan 3's `timeline.json`); a SQLite state projection; re-ranking beyond the entity collapse described in §6.3.

## 3. The corpus

`cartyx-lore` is ~3.8 MB of markdown across 1,411 files, once `node_modules` is excluded:

| Area                       | Files | Bytes  | Shape                                                                     |
| -------------------------- | ----- | ------ | ------------------------------------------------------------------------- |
| `dm/**`                    | 184   | 2.4 MB | GM-deep prose; one `##`/`###` heading per NPC, district, or hook          |
| `kanka-export/markdown/**` | 1,144 | 1.2 MB | A mirror of Kanka: 561 characters, 406 locations, families, organisations |
| `regions/**`, root `*.md`  | 33    | 194 KB | `lore.md`, `gods.md`, `races.md`, `settlements.md`, region writeups       |
| `population/*.md`          | 50    | 39 KB  | 2020 census tables, the raw input for settlement generation               |

**All of it is indexed, the Kanka mirror included.** The mirror duplicates the major entities that `dm/**` describes in depth, which is handled at retrieval time by the entity collapse in §6.3 rather than by leaving material out.

Three exclusions, and only three: `node_modules/` and `.git/`, which hold dependencies and version-control internals rather than anything a DM could read; and the Kanka export's 18 `_index.md` and `index.md` files, which are link lists (`- [Brookhaven](102817-102817.md)`) rather than lore.

Nothing else is skipped, including directories that hold no markdown today (`images/`, `kanka-export/_raw/`). Skipping them would be a small speed win on the directory walk, and the cost is that a lore file later added under one of those names disappears from the index with no signal — which is the opposite of what this subsystem exists to do. The walk is cheap; silent omission is not.

## 4. Package

`packages/lore`, depending on `@cartyx-sim/core` for types and `@cartyx-sim/models` for the embedding client. **Core does not depend on `lore`**: core keeps its Node-free typecheck and no native addon enters the dependency graph that `cartyx-app` may later embed.

```
packages/lore/src/
  ingest.ts     walk a repo into a file list, apply exclusions
  chunk.ts      markdown text -> chunks, by heading          (pure)
  entities.ts   Kanka name index; resolve a chunk's entity   (pure)
  embed.ts      EmbeddingClient over POST /v1/embeddings
  store.ts      VectorStore interface, LanceStore, MemoryStore
  index.ts      buildIndex(), openIndex() -> LoreIndex
  version.ts    lore version string and content digest
```

`chunk.ts` and `entities.ts` are pure functions over strings and take no I/O, which is where the bulk of the tests live. `MemoryStore` lets everything above `store.ts` be tested with no LanceDB and no server.

### 4.1 Chunking

A chunk is the **deepest heading section** of a file. The full heading path is kept as `title` and prepended to the embedded text, so a short section keeps its context:

```
Avalon Artificers Academy — NPCs (GM) › Prof. Sella Vaunt

**Type:** Faculty
**Kanka name:** Professor Sella Vaunt
...
```

Rules:

- Text before the first heading joins the file's H1 chunk; a file with no heading becomes one chunk titled by its path.
- A section over 4,000 characters splits again on paragraph boundaries; the parts share a heading path and differ by a `~<n>` suffix on the chunk id.
- A section under 80 characters of body text is dropped (a bare heading, a nav stub).
- Target chunk size is ~1,200 characters; the cap is a hard limit, not a target.

A Kanka character file is one chunk. `dm/regions/south/cities/alpharetta-avalon-academy-npcs.md` becomes roughly 55, one per NPC. Expected total: 3,500–4,000 chunks.

`chunkId` is `<repo-relative-path>#<heading-slug-path>[~<part>]` — deterministic across rebuilds, so a `chunkId` recorded in a session log still names the same chunk after the index is rebuilt.

### 4.2 Entity resolution

`entities.ts` builds a name index from `kanka-export/markdown/<type>/<id>-<id>.md`: the H1 is the entity name, the folder is the type (`characters` → `character`, `locations` → `location`, …), the filename prefix is the Kanka id.

For each chunk, walk its heading path **deepest first** and take the first heading whose normalized name uniquely matches one Kanka entity. Normalization: lowercase, strip punctuation, collapse whitespace, and remove a leading honorific from a fixed list (`Prof.`, `Professor`, `Dean`, `Headmistress`, `Dr.`, `Mr.`, `Mrs.`, `Ms.`, `Lord`, `Lady`, `Captain`, `Sir`). So the `dm/` heading `## Prof. Sella Vaunt` resolves to the Kanka character `Professor Sella Vaunt`.

On a match the chunk carries `entityId: "kanka-2418574"`, `kankaId: 2418574`, `entityType: "character"`, `entityName: "Professor Sella Vaunt"`.

On no match, or an **ambiguous** match (two or more Kanka entities share a normalized name), the chunk falls back to `entityId: "file:<path-slug>#<heading-slug>"`, `entityType: "document"`, `entityName` = the heading text, and no `kankaId`. Ambiguity is never guessed: `sim index` prints every ambiguous name it hit, as a work item for the lore repo.

Consequence, and the reason this step exists: the `dm/` writeup and the Kanka stub for Sella Vaunt share one `entityId`, so the audit counts her once and retrieval spends one result slot on her.

### 4.3 The store

```ts
interface VectorStore {
  search(vector: Float32Array, limit: number): Promise<StoredChunk[]>;
}
```

`LanceStore` wraps `@lancedb/lancedb` (0.39.0; a prebuilt `darwin-arm64` binary exists, so there is no native build step on the M5 Max). Table `chunks`, cosine metric, one row per chunk:

| Column                                 | Type            |
| -------------------------------------- | --------------- |
| `vector`                               | float32[768]    |
| `chunkId`, `source`, `title`, `text`   | string          |
| `entityId`, `entityName`, `entityType` | string          |
| `kankaId`                              | int64, nullable |

`score` is cosine similarity (`1 - distance`), in `[0, 1]`, matching the sense of the existing `loreThreshold`.

`MemoryStore` holds the same rows in an array and scores by cosine in JS. It is the store the tests use.

### 4.4 Embeddings

`text-embedding-nomic-embed-text-v1.5`, 768 dimensions, already loaded on both LM Studio servers. nomic requires task prefixes, and the caller supplies them: `search_document: ` on chunk text at index time, `search_query: ` on the query at lookup time. Both prefixes are recorded in `meta.json`, so changing them marks the index stale.

Indexing sends batches of 32 chunks per request through the `models` package's existing retry, timeout and fallback path.

## 5. Configuration and versioning

### 5.1 `campaign.json`

Gains `lorePath` (absolute, or relative to the campaign directory) and an `embed` seat beside `dm`, `checker` and `script`:

```json
{
  "lorePath": "/Users/labeaaa/Developer/cartyx-lore",
  "seats": {
    "embed": { "endpoint": "macbook", "model": "text-embedding-nomic-embed-text-v1.5" }
  }
}
```

`loreCommit` remains in the schema only for lore-less fixtures and keeps its `"unversioned"` default. **Setting both `lorePath` and `loreCommit` is an error** — `loreCommit is derived from lorePath; remove it` — rather than a silent precedence rule.

A campaign with `lorePath` and no `embed` seat is an error too: it would index nothing and answer nothing.

### 5.2 The lore version string

The value recorded in `session_start.loreCommit` and compared on resume:

- clean tree: the 40-character git sha (`git rev-parse HEAD`);
- dirty tree: `<sha>-dirty-<digest8>`, where `digest8` is the first 8 characters of the content digest;
- the status check itself failed: `<sha>-unknown-<digest8>`. A failed check is not a clean tree, and saying so matters — the whole point of this string is to refuse a resume into changed lore. Because `digest8` fingerprints the content, an `-unknown-` version still compares correctly in both directions: identical content yields an identical string and the resume is allowed, changed content yields a different one and it is refused.

The first 40 characters are always a real commit you can `git show`, and an uncommitted lore edit produces a different version, so resuming into edited lore is correctly refused by the check the director already performs.

### 5.3 Index metadata and staleness

`.cache/lore-index/` (v1 design §6.1; git-ignored) holds the LanceDB database and `meta.json`:

```json
{
  "lorePath": "/Users/labeaaa/Developer/cartyx-lore",
  "loreCommit": "db3f5a6…",
  "contentDigest": "sha256:…",
  "embedModel": "text-embedding-nomic-embed-text-v1.5",
  "dims": 768,
  "documentPrefix": "search_document: ",
  "queryPrefix": "search_query: ",
  "chunkerVersion": 1,
  "files": 1740,
  "chunks": 3821,
  "builtAt": "2026-09-20T…Z"
}
```

`contentDigest` is sha256 over the sorted list of `<relative-path>\0<sha256 of bytes>\n` for every ingested file — one pass over 3.7 MB, well under a second.

**An index is stale when** `contentDigest`, `embedModel`, `dims`, either prefix, `chunkerVersion`, or `lorePath` differs from the current configuration. `loreCommit` deliberately does **not** trigger a rebuild: a commit that touches no lore file leaves the digest unchanged, and rebuilding for it would cost minutes for nothing.

`chunkerVersion` follows the script stage's `LABEL_PROMPT_VERSION` idiom: bump it whenever chunking or entity-resolution rules change, so old chunks are not silently reused under new rules.

## 6. Engine-facing changes

### 6.1 `LoreHit`

```ts
export const LoreHit = z.object({
  chunkId: z.string().min(1),
  source: z.string().min(1),
  title: z.string().min(1),
  text: z.string(),
  score: z.number(),
  entityId: z.string().min(1),
  entityName: z.string().min(1),
  entityType: z.string().min(1),
  kankaId: z.number().int().positive().optional(),
});
```

The three entity fields are **required**, not optional, so no consumer grows an "if absent" branch. This updates `apps/cli/fixtures/demo-session.json`, `packages/core/src/testing.ts`'s stub index, and `packages/core/test/tool-harness.ts`'s `SELLA_CHUNK`.

### 6.2 The `lore_lookup` event

Each logged hit gains `entityId`, `entityName` and `entityType` beside today's `chunkId`, `source` and `score`, so `sim audit` runs entirely off the event log with no index present. §7.4's coverage section groups by `entityId` and `entityType`, so the type has to travel on the hit like the other two. All three are **optional in the event schema** so sessions 001–013 still parse and re-script; the audit falls back to `chunkId` for a hit with no `entityId`/`entityName`, and reports an absent `entityType` as unrecorded rather than guessing one.

### 6.3 Entity collapse in `lookup_lore`

`lookup_lore` keeps its `LORE_RESULT_LIMIT` of 8 and its `loreThreshold`. The order of operations changes: the store is asked for more than 8 candidates, hits are collapsed to the **best-scoring chunk per `entityId`**, and the limit is applied to the collapsed list. So a query about Sella Vaunt spends one slot on her — whichever of the stub and the writeup scores higher — and the remaining seven on other entities.

Suppressed chunks are still written to the event's `hits` array; they are simply absent from `used`. `used` is empty if and only if nothing passed the threshold, so "no usable lore" remains the audit's gap signal.

### 6.4 `lore_invention.narrationSeq`

`lore_invention` gains an optional `narrationSeq`. The model's `record_invention(fact, reason)` signature is unchanged — the DM records an invention before it narrates the detail, so asking the model for the link would ask for something it cannot know.

When a turn finalizes, after its events are built and before `sink.append`, the recorder walks each `lore_invention` in the turn and attaches the seq of **the first `narration` emitted after it in that turn**, falling back to the last `narration` before it, and leaving the field absent when the turn narrated nothing.

`EVENT_SCHEMA_VERSION` stays 1. It is bumped only when the log format changes _incompatibly_; both additions here are optional, so sessions 001–013 load unchanged — the same call the death-saves design made for its two additive state fields.

## 7. Commands

### 7.1 `sim index`

```
sim index --campaign <id> [--force] [--check] [--campaigns-dir <path>]
```

Walks the repo, chunks, resolves entities, embeds in batches, writes the table, and writes `meta.json` **last** — the manifest-last rule `sim script` already follows, so a half-written index never looks valid. It builds into `.cache/lore-index.tmp-<pid>/` and renames over the existing directory, so an interrupted run leaves the previous index intact.

Output: files walked, chunks produced, chunks embedded, elapsed time, and **every ambiguous entity name it declined to guess**. `--check` reports freshness and exits without building. `--force` rebuilds a fresh index. Exit 1 with a clean message on any failure, `SIM_DEBUG=1` for the stack, matching the other commands.

### 7.2 Auto-rebuild on `sim run`

A fresh `sim run --campaign` computes the lore version and, on a missing or stale index, prints `Lore index is stale (indexed <a>, repo is now <b>); rebuilding…` and rebuilds **before the session opens** — before the session lock and before any seat call — then plays.

**`--resume` never rebuilds.** The logged `loreCommit` is the lore that session is playing. If the on-disk index no longer matches it, the resume is refused with a message naming both versions and telling the operator to restore that lore commit and re-index. Rebuilding mid-session would change the world underneath a running story, which is the failure the existing resume check exists to prevent.

### 7.3 `sim bench`

Gains an `embed` trial when the campaign configures one: embed a short string, assert the response's dimension count matches `meta.json`'s (or the model's first response, on a first run). A misconfigured embedding endpoint then fails in seconds rather than at minute 12 of a 1-hour session.

### 7.4 `sim audit`

```
sim audit --campaign <id> --session <n> [--no-model] [--campaigns-dir <path>]
```

Writes `audit.md` and `audit.json` into the session directory (v1 design §6.1), reading `events.jsonl` and nothing else. No index is required, so an audit can be re-run long after the lore has moved on.

1. **Gaps** — every `lore_lookup` with an empty `used`, clustered by normalized token overlap between queries and ranked by frequency. Each cluster lists its queries and the seq where each happened.
2. **Inventions** — each `lore_invention`: fact, reason, the originating query, and the narration it supports (`narrationSeq`) with the narration's quote and the spoken-minute mark the session clock already tracks. A playback timestamp arrives with Plan 3's `timeline.json`.
3. **Coverage** — entities retrieved and used, grouped by `entityId` and `entityType` with counts; NPCs from `npc_introduced`, split lore-backed (`loreEntityId` present) versus invented; scenes from `scene_change`, with and without a `loreEntityId`. Prepped-but-never-reached waits for `sim prep` (Plan 2C).
4. **Possible contradictions** — one checker-model pass over the narrations that followed a lore lookup with usable hits in the same turn, asking whether the narration states anything that conflicts with those chunks. Bounded by the lookup count (3–30 a session). Every finding is printed as "possible"; none is asserted.

The checker uses the `checker` seat, as `sim script` does, and `--no-model` skips section 4 and says so in the report rather than silently omitting it.

`audit.json` carries the same data plus an `auditVersion`, for cross-session comparison.

## 8. Testing

**Deterministic, no network, no LanceDB:**

- `chunk.ts` against committed fixtures of the real shapes: a Kanka character file, a `dm/` NPC roster, a nested city file, a file with no H1, an oversized section, a file whose only content precedes its first heading. Assertions on chunk ids, titles, boundaries and the dropped-stub rule.
- `entities.ts`: unique match, honorific normalization (`Prof. Sella Vaunt` ↔ `Professor Sella Vaunt`), ambiguous name (falls back, and is reported), no match, and the deepest-first walk (an NPC heading inside a school's file resolves to the NPC, a `## Campus` heading in the same file resolves to the school).
- `version.ts`: the digest changes when a file's bytes change, is stable under a different walk order, and the dirty marker appears and disappears with the tree state.
- `store.ts`: a `VectorStore` contract suite run against `MemoryStore` with a hash-based fake embedder; one `LanceStore` test that round-trips a handful of vectors and asserts cosine ordering.
- `lookup_lore`: entity collapse happens before the limit; suppressed chunks appear in `hits` and not in `used`; `used` is empty only below threshold.
- `lore_invention`: the link resolves forward, falls back backward, and is absent when nothing was narrated.
- `sim audit`: a golden report over a canned `events.jsonl` with a stub checker model, including a log with no `entityId` on its hits (the 001–013 shape).

**Gated on the real corpus** (`CARTYX_LORE_PATH` plus a reachable embedding endpoint; skipped otherwise): the known-answer retrieval tests of v1 design §13 — "who teaches applied crystal engines at Avalon?" → Professor Sella Vaunt, and a handful more across locations, factions and gods.

A gated test that never runs proves nothing. The implementation plan carries an explicit task that builds the live index, runs the known-answer set, records the observed score spread for both hits and non-hits, and **sets the `loreThreshold` default from those numbers**. The current default of 0.35 is a guess inherited from Plan 1 and has never been measured against a real embedding model. That task is not complete until the measured numbers are written into the plan's notes.

Repo-wide: `npm run typecheck` gains `packages/lore/tsconfig.json`, and `npm run format:check` must pass.

## 9. Risks

1. **Retrieval quality is unmeasured.** Chunking by heading with a 4,000-character cap and a single embedding model is a first guess. Mitigated by the known-answer set and the threshold-calibration task; `chunkerVersion` makes a change cheap to roll out.
2. **The embedding endpoint becomes a run dependency.** `lookup_lore` embeds each query, so a dead endpoint pauses the session on the `lore` seat. Mitigated by the existing retry-and-pause path, the new `sim bench` trial, and seat fallbacks.
3. **Name matching can mis-merge.** Two Kanka entities with the same normalized name fall back rather than merge, but a `dm/` heading that coincidentally normalizes to an unrelated Kanka entity would merge wrongly. Mitigated by requiring a unique exact normalized match and reporting every ambiguity; the failure mode is a coverage miscount, not a wrong answer to the DM.
4. **Auto-rebuild lengthens a run's start.** A stale index costs minutes of embedding before the session opens. Accepted deliberately, so that a session never plays against lore that no longer exists; `sim index` run beforehand avoids it entirely.
5. **Index size.** ~4,000 chunks × 768 float32 is ~12 MB of vectors plus the text; negligible, and `.cache/` is git-ignored.

## 10. Deviations from the v1 spec

- **The audit ships four of five sections.** "Backstory hooks" and coverage's "prepped items never reached" need PC backstories and `sim prep`, both Plan 2C. They are added there, against real input, rather than stubbed here.
- **Invention entries carry a seq and a spoken-minute mark, not a playback timestamp.** `timeline.json` does not exist until Plan 3; the link is recorded now so Plan 3 only has to resolve it.
- **`campaign.json` gains `lorePath` and an `embed` seat**; §6.1's "lore repo path" is realized as that field, and the embedding model becomes a seat like every other model in the system.
- **A stale index is rebuilt automatically on a fresh run but never on `--resume`.** §6.4 says "rebuilt before the run" without distinguishing the two; rebuilding on resume would violate the lore-version guarantee the director already enforces.
