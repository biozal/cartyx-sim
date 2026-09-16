import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileLabelCache } from '../src/label-cache';

const KEY = 'b'.repeat(64);

describe('FileLabelCache', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cartyx-sim-cache-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('misses, then returns what was stored, creating its folder', async () => {
    const cache = new FileLabelCache(join(dir, '.script-cache'));
    expect(await cache.get(KEY)).toBeUndefined();
    await cache.set(KEY, { labels: [{ quote: 1, speaker: 'none' }] });
    expect(await cache.get(KEY)).toEqual({ labels: [{ quote: 1, speaker: 'none' }] });
  });

  it('treats an unreadable entry as a miss', async () => {
    await mkdir(join(dir, 'c'), { recursive: true });
    await writeFile(join(dir, 'c', `${KEY}.json`), '{ not json');
    expect(await new FileLabelCache(join(dir, 'c')).get(KEY)).toBeUndefined();
  });

  it('refuses a key that is not a hex digest', async () => {
    await expect(new FileLabelCache(dir).set('../escape', {})).rejects.toThrow(
      'Invalid label cache key'
    );
  });
});
