# SRD 5.2.1 Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor the SRD 5.2.1 Markdown conversion, rebuild it by script into clean per-area files under `data/srd-5.2.1/`, prove the rebuild lost nothing, and index it apart from the lore.

**Architecture:** Pure functions in `apps/cli/src/srd/` split and normalize the vendored source text (`markdown.ts`, `tables.ts`, `split.ts`) and check it (`verify.ts`); `build.ts` does the file I/O and Prettier formatting and is run with `npm run srd:build`. The generated files are committed; a suite test rebuilds them from the vendored source and compares. `sim index --rules` reuses `@cartyx-sim/lore`'s `buildIndex` with a file filter.

**Tech Stack:** TypeScript (ESM, `tsx`), vitest, Prettier 3 API, `@cartyx-sim/lore` (LanceDB).

**Spec:** `docs/superpowers/specs/2026-10-15-srd-markdown-design.md`

## Global Constraints

- Source: `https://github.com/downfallx/dnd-5e-srd-markdown` at commit `1b4b99dcb786cdd1a2fb26f8acec1551191f1ca4`, vendored untouched under `data/srd-5.2.1/source/`.
- Attribution statement, verbatim, in `data/srd-5.2.1/README.md` and `data/srd-5.2.1/LICENSE`: "This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode."
- `packages/core` gains nothing; all new code is in `apps/cli` (and a one-option change in `packages/lore`).
- Prettier passes on the whole repo (`npm run format:check`); the vendored `data/srd-5.2.1/source/` is the one Prettier-ignored path.
- The suite stays at 1,432 passing + 1 expected fail (`packages/script/test/speech.test.ts`) + 6 skipped, plus the new tests.
- `npm run typecheck` passes.
- One commit per task. Do not push.

## Review Focus

