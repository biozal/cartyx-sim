import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LabelCache } from '@cartyx-sim/script';
import { writeFileAtomic } from './atomic-write';

const KEY = /^[0-9a-f]{64}$/;

/** Model label replies, one JSON file per cache key. An unreadable entry counts as a miss. */
export class FileLabelCache implements LabelCache {
  constructor(readonly dir: string) {}

  async get(key: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.path(key), 'utf8'));
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    const path = this.path(key);
    await mkdir(this.dir, { recursive: true });
    await writeFileAtomic(path, `${JSON.stringify(value)}\n`);
  }

  private path(key: string): string {
    if (!KEY.test(key)) throw new Error(`Invalid label cache key "${key}"`);
    return join(this.dir, `${key}.json`);
  }
}
