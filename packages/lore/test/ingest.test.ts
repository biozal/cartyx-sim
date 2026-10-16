import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentDigest, isIndexable, readLoreFiles } from '../src/ingest';

describe('isIndexable', () => {
  it('takes lore markdown', () => {
    expect(isIndexable('dm/regions/south/cities/albany.md')).toBe(true);
    expect(isIndexable('kanka-export/markdown/characters/2227410-2227410.md')).toBe(true);
    expect(isIndexable('population/georgia.md')).toBe(true);
    expect(isIndexable('gods.md')).toBe(true);
  });

  it('skips non-markdown, dependencies, git, and nav stubs', () => {
    expect(isIndexable('tools/kanka_export.py')).toBe(false);
    expect(isIndexable('node_modules/x/readme.md')).toBe(false);
    expect(isIndexable('.git/COMMIT_EDITMSG')).toBe(false);
    expect(isIndexable('kanka-export/markdown/characters/_index.md')).toBe(false);
    expect(isIndexable('kanka-export/markdown/index.md')).toBe(false);
  });
});

describe('readLoreFiles', () => {
  it('walks a repo, returns sorted relative paths, and skips excluded files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lore-'));
    await mkdir(join(dir, 'dm'), { recursive: true });
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await writeFile(join(dir, 'gods.md'), '# Gods\n');
    await writeFile(join(dir, 'dm', 'notes.md'), '# Notes\n');
    await writeFile(join(dir, 'dm', 'script.py'), 'print(1)\n');
    await writeFile(join(dir, 'node_modules', 'readme.md'), '# Nope\n');
    const files = await readLoreFiles(dir);
    expect(files.map((file) => file.path)).toEqual(['dm/notes.md', 'gods.md']);
  });

  it('skips markdown inside dependency and VCS directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lore-skip-'));
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'pkg', 'readme.md'), '# Dependency\n');
    await writeFile(join(dir, '.git', 'NOTES.md'), '# Git internals\n');
    await writeFile(join(dir, 'gods.md'), '# Gods\n');
    const files = await readLoreFiles(dir);
    expect(files.map((file) => file.path)).toEqual(['gods.md']);
  });
});

describe('contentDigest', () => {
  it('is stable regardless of order and changes when content changes', () => {
    const a = [
      { path: 'a.md', text: 'one' },
      { path: 'b.md', text: 'two' },
    ];
    const reordered = [...a].reverse();
    expect(contentDigest(a)).toBe(contentDigest(reordered));
    expect(contentDigest(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contentDigest([{ path: 'a.md', text: 'one!' }, a[1]!])).not.toBe(contentDigest(a));
  });

  it('changes when a file is renamed but its content is not', () => {
    expect(contentDigest([{ path: 'a.md', text: 'one' }])).not.toBe(
      contentDigest([{ path: 'b.md', text: 'one' }])
    );
  });
});

describe('readLoreFiles include filter', () => {
  it('reads only the files the filter accepts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lore-include-'));
    await mkdir(join(root, 'source'), { recursive: true });
    await writeFile(join(root, 'a.md'), '# A\n');
    await writeFile(join(root, 'source', 'b.md'), '# B\n');
    const files = await readLoreFiles(root, (path) => !path.startsWith('source/'));
    expect(files.map((file) => file.path)).toEqual(['a.md']);
  });
});
