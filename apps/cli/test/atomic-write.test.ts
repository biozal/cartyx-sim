import { readdir, readFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic, writeFilesAtomic } from '../src/atomic-write';

describe('writeFileAtomic', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cartyx-sim-atomic-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a new file', async () => {
    const path = join(dir, 'new.txt');
    await writeFileAtomic(path, 'hello');
    expect(await readFile(path, 'utf8')).toBe('hello');
  });

  it('replaces an existing file', async () => {
    const path = join(dir, 'existing.txt');
    await writeFile(path, 'old');
    await writeFileAtomic(path, 'new');
    expect(await readFile(path, 'utf8')).toBe('new');
  });

  it('rejects and leaves no temp file when the directory does not exist', async () => {
    const path = join(dir, 'missing-dir', 'file.txt');
    await expect(writeFileAtomic(path, 'content')).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it('rethrows the original error, not one from a failed cleanup unlink', async () => {
    const path = join(dir, 'file.txt');
    await expect(
      writeFileAtomic(path, 'content', {
        rename: async () => {
          throw new Error('rename failed: disk full');
        },
        unlink: async () => {
          throw new Error('unlink failed: permission denied');
        },
      })
    ).rejects.toThrow('rename failed: disk full');
  });
});

describe('writeFilesAtomic', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cartyx-sim-atomic-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes every file and renames them in the given order', async () => {
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    await writeFilesAtomic([
      { path: a, content: 'A' },
      { path: b, content: 'B' },
    ]);
    expect(await readFile(a, 'utf8')).toBe('A');
    expect(await readFile(b, 'utf8')).toBe('B');
    expect((await readdir(dir)).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('on a failure on the second rename, leaves the first file written, the second untouched, and no temp files', async () => {
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    let renames = 0;

    await expect(
      writeFilesAtomic(
        [
          { path: a, content: 'A' },
          { path: b, content: 'B' },
        ],
        {
          rename: async (from, to) => {
            renames++;
            if (renames === 2) throw new Error('rename failed: disk full');
            await rename(from, to);
          },
        }
      )
    ).rejects.toThrow('rename failed: disk full');

    expect(await readFile(a, 'utf8')).toBe('A');
    await expect(readFile(b, 'utf8')).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['a.txt']);
  });
});
