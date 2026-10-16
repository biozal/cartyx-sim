import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as prettier from 'prettier';
import { buildSrd, SOURCE_FILES, type SrdBuild, type SrdFile } from './split';

/** `data/srd-5.2.1` at the repository root. */
export const SRD_DIR = fileURLToPath(new URL('../../../../data/srd-5.2.1', import.meta.url));
const SOURCE_DIR = 'source';

const ATTRIBUTION =
  'This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of ' +
  'the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the ' +
  'Creative Commons Attribution 4.0 International License, available at ' +
  'https://creativecommons.org/licenses/by/4.0/legalcode.';

export async function readSources(dir = SRD_DIR): Promise<Record<string, string>> {
  const sources: Record<string, string> = {};
  for (const name of SOURCE_FILES) {
    sources[name] = await readFile(join(dir, SOURCE_DIR, name), 'utf8');
  }
  return sources;
}

/** Formats with the repository's Prettier config, as `npm run format` would for that path. */
export async function formatMarkdown(text: string, filePath: string): Promise<string> {
  const config = (await prettier.resolveConfig(filePath)) ?? {};
  return prettier.format(text, { ...config, filepath: filePath });
}

function readme(build: SrdBuild): string {
  const c = build.counts;
  const t = build.tables;
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
    `- Tables: ${t.statBlocks} ability tables rewritten as lines, ${t.pipeTables} converted to Markdown, ${t.keptHtml} kept as HTML (merged cells or an unusual layout)`,
    '',
  ].join('\n');
}

/** Every generated file, formatted, sorted by path: the area files, README, LICENSE, counts. */
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

/** Relative paths of every file under `dir` except the vendored `source/`, sorted. */
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

/** Replaces every generated file under `dir` with `files`; `source/` is never touched. */
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