- Re-running `npm run srd:build` on an unchanged source must produce byte-identical files (no timestamps, stable ordering) — pinned by the reproducibility test in Task 5.
- A spell's summoned-creature stat block (`## Otherworldly Steed` after `#### Find Steed`) must stay inside that spell's entry in the level file, not become a separate top-level section — pinned in Task 3.
- An HTML table with `colspan`/`rowspan` (the casters' spell-slot tables) must be left as HTML, never flattened into a pipe table with misaligned columns — pinned in Task 2.
- A `|` inside a table cell must be escaped in the pipe table so the row keeps its column count — pinned in Task 2.
- Rebuilding must delete area files that a mapping change no longer produces, but never touch `source/` — pinned in Task 5.

---

## File map

| File                                                                 | Responsibility                                                              |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `data/srd-5.2.1/source/*.md`, `source/LICENSE`, `source/SOURCE.json` | Vendored upstream files and where they came from                            |
| `apps/cli/src/srd/markdown.ts`                                       | Heading parsing, section extraction, heading shifts                         |
| `apps/cli/src/srd/tables.ts`                                         | HTML tables → stat-block lines or pipe tables; trailing `<br>` removal      |
| `apps/cli/src/srd/split.ts`                                          | The area mapping: source files → `SrdFile[]`, plus entry counts             |
| `apps/cli/src/srd/verify.ts`                                         | Word multisets and their difference                                         |
| `apps/cli/src/srd/build.ts`                                          | I/O: read source, build, format with Prettier, write output, README, counts |
| `apps/cli/src/srd/rules-index.ts`                                    | `sim index --rules`: rules index identity, filter and build                 |
| `apps/cli/test/srd-*.test.ts`                                        | Tests per module, plus the committed-data test                              |

---

### Task 1: Vendor the source and the Markdown helpers

**Files:**

- Create: `data/srd-5.2.1/source/` (13 `.md` files, `LICENSE`, `SOURCE.json`)
- Modify: `.prettierignore`
- Create: `apps/cli/src/srd/markdown.ts`
- Test: `apps/cli/test/srd-markdown.test.ts`

**Interfaces:**

- Produces:
  - `headingOf(line: string): { level: number; title: string } | undefined`
  - `interface Section { level: number; title: string; lines: string[] }` (`lines[0]` is the heading line)
  - `splitSections(markdown: string, level: number): { preamble: string[]; sections: Section[] }`
  - `shiftHeadings(lines: readonly string[], by: number): string[]`
  - `toText(lines: readonly string[]): string`

- [ ] **Step 1: Vendor the source**

```bash
S=$(mktemp -d)
git clone -q https://github.com/downfallx/dnd-5e-srd-markdown.git "$S/srd"
git -C "$S/srd" checkout -q 1b4b99dcb786cdd1a2fb26f8acec1551191f1ca4
mkdir -p data/srd-5.2.1/source
for f in playing-the-game character-creation classes character-origins feats equipment spells rules-glossary gameplay-toolbox magic-items monsters monsters-A-Z animals; do
  cp "$S/srd/$f.md" data/srd-5.2.1/source/
done
cp "$S/srd/LICENSE" data/srd-5.2.1/source/LICENSE
```

Create `data/srd-5.2.1/source/SOURCE.json`:

```json
{
  "repository": "https://github.com/downfallx/dnd-5e-srd-markdown",
  "commit": "1b4b99dcb786cdd1a2fb26f8acec1551191f1ca4",
  "license": "CC-BY-4.0",
  "note": "Files copied unchanged. Upstream README, CONTRIBUTING and CHANGELOG are not vendored."
}
```

Append to `.prettierignore`:

```
data/srd-5.2.1/source/
```

Run: `ls data/srd-5.2.1/source | wc -l` — Expected: `15`.

- [ ] **Step 2: Write the failing tests**

`apps/cli/test/srd-markdown.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { headingOf, shiftHeadings, splitSections, toText } from '../src/srd/markdown';

describe('headingOf', () => {
  it('reads ATX headings', () => {
    expect(headingOf('## Weapons')).toEqual({ level: 2, title: 'Weapons' });
    expect(headingOf('#### Acid Arrow  ')).toEqual({ level: 4, title: 'Acid Arrow' });
  });
  it('ignores non-headings', () => {
    expect(headingOf('#hashtag')).toBeUndefined();
    expect(headingOf('Text # not a heading')).toBeUndefined();
    expect(headingOf('')).toBeUndefined();
  });
});

describe('splitSections', () => {
  const md = [
    '# Equipment',
    '',
    'Intro.',
    '',
    '## Coins',
    'c',
    '### Sub',
    's',
    '## Weapons',
    'w',
  ].join('\n');
  it('splits at the given level and keeps deeper headings inside', () => {
    const { preamble, sections } = splitSections(md, 2);
    expect(preamble).toEqual(['# Equipment', '', 'Intro.', '']);
    expect(sections.map((s) => s.title)).toEqual(['Coins', 'Weapons']);
    expect(sections[0]!.lines).toEqual(['## Coins', 'c', '### Sub', 's']);
    expect(sections[0]!.level).toBe(2);
  });
});

describe('shiftHeadings', () => {
  it('promotes and demotes headings only', () => {
    expect(shiftHeadings(['## A', 'text # x', '#### B'], -1)).toEqual(['# A', 'text # x', '### B']);
    expect(shiftHeadings(['## A'], 1)).toEqual(['### A']);
  });
  it('refuses to leave the 1–6 range', () => {
    expect(() => shiftHeadings(['# A'], -1)).toThrow(/heading level/);
  });
});

describe('toText', () => {
  it('trims surrounding blank lines and ends with one newline', () => {
    expect(toText(['', '# A', '', 'b', '', ''])).toBe('# A\n\nb\n');
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run apps/cli/test/srd-markdown.test.ts`
Expected: FAIL — cannot resolve `../src/srd/markdown`.

- [ ] **Step 4: Implement**

`apps/cli/src/srd/markdown.ts`:

```ts
/** Markdown helpers for rebuilding the SRD. The source has no fenced code blocks, so none are handled. */

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;

export function headingOf(line: string): { level: number; title: string } | undefined {
  const match = HEADING.exec(line);
  return match ? { level: match[1]!.length, title: match[2]! } : undefined;
}

/** A heading and everything up to the next heading at the same or a shallower level. */
export interface Section {
  level: number;
  title: string;
  /** The heading line first, then the body, deeper headings included. */
  lines: string[];
}

/**
 * Splits at every heading of exactly `level`. Lines before the first such heading are the
 * preamble; a shallower heading after the first section ends it and goes nowhere, so callers use
 * this only inside one file whose single shallower heading is its title.
 */
export function splitSections(
  markdown: string,
  level: number
): { preamble: string[]; sections: Section[] } {
  const preamble: string[] = [];
  const sections: Section[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const heading = headingOf(line);
    if (heading && heading.level === level) {
      sections.push({ level, title: heading.title, lines: [line] });
      continue;
    }
    if (heading && heading.level < level && sections.length > 0) {
      throw new Error(
        `Unexpected level-${heading.level} heading "${heading.title}" after sections`
      );
    }
    (sections.at(-1)?.lines ?? preamble).push(line);
  }
  return { preamble, sections };
}

export function shiftHeadings(lines: readonly string[], by: number): string[] {
  return lines.map((line) => {
    const heading = headingOf(line);
    if (!heading) return line;
    const level = heading.level + by;
    if (level < 1 || level > 6) {
      throw new Error(`Shifting "${heading.title}" by ${by} leaves the heading level range`);
    }
    return `${'#'.repeat(level)} ${heading.title}`;
  });
}

export function toText(lines: readonly string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start++;
  while (end > start && lines[end - 1]!.trim() === '') end--;
  return `${lines.slice(start, end).join('\n')}\n`;
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run apps/cli/test/srd-markdown.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
npm run format:check && npm run typecheck
git add .prettierignore data/srd-5.2.1/source apps/cli/src/srd/markdown.ts apps/cli/test/srd-markdown.test.ts
git commit -m "feat(cli): vendor SRD 5.2.1 Markdown and add section helpers"
```

---

### Task 2: Table normalization

**Files:**

- Create: `apps/cli/src/srd/tables.ts`
- Test: `apps/cli/test/srd-tables.test.ts`

**Interfaces:**

- Produces:
  - `interface TableStats { pipeTables: number; statBlocks: number; keptHtml: number }`
  - `normalizeTables(markdown: string): { text: string; stats: TableStats }`

Rules (spec §Normalization):

1. A table whose only header row is `['', '', 'MOD', 'SAVE', '', '', 'MOD', 'SAVE', '', '', 'MOD', 'SAVE']` with two body rows of 12 cells becomes one line: `STR 8 (−1, save −1) | DEX 15 (+2, save +2) | CON 10 (+0, save +0) | INT 10 (+0, save +0) | WIS 8 (−1, save −1) | CHA 8 (−1, save −1)`.
2. Any table with a `colspan` or `rowspan` attribute, or with more than one header row, stays exactly as it was.
3. Every other table becomes a pipe table: the single `<thead>` row is the header, or the first row when there is no `<thead>`. Cell content: `<strong>x</strong>` → `**x**`, `<em>x</em>` → `_x_`, `<br>` → a space, other tags removed, whitespace collapsed, `|` escaped as `\|`. Short rows are padded with empty cells to the widest row.
4. A `<br>` (with optional spaces before it) at the end of a line outside tables is removed.

- [ ] **Step 1: Write the failing tests**

`apps/cli/test/srd-tables.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeTables } from '../src/srd/tables';

const row = (cells: string[], tag = 'td') =>
  `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;

const statBlock = [
  '<table>',
  `<thead>${row(['', '', 'MOD', 'SAVE', '', '', 'MOD', 'SAVE', '', '', 'MOD', 'SAVE'], 'th')}</thead>`,
  '<tbody>',
  row([
    '<strong>STR</strong>',
    '8',
    '−1',
    '−1',
    '<strong>DEX</strong>',
    '15',
    '+2',
    '+2',
    '<strong>CON</strong>',
    '10',
    '+0',
    '+0',
  ]),
  row([
    '<strong>INT</strong>',
    '10',
    '+0',
    '+0',
    '<strong>WIS</strong>',
    '8',
    '−1',
    '−1',
    '<strong>CHA</strong>',
    '8',
    '−1',
    '+1',
  ]),
  '</tbody>',
  '</table>',
].join('\n');

describe('normalizeTables', () => {
  it('turns a stat-block ability table into one line', () => {
    const { text, stats } = normalizeTables(`before\n\n${statBlock}\n\nafter`);
    expect(text).toBe(
      'before\n\nSTR 8 (−1, save −1) | DEX 15 (+2, save +2) | CON 10 (+0, save +0) | INT 10 (+0, save +0) | WIS 8 (−1, save −1) | CHA 8 (−1, save +1)\n\nafter'
    );
    expect(stats).toEqual({ pipeTables: 0, statBlocks: 1, keptHtml: 0 });
  });

  it('turns a simple table into a pipe table with inline formatting', () => {
    const html = [
      '<table>',
      `<thead>${row(['Ability', 'Score Measures …'], 'th')}</thead>`,
      `<tbody>${row(['<strong>Strength</strong>', 'Physical<br>might'])}${row(['Dex | Agility'])}</tbody>`,
      '</table>',
    ].join('\n');
    expect(normalizeTables(html).text).toBe(
      [
        '| Ability | Score Measures … |',
        '| --- | --- |',
        '| **Strength** | Physical might |',
        '| Dex \\| Agility |  |',
      ].join('\n')
    );
  });

  it('uses the first row as the header when there is no thead', () => {
    const html = `<table><tbody>${row(['A', 'B'])}${row(['1', '2'])}</tbody></table>`;
    expect(normalizeTables(html).text).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('leaves tables with colspan, rowspan or two header rows untouched', () => {
    const spans = `<table><thead><tr><th colspan="2">Slots</th></tr></thead><tbody>${row(['1', '2'])}</tbody></table>`;
    const twoHeads = `<table><thead>${row(['A'], 'th')}${row(['B'], 'th')}</thead><tbody>${row(['1'])}</tbody></table>`;
    for (const html of [spans, twoHeads]) {
      const { text, stats } = normalizeTables(html);
      expect(text).toBe(html);
      expect(stats.keptHtml).toBe(1);
    }
  });

  it('removes trailing <br> outside tables', () => {
    expect(normalizeTables('**AC** 15 <br>\n**HP** 10<br>\nkeep<br>this').text).toBe(
      '**AC** 15\n**HP** 10\nkeep<br>this'
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run apps/cli/test/srd-tables.test.ts`
Expected: FAIL — cannot resolve `../src/srd/tables`.

- [ ] **Step 3: Implement**

`apps/cli/src/srd/tables.ts`:

```ts
export interface TableStats {
  pipeTables: number;
  statBlocks: number;
  keptHtml: number;
}

interface Cell {
  attrs: string;
  html: string;
}

const TABLE = /<table>[\s\S]*?<\/table>/g;
const ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
const CELL = /<(th|td)([^>]*)>([\s\S]*?)<\/\1>/g;
const STAT_HEADER = ['', '', 'MOD', 'SAVE', '', '', 'MOD', 'SAVE', '', '', 'MOD', 'SAVE'];

function rows(html: string): Cell[][] {
  return [...html.matchAll(ROW)].map((row) =>
    [...row[1]!.matchAll(CELL)].map((cell) => ({ attrs: cell[2]!, html: cell[3]! }))
  );
}

function plain(html: string): string {
  return html
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**')
    .replace(/<em>([\s\S]*?)<\/em>/g, '_$1_')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function statBlockLine(body: Cell[][]): string {
  const parts: string[] = [];
  for (const row of body) {
    for (let i = 0; i < 12; i += 4) {
      const [name, score, mod, save] = row
        .slice(i, i + 4)
        .map((cell) => plain(cell.html).replace(/\*/g, ''));
      parts.push(`${name} ${score} (${mod}, save ${save})`);
    }
  }
  return parts.join(' | ');
}

function pipeTable(all: Cell[][]): string {
  const width = Math.max(...all.map((row) => row.length));
  const line = (row: Cell[]) => {
    const cells = Array.from({ length: width }, (_, i) =>
      row[i] ? plain(row[i]!.html).replace(/\|/g, '\\|') : ''
    );
    return `| ${cells.join(' | ')} |`;
  };
  const [header, ...body] = all;
  return [line(header!), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map(line)].join(
    '\n'
  );
}

export function normalizeTables(markdown: string): { text: string; stats: TableStats } {
  const stats: TableStats = { pipeTables: 0, statBlocks: 0, keptHtml: 0 };
  const replaced = markdown.replace(TABLE, (table) => {
    const head = /<thead>([\s\S]*?)<\/thead>/.exec(table)?.[1];
    const bodyHtml =
      /<tbody>([\s\S]*?)<\/tbody>/.exec(table)?.[1] ??
      table.replace(/<thead>[\s\S]*?<\/thead>/, '');
    const headRows = head === undefined ? [] : rows(head);
    const bodyRows = rows(bodyHtml);
    const all = [...headRows, ...bodyRows];
    if (
      all.some((row) => row.some((cell) => /colspan|rowspan/.test(cell.attrs))) ||
      headRows.length > 1
    ) {
      stats.keptHtml++;
      return table;
    }
    const header = headRows[0]?.map((cell) => plain(cell.html));
    if (
      header &&
      header.join('\u0000') === STAT_HEADER.join('\u0000') &&
      bodyRows.length === 2 &&
      bodyRows.every((row) => row.length === 12)
    ) {
      stats.statBlocks++;
      return statBlockLine(bodyRows);
    }
    stats.pipeTables++;
    return pipeTable(all);
  });
  // Outside tables only: a table kept as HTML never ends a line with <br>.
  const text = replaced.replace(/[ \t]*<br\s*\/?>[ \t]*$/gm, '');
  return { text, stats };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run apps/cli/test/srd-tables.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/cli/src/srd apps/cli/test/srd-tables.test.ts && npm run typecheck
git add apps/cli/src/srd/tables.ts apps/cli/test/srd-tables.test.ts
git commit -m "feat(cli): normalize SRD tables to stat-block lines and pipe tables"
```

---

### Task 3: The area split and entry counts

**Files:**

- Create: `apps/cli/src/srd/split.ts`
- Test: `apps/cli/test/srd-split.test.ts`

**Interfaces:**

- Consumes: `splitSections`, `shiftHeadings`, `toText`, `headingOf` (Task 1); `normalizeTables`, `TableStats` (Task 2).
- Produces:
  - `SOURCE_FILES: readonly string[]` — the 13 vendored file names
  - `interface SrdFile { path: string; text: string }`
  - `interface SrdCounts { classes: number; backgrounds: number; species: number; feats: number; spells: number; spellsByLevel: Record<string, number>; magicItems: number; monsters: number; animals: number }`
  - `interface SrdBuild { files: SrdFile[]; counts: SrdCounts; tables: TableStats; generatedTitles: string[]; droppedHeadings: string[] }`
  - `buildSrd(sources: Readonly<Record<string, string>>): SrdBuild`

**The mapping** (spec §Output layout). Three file shapes:

- _Whole_: the source file unchanged.
- _Promoted_: one `##` section, shifted up one level so its heading is the file's `#`.
- _Grouped_: several `##` sections under a title. The file that receives a source's preamble starts with that preamble (which holds the source's own `#` heading). Any other grouped file starts with a generated `# Title`, recorded in `generatedTitles`.

A preamble that no file receives must be only a single `#` heading; its title goes in `droppedHeadings`. Anything else throws, so text is never lost silently. Every `##` section of a split source must be mapped exactly once; an unmapped or doubly mapped section throws.

| Source                  | Output                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `playing-the-game.md`   | `playing-the-game/d20-tests.md` grouped, gets preamble: Rhythm of Play, The Six Abilities, D20 Tests, Proficiency. Promoted: `actions.md` (Actions), `social-interaction.md` (Social Interaction), `exploration.md` (Exploration), `combat.md` (Combat), `damage-and-healing.md` (Damage and Healing)                                                                                                        |
| `character-creation.md` | `character-creation.md` whole                                                                                                                                                                                                                                                                                                                                                                                |
| `classes.md`            | `classes/<slug>.md` promoted, one per `##` (12); preamble dropped                                                                                                                                                                                                                                                                                                                                            |
| `character-origins.md`  | `origins/backgrounds.md` (Character Backgrounds), `origins/species.md` (Character Species), promoted; preamble dropped                                                                                                                                                                                                                                                                                       |
| `feats.md`              | `feats.md` whole                                                                                                                                                                                                                                                                                                                                                                                             |
| `equipment.md`          | `equipment/coins-and-gear.md` grouped, gets preamble: Coins, Adventuring Gear. Promoted: `weapons.md`, `armor.md`, `tools.md`, `mounts-and-vehicles.md`. Grouped `services.md` titled "Services": Lifestyle Expenses; Food, Drink, and Lodging; Hirelings; Spellcasting; Magic Items. Grouped `crafting.md` titled "Crafting": Crafting Nonmagical Items, Brewing Potions of Healing, Scribing Spell Scrolls |
| `spells.md`             | `spells/rules.md`: preamble and every section before Spell Descriptions. The "Spell Descriptions" heading is dropped. Entries go to `spells/cantrips.md` ("Cantrips") and `spells/level-N.md` ("Level N Spells"), generated titles                                                                                                                                                                           |
| `rules-glossary.md`     | whole                                                                                                                                                                                                                                                                                                                                                                                                        |
| `gameplay-toolbox.md`   | whole                                                                                                                                                                                                                                                                                                                                                                                                        |
| `magic-items.md`        | `magic-items/rules.md`: preamble and every section before Magic Items A–Z. `magic-items/a-z.md`: Magic Items A–Z, promoted                                                                                                                                                                                                                                                                                   |
| `monsters.md`           | `monsters/rules.md` whole                                                                                                                                                                                                                                                                                                                                                                                    |
| `monsters-A-Z.md`       | `monsters/a-f.md`, `g-l.md`, `m-r.md`, `s-z.md`: each `##` group by its title's first letter, grouped under generated titles "Monsters A–F" (en dash) and so on; preamble dropped                                                                                                                                                                                                                            |
| `animals.md`            | `monsters/animals.md` whole                                                                                                                                                                                                                                                                                                                                                                                  |

**Spell entries.** After "## Spell Descriptions", a `#### Name` line whose next non-blank line matches `/^_Level ([1-9]) /` (a leveled spell) or `/^_\w+ Cantrip \(/` (a cantrip) starts an entry. In the output, the entry heading becomes `## Name`. Inside an entry, a `## X` (a summoned creature's stat block) becomes `### X`, and every other heading keeps its level. The entry runs until the next spell heading.

**Counts.** Computed from the output files:

- classes: files under `classes/`
- backgrounds: level-3 headings under "Background Descriptions" in `origins/backgrounds.md`
- species: level-3 headings under "Species Descriptions" in `origins/species.md`
- feats: level-4 headings in `feats.md`
- spells: entries, and `spellsByLevel` keyed `"0"`–`"9"`
- magicItems: level-3 headings in `magic-items/a-z.md`
- monsters: level-3 headings across the four monster letter files
- animals: level-2 headings in `monsters/animals.md`

`normalizeTables` runs on every output file's text last, and its stats are summed.

- [ ] **Step 1: Write the failing tests**

`apps/cli/test/srd-split.test.ts`. It uses a minimal fixture per source. Every source the mapping names must exist, so the fixture provides all 13.

```ts
import { describe, expect, it } from 'vitest';
import { buildSrd, SOURCE_FILES } from '../src/srd/split';

const CLASSES = [
  'Barbarian',
  'Bard',
  'Cleric',
  'Druid',
  'Fighter',
  'Monk',
  'Paladin',
  'Ranger',
  'Rogue',
  'Sorcerer',
  'Warlock',
  'Wizard',
];

function fixture(): Record<string, string> {
  return {
    'playing-the-game.md': [
      '# Playing the Game',
      '',
      ...[
        'Rhythm of Play',
        'The Six Abilities',
        'D20 Tests',
        'Proficiency',
        'Actions',
        'Social Interaction',
        'Exploration',
        'Combat',
        'Damage and Healing',
      ].flatMap((t) => [`## ${t}`, '', `${t} text.`, '']),
    ].join('\n'),
    'character-creation.md': '# Character Creation\n\nMake one.\n',
    'classes.md': [
      '# Classes',
      '',
      ...CLASSES.flatMap((c) => [
        `## ${c}`,
        '',
        `${c} text.`,
        '',
        `### ${c} Class Features`,
        '',
        'x',
        '',
      ]),
    ].join('\n'),
    'character-origins.md': [
      '# Character Origins',
      '',
      '## Character Backgrounds',
      '',
      '### Background Descriptions',
      '',
      '#### Acolyte',
      '',
      'a',
      '',
      '#### Sage',
      '',
      's',
      '',
      '## Character Species',
      '',
      '### Species Descriptions',
      '',
      '#### Elf',
      '',
      'e',
      '',
    ].join('\n'),
    'feats.md': '# Feats\n\n## Feat Descriptions\n\n### Origin Feats\n\n#### Alert\n\nx\n',
    'equipment.md': [
      '# Equipment',
      '',
      ...[
        'Coins',
        'Weapons',
        'Armor',
        'Tools',
        'Adventuring Gear',
        'Mounts and Vehicles',
        'Lifestyle Expenses',
        'Food, Drink, and Lodging',
        'Hirelings',
        'Spellcasting',
        'Magic Items',
        'Crafting Nonmagical Items',
        'Brewing Potions of Healing',
        'Scribing Spell Scrolls',
      ].flatMap((t) => [`## ${t}`, '', `${t} text.`, '']),
    ].join('\n'),
    'spells.md': [
      '# Spells',
      '',
      '## Casting Spells',
      '',
      'How.',
      '',
      '## Spell Descriptions',
      '',
      '#### Acid Splash',
      '',
      '_Evocation Cantrip (Sorcerer, Wizard)_',
      '',
      'Acid.',
      '',
      '#### Find Steed',
      '',
      '_Level 2 Conjuration (Paladin)_',
      '',
      'A steed.',
      '',
      '## Otherworldly Steed',
      '',
      '_Large Celestial_',
      '',
      '#### Actions',
      '',
      'Hoof.',
      '',
      '#### Fireball',
      '',
      '_Level 3 Evocation (Sorcerer, Wizard)_',
      '',
      'Boom.',
      '',
    ].join('\n'),
    'rules-glossary.md': '# Rules Glossary\n\nTerms.\n',
    'gameplay-toolbox.md': '# Gameplay Toolbox\n\nTools.\n',
    'magic-items.md':
      '# Magic Items\n\n## Magic Item Rarity\n\nRare.\n\n## Magic Items A–Z\n\n#### Bag of Holding\n\nBig.\n',
    'monsters.md': '# Monsters\n\n## Stat Block Overview\n\nRead it.\n',
    'monsters-A-Z.md': [
      '# Monsters A–Z',
      '',
      '## Aboleth',
      '',
      '### Aboleth',
      '',
      'x',
      '',
      '## Goblins',
      '',
      '### Goblin Warrior',
      '',
      'x',
      '',
      '### Goblin Boss',
      '',
      'x',
      '',
      '## Zombies',
      '',
      '### Zombie',
      '',
      'x',
      '',
    ].join('\n'),
    'animals.md': '# Animals\n\n## Ape\n\nx\n\n## Bat\n\nx\n',
  };
}

const byPath = (build: ReturnType<typeof buildSrd>) =>
  new Map(build.files.map((f) => [f.path, f.text]));

describe('buildSrd', () => {
  it('names all 13 source files', () => {
    expect([...SOURCE_FILES].sort()).toEqual(Object.keys(fixture()).sort());
  });

  it('promotes single sections and groups the rest', () => {
    const files = byPath(buildSrd(fixture()));
    expect(files.get('playing-the-game/combat.md')).toBe('# Combat\n\nCombat text.\n');
    expect(files.get('playing-the-game/d20-tests.md')).toMatch(
      /^# Playing the Game\n\n## Rhythm of Play\n/
    );
    expect(files.get('classes/barbarian.md')).toMatch(
      /^# Barbarian\n\nBarbarian text.\n\n## Barbarian Class Features/
    );
    expect(files.get('equipment/services.md')).toMatch(/^# Services\n\n## Lifestyle Expenses/);
    expect(files.get('equipment/coins-and-gear.md')).toMatch(
      /^# Equipment\n\n## Coins[\s\S]*## Adventuring Gear/
    );
    expect(files.get('feats.md')).toBe(
      '# Feats\n\n## Feat Descriptions\n\n### Origin Feats\n\n#### Alert\n\nx\n'
    );
  });

  it('files spells by level and keeps a summoned stat block inside its spell', () => {
    const files = byPath(buildSrd(fixture()));
    expect(files.get('spells/rules.md')).toBe('# Spells\n\n## Casting Spells\n\nHow.\n');
    expect(files.get('spells/cantrips.md')).toMatch(/^# Cantrips\n\n## Acid Splash\n/);
    expect(files.get('spells/level-2.md')).toBe(
      '# Level 2 Spells\n\n## Find Steed\n\n_Level 2 Conjuration (Paladin)_\n\nA steed.\n\n### Otherworldly Steed\n\n_Large Celestial_\n\n#### Actions\n\nHoof.\n'
    );
    expect(files.get('spells/level-3.md')).toMatch(/## Fireball/);
  });

  it('files monsters by letter and records generated and dropped headings', () => {
    const build = buildSrd(fixture());
    const files = byPath(build);
    expect(files.get('monsters/a-f.md')).toMatch(/^# Monsters A–F\n\n## Aboleth/);
    expect(files.get('monsters/g-l.md')).toMatch(/## Goblins[\s\S]*### Goblin Boss/);
    expect(files.get('monsters/s-z.md')).toMatch(/## Zombies/);
    expect(files.has('monsters/m-r.md')).toBe(false);
    expect(build.generatedTitles).toEqual(
      expect.arrayContaining(['Services', 'Crafting', 'Cantrips', 'Level 2 Spells', 'Monsters A–F'])
    );
    expect(build.droppedHeadings.sort()).toEqual(
      ['Character Origins', 'Classes', 'Monsters A–Z', 'Spell Descriptions'].sort()
    );
  });

  it('counts entries', () => {
    expect(buildSrd(fixture()).counts).toEqual({
      classes: 12,
      backgrounds: 2,
      species: 1,
      feats: 1,
      spells: 3,
      spellsByLevel: { '0': 1, '2': 1, '3': 1 },
      magicItems: 1,
      monsters: 4,
      animals: 2,
    });
  });

  it('refuses an unmapped section rather than drop it', () => {
    const sources = fixture();
    sources['equipment.md'] += '\n## Siege Engines\n\nNew.\n';
    expect(() => buildSrd(sources)).toThrow(/Siege Engines/);
  });

  it('refuses a dropped preamble that holds text', () => {
    const sources = fixture();
    sources['classes.md'] = sources['classes.md']!.replace(
      '# Classes\n',
      '# Classes\n\nIntro text.\n'
    );
    expect(() => buildSrd(sources)).toThrow(/preamble/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run apps/cli/test/srd-split.test.ts`
Expected: FAIL — cannot resolve `../src/srd/split`.

- [ ] **Step 3: Implement**

`apps/cli/src/srd/split.ts`:

```ts
import { headingOf, shiftHeadings, splitSections, toText, type Section } from './markdown';
import { normalizeTables, type TableStats } from './tables';

export const SOURCE_FILES = [
  'playing-the-game.md',
  'character-creation.md',
  'classes.md',
  'character-origins.md',
  'feats.md',
  'equipment.md',
  'spells.md',
  'rules-glossary.md',
  'gameplay-toolbox.md',
  'magic-items.md',
  'monsters.md',
  'monsters-A-Z.md',
  'animals.md',
] as const;

export interface SrdFile {
  path: string;
  text: string;
}

export interface SrdCounts {
  classes: number;
  backgrounds: number;
  species: number;
  feats: number;
  spells: number;
  spellsByLevel: Record<string, number>;
  magicItems: number;
  monsters: number;
  animals: number;
}

export interface SrdBuild {
  files: SrdFile[];
  counts: SrdCounts;
  tables: TableStats;
  /** Titles the build wrote that are not in the source (for the word check). */
  generatedTitles: string[];
  /** Source headings the build left out because they only titled what was split up. */
  droppedHeadings: string[];
}

interface Collector {
  files: SrdFile[];
  generatedTitles: string[];
  droppedHeadings: string[];
}

function source(sources: Readonly<Record<string, string>>, name: string): string {
  const text = sources[name];
  if (text === undefined) throw new Error(`SRD source ${name} is missing`);
  return text;
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Takes the named sections out of `pool`, in the order given; each must be there exactly once. */
function take(pool: Map<string, Section>, titles: readonly string[], from: string): Section[] {
  return titles.map((title) => {
    const section = pool.get(title);
    if (!section) throw new Error(`${from}: no section "${title}" (or it was mapped twice)`);
    pool.delete(title);
    return section;
  });
}

function sectionPool(sections: Section[], from: string): Map<string, Section> {
  const pool = new Map<string, Section>();
  for (const section of sections) {
    if (pool.has(section.title)) throw new Error(`${from}: duplicate section "${section.title}"`);
    pool.set(section.title, section);
  }
  return pool;
}

function assertEmpty(pool: Map<string, Section>, from: string): void {
  if (pool.size > 0) throw new Error(`${from}: unmapped sections: ${[...pool.keys()].join(', ')}`);
}

/** Records a preamble no file receives; it must be nothing but the source's `#` title. */
function dropPreamble(preamble: string[], from: string, out: Collector): void {
  const lines = preamble.filter((line) => line.trim() !== '');
  const heading = lines.length === 1 ? headingOf(lines[0]!) : undefined;
  if (!heading || heading.level !== 1) {
    throw new Error(`${from}: preamble holds more than its title and no file receives it`);
  }
  out.droppedHeadings.push(heading.title);
}

const promoted = (section: Section): string => toText(shiftHeadings(section.lines, -1));

/** The head (a preamble or a generated title), then each section, one blank line apart. */
function grouped(head: string[], sections: Section[]): string {
  return [toText(head), ...sections.map((section) => toText(section.lines))].join('\n');
}

function generated(title: string, sections: Section[], out: Collector): string {
  out.generatedTitles.push(title);
  return grouped([`# ${title}`], sections);
}

function playingTheGame(text: string, out: Collector): void {
  const from = 'playing-the-game.md';
  const { preamble, sections } = splitSections(text, 2);
  const pool = sectionPool(sections, from);
  out.files.push({
    path: 'playing-the-game/d20-tests.md',
    text: grouped(
      preamble,
      take(pool, ['Rhythm of Play', 'The Six Abilities', 'D20 Tests', 'Proficiency'], from)
    ),
  });
  for (const title of [
    'Actions',
    'Social Interaction',
    'Exploration',
    'Combat',
    'Damage and Healing',
  ]) {
    out.files.push({
      path: `playing-the-game/${slug(title)}.md`,
      text: promoted(take(pool, [title], from)[0]!),
    });
  }
  assertEmpty(pool, from);
}

function classes(text: string, out: Collector): void {
  const { preamble, sections } = splitSections(text, 2);
  dropPreamble(preamble, 'classes.md', out);
  for (const section of sections) {
    out.files.push({ path: `classes/${slug(section.title)}.md`, text: promoted(section) });
  }
}

function origins(text: string, out: Collector): void {
  const from = 'character-origins.md';
  const { preamble, sections } = splitSections(text, 2);
  dropPreamble(preamble, from, out);
  const pool = sectionPool(sections, from);
  out.files.push({
    path: 'origins/backgrounds.md',
    text: promoted(take(pool, ['Character Backgrounds'], from)[0]!),
  });
  out.files.push({
    path: 'origins/species.md',
    text: promoted(take(pool, ['Character Species'], from)[0]!),
  });
  assertEmpty(pool, from);
}

function equipment(text: string, out: Collector): void {
  const from = 'equipment.md';
  const { preamble, sections } = splitSections(text, 2);
  const pool = sectionPool(sections, from);
  out.files.push({
    path: 'equipment/coins-and-gear.md',
    text: grouped(preamble, take(pool, ['Coins', 'Adventuring Gear'], from)),
  });
  for (const title of ['Weapons', 'Armor', 'Tools', 'Mounts and Vehicles']) {
    out.files.push({
      path: `equipment/${slug(title)}.md`,
      text: promoted(take(pool, [title], from)[0]!),
    });
  }
  out.files.push({
    path: 'equipment/services.md',
    text: generated(
      'Services',
      take(
        pool,
        [
          'Lifestyle Expenses',
          'Food, Drink, and Lodging',
          'Hirelings',
          'Spellcasting',
          'Magic Items',
        ],
        from
      ),
      out
    ),
  });
  out.files.push({
    path: 'equipment/crafting.md',
    text: generated(
      'Crafting',
      take(
        pool,
        ['Crafting Nonmagical Items', 'Brewing Potions of Healing', 'Scribing Spell Scrolls'],
        from
      ),
      out
    ),
  });
  assertEmpty(pool, from);
}

/** The spell level a `####` heading starts, or undefined when it is not a spell heading. */
function spellLevel(lines: readonly string[], index: number): number | undefined {
  const heading = headingOf(lines[index]!);
  if (!heading || heading.level !== 4) return undefined;
  const next = lines.slice(index + 1).find((line) => line.trim() !== '');
  if (next === undefined) return undefined;
  const leveled = /^_Level ([1-9]) /.exec(next);
  if (leveled) return Number(leveled[1]);
  return /^_\w+ Cantrip \(/.test(next) ? 0 : undefined;
}

function spells(text: string, out: Collector, counts: Record<string, number>): void {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === '## Spell Descriptions');
  if (start === -1) throw new Error('spells.md: no "## Spell Descriptions" section');
  out.files.push({ path: 'spells/rules.md', text: toText(lines.slice(0, start)) });
  out.droppedHeadings.push('Spell Descriptions');
  const byLevel = new Map<number, string[]>();
  let current: string[] | undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const level = spellLevel(lines, i);
    if (level !== undefined) {
      current = byLevel.get(level) ?? [];
      byLevel.set(level, current);
      current.push(`## ${headingOf(line)!.title}`);
      counts[String(level)] = (counts[String(level)] ?? 0) + 1;
      continue;
    }
    if (!current) {
      if (line.trim() === '') continue;
      throw new Error(`spells.md: text before the first spell: "${line}"`);
    }
    const heading = headingOf(line);
    current.push(heading && heading.level === 2 ? `### ${heading.title}` : line);
  }
  for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
    const title = level === 0 ? 'Cantrips' : `Level ${level} Spells`;
    out.generatedTitles.push(title);
    out.files.push({
      path: level === 0 ? 'spells/cantrips.md' : `spells/level-${level}.md`,
      text: toText([`# ${title}`, '', ...byLevel.get(level)!]),
    });
  }
}

function magicItems(text: string, out: Collector): void {
  const from = 'magic-items.md';
  const { preamble, sections } = splitSections(text, 2);
  const index = sections.findIndex((section) => section.title === 'Magic Items A–Z');
  if (index === -1 || index !== sections.length - 1) {
    throw new Error(`${from}: "Magic Items A–Z" must be the last section`);
  }
  out.files.push({
    path: 'magic-items/rules.md',
    text: grouped(preamble, sections.slice(0, index)),
  });
  out.files.push({ path: 'magic-items/a-z.md', text: promoted(sections[index]!) });
}

const MONSTER_RANGES = [
  ['a', 'f'],
  ['g', 'l'],
  ['m', 'r'],
  ['s', 'z'],
] as const;

function monstersAZ(text: string, out: Collector): void {
  const { preamble, sections } = splitSections(text, 2);
  dropPreamble(preamble, 'monsters-A-Z.md', out);
  const letterOf = (section: Section) => section.title[0]!.toLowerCase();
  const stray = sections.find((section) => !/[a-z]/.test(letterOf(section)));
  if (stray)
    throw new Error(`monsters-A-Z.md: group "${stray.title}" does not start with a letter`);
  for (const [first, last] of MONSTER_RANGES) {
    const group = sections.filter(
      (section) => letterOf(section) >= first && letterOf(section) <= last
    );
    if (group.length === 0) continue;
    out.files.push({
      path: `monsters/${first}-${last}.md`,
      text: generated(`Monsters ${first.toUpperCase()}–${last.toUpperCase()}`, group, out),
    });
  }
}

/** Level-`level` headings under the first heading titled `parent` (until a heading at or above its level). */
function countUnder(text: string, parent: string, level: number): number {
  let parentLevel: number | undefined;
  let count = 0;
  for (const line of text.split('\n')) {
    const heading = headingOf(line);
    if (!heading) continue;
    if (parentLevel === undefined) {
      if (heading.title === parent) parentLevel = heading.level;
      continue;
    }
    if (heading.level <= parentLevel) break;
    if (heading.level === level) count++;
  }
  return count;
}

function countLevel(text: string, level: number): number {
  return text.split('\n').filter((line) => headingOf(line)?.level === level).length;
}

export function buildSrd(sources: Readonly<Record<string, string>>): SrdBuild {
  const out: Collector = { files: [], generatedTitles: [], droppedHeadings: [] };
  const spellsByLevel: Record<string, number> = {};
  playingTheGame(source(sources, 'playing-the-game.md'), out);
  out.files.push({
    path: 'character-creation.md',
    text: toText(source(sources, 'character-creation.md').split('\n')),
  });
  classes(source(sources, 'classes.md'), out);
  origins(source(sources, 'character-origins.md'), out);
  out.files.push({ path: 'feats.md', text: toText(source(sources, 'feats.md').split('\n')) });
  equipment(source(sources, 'equipment.md'), out);
  spells(source(sources, 'spells.md'), out, spellsByLevel);
  for (const name of ['rules-glossary.md', 'gameplay-toolbox.md'] as const) {
    out.files.push({ path: name, text: toText(source(sources, name).split('\n')) });
  }
  magicItems(source(sources, 'magic-items.md'), out);
  out.files.push({
    path: 'monsters/rules.md',
    text: toText(source(sources, 'monsters.md').split('\n')),
  });
  monstersAZ(source(sources, 'monsters-A-Z.md'), out);
  out.files.push({
    path: 'monsters/animals.md',
    text: toText(source(sources, 'animals.md').split('\n')),
  });

  const tables: TableStats = { pipeTables: 0, statBlocks: 0, keptHtml: 0 };
  const files = out.files.map((file) => {
    const { text, stats } = normalizeTables(file.text);
    tables.pipeTables += stats.pipeTables;
    tables.statBlocks += stats.statBlocks;
    tables.keptHtml += stats.keptHtml;
    return { path: file.path, text };
  });
  const text = (path: string) => files.find((file) => file.path === path)?.text ?? '';
  const counts: SrdCounts = {
    classes: files.filter((file) => file.path.startsWith('classes/')).length,
    backgrounds: countUnder(text('origins/backgrounds.md'), 'Background Descriptions', 3),
    species: countUnder(text('origins/species.md'), 'Species Descriptions', 3),
    feats: countLevel(text('feats.md'), 4),
    spells: Object.values(spellsByLevel).reduce((sum, n) => sum + n, 0),
    spellsByLevel,
    magicItems: countLevel(text('magic-items/a-z.md'), 3),
    monsters: files
      .filter((file) => /^monsters\/[a-z]-[a-z]\.md$/.test(file.path))
      .reduce((sum, file) => sum + countLevel(file.text, 3), 0),
    animals: countLevel(text('monsters/animals.md'), 2),
  };
  return {
    files,
    counts,
    tables,
    generatedTitles: out.generatedTitles,
    droppedHeadings: out.droppedHeadings,
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run apps/cli/test/srd-split.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/cli/src/srd apps/cli/test/srd-split.test.ts && npm run typecheck
git add apps/cli/src/srd/split.ts apps/cli/test/srd-split.test.ts
git commit -m "feat(cli): split the SRD into per-area files and count its entries"
```

---

### Task 4: Word-level verification

**Files:**

- Create: `apps/cli/src/srd/verify.ts`
- Test: `apps/cli/test/srd-verify.test.ts`

**Interfaces:**

- Produces:
  - `IGNORED_WORDS: ReadonlySet<string>` = `{'mod', 'save'}`. The stat-block rewrite removes the `MOD`/`SAVE` headers and adds `save`, so those two words are not compared.
  - `wordCounts(texts: readonly string[]): Map<string, number>` — strips HTML tags, lowercases, and counts `[\p{L}\p{N}]+` tokens, minus ignored words. Curly apostrophes count as a separator, the same as straight ones.
  - `wordDifference(expected: Map<string, number>, actual: Map<string, number>): { missing: [string, number][]; extra: [string, number][] }` — sorted by word.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { wordCounts, wordDifference } from '../src/srd/verify';

describe('wordCounts', () => {
  it('counts words and numbers across texts, ignoring tags, case and mod/save', () => {
    const counts = wordCounts(['<td><strong>STR</strong></td> 8 MOD SAVE', 'str save 8']);
    expect(Object.fromEntries(counts)).toEqual({ str: 2, '8': 2 });
  });
  it('splits on apostrophes of both kinds', () => {
    expect(Object.fromEntries(wordCounts(["it’s it's"]))).toEqual({ it: 2, s: 2 });
  });
});

describe('wordDifference', () => {
  it('reports what is missing and what is extra', () => {
    const expected = new Map([
      ['acid', 2],
      ['arrow', 1],
    ]);
    const actual = new Map([
      ['acid', 1],
      ['bolt', 1],
    ]);
    expect(wordDifference(expected, actual)).toEqual({
      missing: [
        ['acid', 1],
        ['arrow', 1],
      ],
      extra: [['bolt', 1]],
    });
  });
  it('is empty for equal multisets', () => {
    expect(wordDifference(new Map([['a', 1]]), new Map([['a', 1]]))).toEqual({
      missing: [],
      extra: [],
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run apps/cli/test/srd-verify.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
/** Words the stat-block rewrite legitimately removes or adds; never compared. */
export const IGNORED_WORDS: ReadonlySet<string> = new Set(['mod', 'save']);

export function wordCounts(texts: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const plain = text.replace(/<[^>]+>/g, ' ').toLowerCase();
    for (const word of plain.match(/[\p{L}\p{N}]+/gu) ?? []) {
      if (IGNORED_WORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return counts;
}

export function wordDifference(
  expected: Map<string, number>,
  actual: Map<string, number>
): { missing: [string, number][]; extra: [string, number][] } {
  const missing: [string, number][] = [];
  const extra: [string, number][] = [];
  for (const word of new Set([...expected.keys(), ...actual.keys()])) {
    const diff = (expected.get(word) ?? 0) - (actual.get(word) ?? 0);
    if (diff > 0) missing.push([word, diff]);
    if (diff < 0) extra.push([word, -diff]);
  }
  const byWord = (a: [string, number], b: [string, number]) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  return { missing: missing.sort(byWord), extra: extra.sort(byWord) };
}
```

- [ ] **Step 4: Run to verify they pass** — `npx vitest run apps/cli/test/srd-verify.test.ts` — Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/cli/src/srd apps/cli/test/srd-verify.test.ts && npm run typecheck
git add apps/cli/src/srd/verify.ts apps/cli/test/srd-verify.test.ts
git commit -m "feat(cli): compare SRD word multisets for the lossless check"
```

---

### Task 5: The build script, the generated files, and the committed-data test

**Files:**

- Create: `apps/cli/src/srd/build.ts`
- Modify: `package.json` (script `"srd:build": "tsx apps/cli/src/srd/build.ts"`)
- Create (generated, committed): `data/srd-5.2.1/**` except `source/`, plus `README.md`, `LICENSE`, `counts.json`
- Test: `apps/cli/test/srd-data.test.ts`

**Interfaces:**

- Consumes: `buildSrd`, `SOURCE_FILES`, `SrdBuild` (Task 3); `wordCounts`, `wordDifference` (Task 4).
- Produces:
  - `SRD_DIR: string` (absolute path to `data/srd-5.2.1`)
  - `readSources(dir?: string): Promise<Record<string, string>>`
  - `formatMarkdown(text: string, filePath: string): Promise<string>` — Prettier with the repo's config
  - `renderSrd(build: SrdBuild): Promise<SrdFile[]>` — every output file formatted, plus `README.md`, `LICENSE` and `counts.json`, sorted by path
  - `writeSrd(files: readonly SrdFile[], dir?: string): Promise<void>` — removes every file under `dir` except `source/`, then writes `files`
  - `listGenerated(dir?: string): Promise<string[]>` — relative paths of every file under `dir` except `source/`, sorted

- [ ] **Step 1: Write the failing test**

`apps/cli/test/srd-data.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { listGenerated, readSources, renderSrd, SRD_DIR } from '../src/srd/build';
import { buildSrd, type SrdBuild, type SrdFile } from '../src/srd/split';
import { wordCounts, wordDifference } from '../src/srd/verify';

const AREA = (path: string) => path.endsWith('.md') && path !== 'README.md';

describe('data/srd-5.2.1', () => {
  let sources: Record<string, string>;
  let build: SrdBuild;
  let rendered: SrdFile[];

  beforeAll(async () => {
    sources = await readSources();
    build = buildSrd(sources);
    rendered = await renderSrd(build);
  }, 60_000);

  it('is exactly what the build produces from the vendored source', async () => {
    expect(await listGenerated()).toEqual(rendered.map((file) => file.path));
    for (const file of rendered) {
      expect(await readFile(join(SRD_DIR, file.path), 'utf8'), file.path).toBe(file.text);
    }
  }, 60_000);

  it('loses no word of the source', () => {
    const expected = wordCounts([...Object.values(sources), ...build.generatedTitles]);
    const dropped = wordCounts(build.droppedHeadings);
    for (const [word, n] of dropped) expected.set(word, (expected.get(word) ?? 0) - n);
    const actual = wordCounts(rendered.filter((file) => AREA(file.path)).map((file) => file.text));
    expect(wordDifference(expected, actual)).toEqual({ missing: [], extra: [] });
  });

  it('has every entry', () => {
    expect(build.counts).toMatchObject({
      classes: 12,
      backgrounds: 4,
      species: 9,
      feats: 17,
      spells: 339,
      magicItems: 260,
      monsters: 235,
      animals: 95,
    });
    expect(build.counts.spellsByLevel['0']).toBe(27);
  });

  it('carries the attribution', async () => {
    const statement =
      'This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd.';
    for (const name of ['README.md', 'LICENSE']) {
      expect((await readFile(join(SRD_DIR, name), 'utf8')).replace(/\s+/g, ' ')).toContain(
        statement
      );
    }
  });
});
```

If the measured counts differ from these numbers once the real build runs, stop. Compare against the source (for example `grep -c '^#### '` within the relevant section) and fix the mapping or the count rule. Never edit a number to match the build: these are the counts taken from the source on 2026-10-15.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run apps/cli/test/srd-data.test.ts` — Expected: FAIL (module `../src/srd/build` missing).

- [ ] **Step 3: Implement**

`apps/cli/src/srd/build.ts`:

```ts
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as prettier from 'prettier';
import { buildSrd, SOURCE_FILES, type SrdBuild, type SrdFile } from './split';

export const SRD_DIR = fileURLToPath(new URL('../../../../data/srd-5.2.1', import.meta.url));
const SOURCE_DIR = 'source';

const ATTRIBUTION =
  'This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of ' +
  'the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the ' +
  'Creative Commons Attribution 4.0 International License, available at ' +
  'https://creativecommons.org/licenses/by/4.0/legalcode.';

export async function readSources(dir = SRD_DIR): Promise<Record<string, string>> {
  const sources: Record<string, string> = {};
  for (const name of SOURCE_FILES)
    sources[name] = await readFile(join(dir, SOURCE_DIR, name), 'utf8');
  return sources;
}

export async function formatMarkdown(text: string, filePath: string): Promise<string> {
  const config = (await prettier.resolveConfig(filePath)) ?? {};
  return prettier.format(text, { ...config, filepath: filePath });
}

function readme(build: SrdBuild): string {
  const c = build.counts;
  return [
    '# SRD 5.2.1',
    '',
    'The Dungeons & Dragons 2024 core rules from the System Reference Document 5.2.1, split into one',
    'file per area for lookup and for the fine-tuning project (`docs/fine-tuning/guide.md`).',
    '',
    '## Attribution',
    '',
    ATTRIBUTION,
    '',
    'Changes made: the source Markdown below was split into these files, monster ability tables were',
    'rewritten as single lines, other simple HTML tables became Markdown tables, and line-ending',
    '`<br>` tags were removed. No rules text was edited.',
    '',
    '## Source',
    '',
    'Text from https://github.com/downfallx/dnd-5e-srd-markdown at commit',
    '`1b4b99dcb786cdd1a2fb26f8acec1551191f1ca4`, vendored unchanged in `source/`. On 2026-10-15, 98.9%',
    'of the words of the official PDF',
    '(https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf) appeared in it; the',
    "rest was the PDF's page footer, stat-block index entries and hyphenation joins.",
    '',
    '## Rebuilding',
    '',
    'Run `npm run srd:build`. The suite test `apps/cli/test/srd-data.test.ts` fails if these files',
    'differ from a fresh build or lose any word of the source.',
    '',
    '## Contents',
    '',
    `- ${c.classes} classes, ${c.backgrounds} backgrounds, ${c.species} species, ${c.feats} feats`,
    `- ${c.spells} spells (${c.spellsByLevel['0'] ?? 0} cantrips)`,
    `- ${c.magicItems} magic items, ${c.monsters} monster stat blocks, ${c.animals} animals`,
    `- Tables: ${build.tables.statBlocks} stat blocks rewritten, ${build.tables.pipeTables} converted, ${build.tables.keptHtml} kept as HTML (merged cells)`,
    '',
  ].join('\n');
}

export async function renderSrd(build: SrdBuild): Promise<SrdFile[]> {
  const files: SrdFile[] = [];
  for (const file of build.files) {
    files.push({
      path: file.path,
      text: await formatMarkdown(file.text, join(SRD_DIR, file.path)),
    });
  }
  files.push({
    path: 'README.md',
    text: await formatMarkdown(readme(build), join(SRD_DIR, 'README.md')),
  });
  files.push({
    path: 'LICENSE',
    text: `Creative Commons Attribution 4.0 International License\n\n${ATTRIBUTION}\n`,
  });
  files.push({
    path: 'counts.json',
    text: await formatMarkdown(
      JSON.stringify({ counts: build.counts, tables: build.tables }),
      join(SRD_DIR, 'counts.json')
    ),
  });
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function listGenerated(dir = SRD_DIR): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = relative(dir, full).split(sep).join('/');
      if (rel === SOURCE_DIR) continue;
      if (entry.isDirectory()) await walk(full);
      else found.push(rel);
    }
  };
  await walk(dir);
  return found.sort();
}

export async function writeSrd(files: readonly SrdFile[], dir = SRD_DIR): Promise<void> {
  for (const rel of await listGenerated(dir)) await rm(join(dir, rel));
  for (const file of files) {
    const target = join(dir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.text);
  }
}

async function main(): Promise<void> {
  const build = buildSrd(await readSources());
  const files = await renderSrd(build);
  await writeSrd(files);
  console.log(`Wrote ${files.length} files to ${SRD_DIR}`);
  console.log(JSON.stringify(build.counts));
  console.log(`Tables: ${JSON.stringify(build.tables)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
```

`writeSrd` removes files, never directories. If a mapping change empties a directory, delete the empty directory by hand in that commit. Use `find data/srd-5.2.1 -type d -empty -not -path '*/source*' -delete`.

Add to the root `package.json` `scripts`: `"srd:build": "tsx apps/cli/src/srd/build.ts"`.

- [ ] **Step 4: Build the data**

Run: `npm run srd:build`
Expected: `Wrote 45 files to …/data/srd-5.2.1`, and counts matching the test. That's 42 area files plus README, LICENSE and counts.json. The area files are 6 playing-the-game, character-creation, 12 classes, 2 origins, feats, 7 equipment, spells rules + cantrips + 9 levels, rules-glossary, gameplay-toolbox, 2 magic-items, monsters rules + 4 letters + animals.

Then: `npm run format:check`. Expected: passes. If Prettier would still change a generated file, `formatMarkdown` was given the wrong `filepath`; fix that, not the file.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run apps/cli/test/srd-data.test.ts`
Expected: PASS (4 tests). On a word mismatch, the failure lists the words. Find where they went (usually a section the mapping put nowhere) and fix `split.ts`.

- [ ] **Step 6: Add a test that rebuilding removes stale area files but never `source/`**

Append to `apps/cli/test/srd-data.test.ts`:

```ts
import { mkdtemp, mkdir as mk, writeFile as wf } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeSrd } from '../src/srd/build';

it('rewrites everything but source/', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'srd-'));
  await mk(join(dir, 'source'), { recursive: true });
  await wf(join(dir, 'source', 'spells.md'), 'keep');
  await mk(join(dir, 'old'), { recursive: true });
  await wf(join(dir, 'old', 'gone.md'), 'stale');
  await writeSrd([{ path: 'spells/rules.md', text: '# Spells\n' }], dir);
  expect(await listGenerated(dir)).toEqual(['spells/rules.md']);
  expect(await readFile(join(dir, 'source', 'spells.md'), 'utf8')).toBe('keep');
});
```

Merge the imports into the file's import block rather than leaving a second one mid-file. Run: `npx vitest run apps/cli/test/srd-data.test.ts`. Expected: PASS (5 tests).

- [ ] **Step 7: Full check and commit**

```bash
npm test 2>&1 | grep -E "Tests |Test Files"
npm run typecheck && npm run format:check
git add package.json apps/cli/src/srd/build.ts apps/cli/test/srd-data.test.ts data/srd-5.2.1
git commit -m "feat(cli): build the SRD 5.2.1 area files and verify them in the suite"
```

Expected test line: the previous count plus this plan's tests so far, with 1 expected fail and 6 skipped.

---

### Task 6: The rules index (`sim index --rules`)

**Files:**

- Modify: `packages/lore/src/ingest.ts` (`readLoreFiles` takes an `include` filter)
- Modify: `packages/lore/src/build.ts` (`BuildOptions.include`)
- Create: `apps/cli/src/srd/rules-index.ts`
- Modify: `apps/cli/src/index-lore.ts` (`formatIndexSummary` takes a `kind`)
- Modify: `apps/cli/src/main.ts` (`--rules` flag)
- Test: `packages/lore/test/ingest.test.ts` (or the existing ingest test file), `apps/cli/test/srd-rules-index.test.ts`

**Interfaces:**

- Consumes: `buildIndex`, `readMeta`, `isStale`, `readLoreFiles`, `contentDigest`, `loreVersion`, `CHUNKER_VERSION`, `DOCUMENT_PREFIX`, `QUERY_PREFIX` from `@cartyx-sim/lore`; `embedderFor`, `IndexResult`, `formatIndexSummary` from `apps/cli/src/index-lore.ts`; `loadCampaign`; `SRD_DIR` (Task 5).
- Produces:
  - `readLoreFiles(repoPath: string, include?: (relativePath: string) => boolean): Promise<LoreFile[]>`. The default is the existing `isIndexable`.
  - `BuildOptions.include?: (relativePath: string) => boolean`, passed through to `readLoreFiles`
  - `isRulesFile(relativePath: string): boolean`: true for `.md` files except `README.md` at the root and anything under `source/`
  - `rulesIndexDir(): string` = `<repo>/data/.cache/srd-index`
  - `ensureRulesIndex(options: { campaignsDir: string; campaign: string; force?: boolean; check?: boolean; log?: (line: string) => void; embedder?: Embedder; srdDir?: string; indexDir?: string }): Promise<IndexResult>`
  - `formatIndexSummary(result: IndexResult, kind: 'lore' | 'rules' = 'lore'): string[]`

- [ ] **Step 1: Write the failing lore test**

Add to the existing `packages/lore` ingest tests. Find the file with `grep -ln readLoreFiles packages/lore/test/*.ts`.

```ts
it('reads only the files the filter accepts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lore-include-'));
  await mkdir(join(root, 'source'), { recursive: true });
  await writeFile(join(root, 'a.md'), '# A\n');
  await writeFile(join(root, 'source', 'b.md'), '# B\n');
  const files = await readLoreFiles(root, (path) => !path.startsWith('source/'));
  expect(files.map((file) => file.path)).toEqual(['a.md']);
});
```

Add whichever of `mkdtemp`, `mkdir`, `writeFile`, `tmpdir` and `join` the file doesn't already import.

- [ ] **Step 2: Run to verify it fails.** Run `npx vitest run packages/lore/test`. Expected: FAIL, because `source/b.md` is returned.

- [ ] **Step 3: Implement the filter**

In `packages/lore/src/ingest.ts`, change the signature and the one use:

```ts
export async function readLoreFiles(
  repoPath: string,
  include: (relativePath: string) => boolean = isIndexable
): Promise<LoreFile[]> {
```

and replace `if (!entry.isFile() || !isIndexable(rel)) continue;` with `if (!entry.isFile() || !include(rel)) continue;`.

In `packages/lore/src/build.ts`, add to `BuildOptions`:

```ts
  /** Which files under `lorePath` to index; defaults to every lore Markdown file. */
  include?: (relativePath: string) => boolean;
```

and in `buildIndex` use `const files = await readLoreFiles(options.lorePath, options.include);`.

Run: `npx vitest run packages/lore/test`. Expected: PASS.

- [ ] **Step 4: Write the failing CLI test**

`apps/cli/test/srd-rules-index.test.ts`. It reuses the campaign fixture shape from `apps/cli/test/index-lore.test.ts` (a campaign with an `embed` seat) and the `FakeEmbedder` from `@cartyx-sim/lore`:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEmbedder } from '@cartyx-sim/lore';
import { describe, expect, it } from 'vitest';
import { formatIndexSummary } from '../src/index-lore';
import { ensureRulesIndex, isRulesFile } from '../src/srd/rules-index';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sim-rules-'));
  const srdDir = join(root, 'srd');
  await mkdir(join(root, 'lore'), { recursive: true });
  await mkdir(join(srdDir, 'spells'), { recursive: true });
  await mkdir(join(srdDir, 'source'), { recursive: true });
  await writeFile(
    join(srdDir, 'README.md'),
    '# SRD\n\nAbout this folder, long enough to be a chunk if it were indexed at all.\n'
  );
  await writeFile(
    join(srdDir, 'source', 'spells.md'),
    '# Spells\n\nThe untouched upstream copy, which must never be indexed twice.\n'
  );
  await writeFile(
    join(srdDir, 'spells', 'level-3.md'),
    '# Level 3 Spells\n\n## Fireball\n\nA bright streak flashes from your pointing finger to a point you choose within range.\n'
  );
  const campaignsDir = join(root, 'campaigns');
  await mkdir(join(campaignsDir, 'test', 'characters'), { recursive: true });
  await writeFile(
    join(campaignsDir, 'test', 'campaign.json'),
    JSON.stringify({
      name: 'Test',
      targetMinutes: 5,
      lorePath: join(root, 'lore'),
      endpoints: { local: { baseURL: 'http://127.0.0.1:1234/v1' } },
      seats: {
        dm: { endpoint: 'local', model: 'dm-model' },
        embed: { endpoint: 'local', model: 'embed-model' },
        players: { kira: { endpoint: 'local', model: 'pc-model' } },
      },
    })
  );
  return { campaignsDir, campaign: 'test', srdDir, indexDir: join(root, 'index') };
}

describe('isRulesFile', () => {
  it('indexes area files only', () => {
    expect(isRulesFile('spells/level-3.md')).toBe(true);
    expect(isRulesFile('README.md')).toBe(false);
    expect(isRulesFile('source/spells.md')).toBe(false);
    expect(isRulesFile('counts.json')).toBe(false);
  });
});

describe('ensureRulesIndex', () => {
  it('builds from area files, then reports fresh without rebuilding', async () => {
    const options = { ...(await fixture()), embedder: new FakeEmbedder() };
    const built = await ensureRulesIndex(options);
    expect(built.rebuilt).toBe(true);
    expect(built.meta?.files).toBe(1);
    const again = await ensureRulesIndex(options);
    expect(again.rebuilt).toBe(false);
    expect(again.stale).toBe(false);
    expect(formatIndexSummary(again, 'rules')[0]).toMatch(/^Index is fresh/);
  });

  it('says "rules" when no index exists yet', async () => {
    const options = { ...(await fixture()), embedder: new FakeEmbedder(), check: true };
    const result = await ensureRulesIndex(options);
    expect(formatIndexSummary(result, 'rules')[0]).toMatch(/^No rules index/);
  });
});
```

If `FakeEmbedder`'s constructor takes arguments, match its use in `apps/cli/test/index-lore.test.ts`.

- [ ] **Step 5: Run to verify it fails.** Run `npx vitest run apps/cli/test/srd-rules-index.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 6: Implement**

`apps/cli/src/srd/rules-index.ts`:

```ts
import { join } from 'node:path';
import {
  buildIndex,
  CHUNKER_VERSION,
  contentDigest,
  DOCUMENT_PREFIX,
  isStale,
  loreVersion,
  QUERY_PREFIX,
  readLoreFiles,
  readMeta,
  type Embedder,
  type IndexIdentity,
} from '@cartyx-sim/lore';
import { loadCampaign } from '../campaign';
import { embedderFor, type IndexResult } from '../index-lore';
import { SRD_DIR } from './build';

export function isRulesFile(relativePath: string): boolean {
  const path = relativePath.replaceAll('\\', '/');
  return path.endsWith('.md') && path !== 'README.md' && !path.startsWith('source/');
}

export function rulesIndexDir(): string {
  return join(SRD_DIR, '..', '.cache', 'srd-index');
}

export interface RulesIndexOptions {
  campaignsDir: string;
  campaign: string;
  force?: boolean;
  check?: boolean;
  log?: (line: string) => void;
  embedder?: Embedder;
  /** Overridden by tests. */
  srdDir?: string;
  /** Overridden by tests. */
  indexDir?: string;
}

/** Builds the rules index when it is missing or stale; the campaign supplies only the embed seat. */
export async function ensureRulesIndex(options: RulesIndexOptions): Promise<IndexResult> {
  const campaign = await loadCampaign(options.campaignsDir, options.campaign);
  const embedder = options.embedder ?? embedderFor(campaign);
  const srdDir = options.srdDir ?? SRD_DIR;
  const indexDir = options.indexDir ?? rulesIndexDir();
  const existing = await readMeta(indexDir);
  const digest = contentDigest(await readLoreFiles(srdDir, isRulesFile));
  const identity: IndexIdentity = {
    lorePath: srdDir,
    contentDigest: digest,
    embedModel: embedder.model,
    documentPrefix: DOCUMENT_PREFIX,
    queryPrefix: QUERY_PREFIX,
    chunkerVersion: CHUNKER_VERSION,
  };
  const loreCommit = await loreVersion(srdDir, digest);
  const stale = isStale(existing, identity);
  if (options.check || (!stale && existing && options.force !== true)) {
    return {
      indexDir,
      rebuilt: false,
      stale: options.check ? stale : false,
      meta: existing,
      ambiguous: existing?.ambiguous ?? [],
      loreCommit,
      buildMs: undefined,
    };
  }
  const started = Date.now();
  const built = await buildIndex({
    lorePath: srdDir,
    indexDir,
    embedder,
    include: isRulesFile,
    log: options.log,
  });
  return {
    indexDir,
    rebuilt: true,
    stale: false,
    meta: built.meta,
    ambiguous: built.ambiguous,
    loreCommit: built.meta.loreCommit,
    buildMs: Date.now() - started,
  };
}
```

In `apps/cli/src/index-lore.ts`, change `formatIndexSummary(result: IndexResult)` to `formatIndexSummary(result: IndexResult, kind: 'lore' | 'rules' = 'lore')`. Then replace its three hard-coded words:

- `No lore index at` → `` `No ${kind} index at` ``
- `Run \`sim index\``→ `` kind === 'rules' ? 'Run`sim index --rules`' : 'Run `sim index`' `` (both places)
- `Lore commit:` / `Lore is at` → `` `${kind === 'rules' ? 'Rules' : 'Lore'} commit:` `` / `` `${kind === 'rules' ? 'Rules are' : 'Lore is'} at` ``

The existing lore tests must pass unchanged.

In `apps/cli/src/main.ts`, add `.option('--rules', 'build the SRD rules index instead of the lore index', false)` to the `index` command, add `rules: boolean` to `IndexCommandOptions`, and in its action:

```ts
if (options.rules) {
  const result = await ensureRulesIndex({
    campaignsDir: options.campaignsDir,
    campaign: options.campaign,
    force: options.force,
    check: options.check,
    log: (line) => console.log(line),
  });
  for (const line of formatIndexSummary(result, 'rules')) console.log(line);
  return;
}
```

Also confirm `data/.cache/` is git-ignored. Run `git check-ignore data/.cache/srd-index/meta.json`; it should print the path. The root `.gitignore` already ignores `.cache` at any depth.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run apps/cli/test/srd-rules-index.test.ts apps/cli/test/index-lore.test.ts packages/lore/test`
Expected: PASS.

- [ ] **Step 8: Build the real rules index once**

This needs the M5 Max's LM Studio running with the embed model loaded. Run it without the sandbox.

Run: `npm run sim -- index --rules --campaign avalon`
Expected: `Built N chunks from 42 files … (text-embedding-nomic-embed-text-v1.5, 768 dims)`. Record N in the commit message.

- [ ] **Step 9: Full check and commit**

```bash
npm test 2>&1 | grep -E "Tests |Test Files"
npm run typecheck && npm run format:check
git add packages/lore/src apps/cli/src apps/cli/test packages/lore/test
git commit -m "feat(cli): sim index --rules builds a separate SRD rules index"
```

---

### Task 7: Guide chapter and status

**Files:**

- Modify: `docs/fine-tuning/guide.md` (append Chapter 3)
- Modify: `docs/running-a-session.md` (a short "Rules index" paragraph next to the lore index section)

- [ ] **Step 1: Write Chapter 3**

Append to `docs/fine-tuning/guide.md` a chapter titled `## Chapter 3 — The rules as data (<date>)`, written for a non-specialist, covering:

- what we built: the pinned source, the split into the actual file counts, stat blocks as single lines, and the separate rules index;
- **why "reproducible from a pinned source" matters**: anyone can check that our rules text is the SRD and nothing else, which is also what the CC-BY licence asks;
- **why a lossless check**: a split that silently drops a paragraph would teach the model a rule with a hole in it, and no person would notice in 1.9 MB of text;
- **what an embedding index is**: text turned into vectors, so "can I cast two spells in one turn" finds the bonus-action casting rule even without sharing its words;
- the real numbers from `counts.json` and the chunk count from Task 6.

Add glossary entries for **pinned source**, **reproducible build**, **embedding** and **vector index**. Sources: the SRD page and the upstream repo.

- [ ] **Step 2: Document the command**

In `docs/running-a-session.md`, find the lore index section with `grep -n "sim index" docs/running-a-session.md` and add after it:

```markdown
**Rules index.** `sim index --rules --campaign <id>` builds a separate search index of the SRD 5.2.1 rules in `data/srd-5.2.1/` (stored in `data/.cache/srd-index/`, rebuilt only when those files change), using the campaign's embed seat. No session reads it yet; the player scorecard's judge is its first user. Rebuild the rules files themselves with `npm run srd:build`.
```

- [ ] **Step 3: Commit**

```bash
npx prettier --write docs/fine-tuning/guide.md docs/running-a-session.md && npm run format:check
git add docs
git commit -m "docs: guide chapter 3 on the SRD rules data, and the rules index command"
```
