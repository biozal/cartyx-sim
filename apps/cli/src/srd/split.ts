import { headingOf, shiftHeadings, splitSections, toText, type Section } from './markdown';
import { normalizeTables, type TableStats } from './tables';

/** The vendored upstream files, in `data/srd-5.2.1/source/`. */
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

function sectionPool(sections: Section[], from: string): Map<string, Section> {
  const pool = new Map<string, Section>();
  for (const section of sections) {
    if (pool.has(section.title)) throw new Error(`${from}: duplicate section "${section.title}"`);
    pool.set(section.title, section);
  }
  return pool;
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

function takeOne(pool: Map<string, Section>, title: string, from: string): Section {
  return take(pool, [title], from)[0]!;
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

function whole(text: string): string {
  return toText(text.split(/\r?\n/));
}

function playingTheGame(text: string, out: Collector): void {
  const from = 'playing-the-game.md';
  const { preamble, sections } = splitSections(text, 2);
  const pool = sectionPool(sections, from);
  const basics = ['Rhythm of Play', 'The Six Abilities', 'D20 Tests', 'Proficiency'];
  out.files.push({
    path: 'playing-the-game/d20-tests.md',
    text: grouped(preamble, take(pool, basics, from)),
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
      text: promoted(takeOne(pool, title, from)),
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
    text: promoted(takeOne(pool, 'Character Backgrounds', from)),
  });
  out.files.push({
    path: 'origins/species.md',
    text: promoted(takeOne(pool, 'Character Species', from)),
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
      text: promoted(takeOne(pool, title, from)),
    });
  }
  const services = [
    'Lifestyle Expenses',
    'Food, Drink, and Lodging',
    'Hirelings',
    'Spellcasting',
    'Magic Items',
  ];
  out.files.push({
    path: 'equipment/services.md',
    text: generated('Services', take(pool, services, from), out),
  });
  const crafting = [
    'Crafting Nonmagical Items',
    'Brewing Potions of Healing',
    'Scribing Spell Scrolls',
  ];
  out.files.push({
    path: 'equipment/crafting.md',
    text: generated('Crafting', take(pool, crafting, from), out),
  });
  assertEmpty(pool, from);
}

/** The spell level a `####` heading starts (0 for a cantrip), or undefined when it is not a spell. */
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
    // A summoned creature's stat block follows its spell at level 2; it belongs under the spell.
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

/** Level-`level` headings under the first heading titled `parent`, until it closes. */
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

/** Splits the vendored SRD into its per-area files, normalizes their tables, and counts entries. */
export function buildSrd(sources: Readonly<Record<string, string>>): SrdBuild {
  const out: Collector = { files: [], generatedTitles: [], droppedHeadings: [] };
  const spellsByLevel: Record<string, number> = {};
  playingTheGame(source(sources, 'playing-the-game.md'), out);
  out.files.push({
    path: 'character-creation.md',
    text: whole(source(sources, 'character-creation.md')),
  });
  classes(source(sources, 'classes.md'), out);
  origins(source(sources, 'character-origins.md'), out);
  out.files.push({ path: 'feats.md', text: whole(source(sources, 'feats.md')) });
  equipment(source(sources, 'equipment.md'), out);
  spells(source(sources, 'spells.md'), out, spellsByLevel);
  for (const name of ['rules-glossary.md', 'gameplay-toolbox.md']) {
    out.files.push({ path: name, text: whole(source(sources, name)) });
  }
  magicItems(source(sources, 'magic-items.md'), out);
  out.files.push({ path: 'monsters/rules.md', text: whole(source(sources, 'monsters.md')) });
  monstersAZ(source(sources, 'monsters-A-Z.md'), out);
  out.files.push({ path: 'monsters/animals.md', text: whole(source(sources, 'animals.md')) });

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
