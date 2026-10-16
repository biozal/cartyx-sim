# SRD 5.2.1

The Dungeons & Dragons 2024 core rules from the System Reference Document 5.2.1, split into one
file per area for lookup and for the fine-tuning project (`docs/fine-tuning/guide.md`).

## Attribution

This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.

Changes made: the source Markdown below was split into these files, monster ability tables were
rewritten as single lines, other simple HTML tables became Markdown tables, and line-ending
`<br>` tags were removed. No rules text was edited.

## Source

Text from https://github.com/downfallx/dnd-5e-srd-markdown at commit
`1b4b99dcb786cdd1a2fb26f8acec1551191f1ca4`, vendored unchanged in `source/`. On 2026-10-15, 98.9%
of the words of the official PDF
(https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf) appeared in it; the
rest was the PDF's page footer, stat-block index entries and hyphenation joins.

## Rebuilding

Run `npm run srd:build`. The suite test `apps/cli/test/srd-data.test.ts` fails if these files
differ from a fresh build or lose any word of the source.

## Contents

- 12 classes, 4 backgrounds, 9 species, 17 feats
- 339 spells (27 cantrips)
- 260 magic items, 235 monster stat blocks, 95 animals
- Tables: 331 ability tables rewritten as lines, 229 converted to Markdown, 19 kept as HTML (merged cells)
