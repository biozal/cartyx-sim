import { readdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../src/atomic-write';

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
