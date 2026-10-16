# SRD 5.2.1 as clean, split Markdown — design

**Status:** approved in conversation 2026-10-15; written for review.
**Part of:** the player fine-tuning project (`docs/fine-tuning/guide.md`), sub-project 1a. The player
scorecard's rules judging (sub-project 1) and the rules training data (sub-project 3) both read it.

## Goal

The D&D 2024 core rules, as published in the System Reference Document 5.2.1 (CC-BY-4.0), checked into
this repo as clean Markdown split into one file per area, rebuilt by a script from a pinned source,
proven complete by a test, and searchable through its own rules index.

## Source

- **Text:** [downfallx/dnd-5e-srd-markdown](https://github.com/downfallx/dnd-5e-srd-markdown), pinned to
  commit `1b4b99d` — an SRD 5.2.1 conversion under CC-BY-4.0 in 13 area files (1.9 MB).
- **Reference for verification:** the official PDF,
  `https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf` (364 pages, published
  2025-05-01).
- **Measured on 2026-10-15:** 98.9% of the PDF's 204,606 words appear in the source. The gap is the
  page footer "System Reference Document" (366 times), a few dragon and giant names from the stat-block
  index pages, and hyphenation joins ("footwide"). Spot checks (Mirror Image, Goblin Warrior) matched
  the PDF word for word.

The pinned source files are vendored under `data/srd-5.2.1/source/` with their own LICENSE, so a build
never depends on the network or on the upstream repo staying unchanged.

## Output layout

```
data/srd-5.2.1/
  README.md                 source, pinned commit, attribution, how to rebuild
  LICENSE                   CC-BY-4.0 attribution statement, verbatim from the SRD
  source/                   the vendored upstream files, untouched
  playing-the-game/         d20-tests.md, actions.md, social-interaction.md, exploration.md,
                            combat.md, damage-and-healing.md
  character-creation.md     creation, level advancement, multiclassing, trinkets
  classes/                  barbarian.md … wizard.md — 12 files, each with its features table,
                            subclass, and (for casters) spell list
  origins/                  backgrounds.md, species.md
  feats.md
  equipment/                coins-and-gear.md, weapons.md (properties and mastery), armor.md,
                            tools.md, mounts-and-vehicles.md (whatever the source chapter holds)
  spells/                   rules.md, cantrips.md, level-1.md … level-9.md
  rules-glossary.md         conditions, actions, terms
  gameplay-toolbox.md       travel, backgrounds, curses, environment, fear, poison, traps, encounters
  magic-items/              rules.md, a-z.md
  monsters/                 rules.md (stat block overview, running a monster), a-f.md, g-l.md,
                            m-r.md, s-z.md, animals.md
```

Exact split points follow the source's headings; where the source's chapter holds sections not
listed above, they go in the area file they belong to, never dropped. Every file starts with a level-1
heading naming its area and keeps the source's heading hierarchy below it, so the existing lore chunker
(which splits on headings) produces one chunk per rule, spell, item or monster.

## Normalization

Applied by the build script, nothing else changed:

1. **Stat-block ability tables** (HTML `<table>`) become one compact line:
   `STR 8 (−1, save −1) | DEX 15 (+2, save +2) | CON 10 (+0, save +0) | INT 10 (+0, save +0) | WIS 8 (−1, save −1) | CHA 8 (−1, save −1)`.
2. **Other HTML tables** become Markdown pipe tables. A table that cannot be expressed that way (merged
   cells) stays HTML and is listed in the build report.
3. **`<br>` line breaks** at the end of stat-block lines become plain line breaks.
4. Typography is kept as the source has it (curly quotes, true minus signs).

## Build script

`npm run srd:build` (TypeScript, in `apps/cli/src/srd/`, beside the other file-reading code) reads
`data/srd-5.2.1/source/`, writes the split files, and prints a report: files written, entries per file,
tables converted, tables left as HTML. It is deterministic: running it twice produces identical files.
The split files are committed, so readers never need to run it.

## Verification (a test in the suite)

- **Nothing lost in the split:** the multiset of words in the split files (after stripping Markdown and
  HTML markup) equals the multiset in the source files, except the markup words the normalization
  removes (`table`, `td`, `th`, `tr`, `thead`, `tbody`, `strong`, `br`). Any other difference fails.
- **Entry counts:** 12 classes, 4 backgrounds, 9 species, and the spell, magic-item, monster and animal
  entry counts measured from the source at build time and recorded in the README — so a later change
  that drops an entry fails.
- **Completeness against the PDF** is a one-off check recorded in the README (the 98.9% above), not a
  test: the PDF is not vendored, and its text extraction is noisy.

The test lives in the suite, so the standing constraint applies: the existing count (1,432 passing, 1
expected fail, 6 skipped) grows only by these tests.

## Rules index

The rules get their own LanceDB index, built with the existing `@cartyx-sim/lore` chunker and embedder,
stored apart from each campaign's lore index so a lore lookup never returns rules and vice versa.

- `sim index --rules` builds it into `data/.cache/srd-index/` (git-ignored), versioned by a content
  digest of `data/srd-5.2.1/` instead of a git commit, and rebuilds only when that digest changes.
- It uses the campaign's embed seat, so it needs `--campaign`, like `sim index`.
- No session reads it in this sub-project. The scorecard's judge is its first reader (sub-project 1).

## Out of scope

- Giving the DM or players a rules lookup during play.
- Any content outside SRD 5.2.1 (no Player's Handbook, DMG or Monster Manual text).
- Re-converting the PDF ourselves; the upstream conversion is the source unless verification fails.

## Constraints

- `packages/core` stays free of file, network and native dependencies (the build script and index
  command live outside it).
- Prettier passes on the whole repo, including the generated Markdown.
- Attribution: `data/srd-5.2.1/README.md` and `LICENSE` carry the SRD's required statement verbatim,
  and say which changes we made (split and table normalization), as CC-BY-4.0 requires.
