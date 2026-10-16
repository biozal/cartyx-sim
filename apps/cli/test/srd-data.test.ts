import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { listGenerated, readSources, renderSrd, SRD_DIR, writeSrd } from '../src/srd/build';
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
  });

  it('loses no word of the source', () => {
    const expected = wordCounts([...Object.values(sources), ...build.generatedTitles]);
    for (const [word, n] of wordCounts(build.droppedHeadings)) {
      expected.set(word, (expected.get(word) ?? 0) - n);
    }
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

describe('writeSrd', () => {
  it('rewrites everything but source/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'srd-'));
    await mkdir(join(dir, 'source'), { recursive: true });
    await writeFile(join(dir, 'source', 'spells.md'), 'keep');
    await mkdir(join(dir, 'old'), { recursive: true });
    await writeFile(join(dir, 'old', 'gone.md'), 'stale');
    await writeSrd([{ path: 'spells/rules.md', text: '# Spells\n' }], dir);
    expect(await listGenerated(dir)).toEqual(['spells/rules.md']);
    expect(await readFile(join(dir, 'source', 'spells.md'), 'utf8')).toBe('keep');
  });
});
