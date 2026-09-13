import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimEvent } from '@cartyx-sim/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFileSink, type JsonlFileSinkFs } from '../src/jsonl-sink';

const event = (seq: number): SimEvent =>
  SimEvent.parse({
    seq,
    ts: '2026-09-13T12:00:00.000Z',
    turnId: 'turn-1',
    visibility: 'public',
    type: 'ooc_note',
    text: `note ${seq}`,
  });

describe('JsonlFileSink', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cartyx-sim-sink-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns no events for a missing file', async () => {
    const sink = new JsonlFileSink(join(dir, 'missing', 'events.jsonl'));
    expect(await sink.exists()).toBe(false);
    expect(await sink.readAll()).toEqual([]);
  });

  it('creates directories and round-trips appended turns', async () => {
    const sink = new JsonlFileSink(join(dir, 'a', 'b', 'events.jsonl'));
    await sink.append([event(0), event(1)]);
    await sink.append([event(2)]);
    expect(await sink.exists()).toBe(true);
    expect(await sink.readAll()).toEqual([event(0), event(1), event(2)]);
  });

  it('reports the line number of a corrupt event', async () => {
    const path = join(dir, 'events.jsonl');
    await writeFile(path, `${JSON.stringify(event(0))}\n{"seq": "oops"}\n`);
    await expect(new JsonlFileSink(path).readAll()).rejects.toThrow(`${path}:2: invalid event`);
  });

  describe('seq continuity', () => {
    it('treats an empty log as expecting seq 0', async () => {
      const sink = new JsonlFileSink(join(dir, 'events.jsonl'));
      await expect(sink.append([event(1)])).rejects.toThrow(/seq/i);
      expect(await sink.exists()).toBe(false);
    });

    it('refuses to append a non-continuous seq and writes nothing', async () => {
      const path = join(dir, 'events.jsonl');
      const sink = new JsonlFileSink(path);
      await sink.append([event(0)]);
      await expect(sink.append([event(2)])).rejects.toThrow(/seq/i);
      expect(await sink.readAll()).toEqual([event(0)]);
    });

    it('checks continuity against what is on disk even for a sink that never called readAll', async () => {
      const path = join(dir, 'events.jsonl');
      await new JsonlFileSink(path).append([event(0), event(1)]);
      const fresh = new JsonlFileSink(path);
      await expect(fresh.append([event(3)])).rejects.toThrow(/seq/i);
      await fresh.append([event(2)]);
      expect(await fresh.readAll()).toEqual([event(0), event(1), event(2)]);
    });
  });

  describe('locking', () => {
    it('acquireLock writes the pid and time to a sibling lock file', async () => {
      const path = join(dir, 'events.jsonl');
      const sink = new JsonlFileSink(path);
      await sink.acquireLock();
      const content = await readFile(`${path}.lock`, 'utf8');
      expect(content).toContain(String(process.pid));
      expect(content).toMatch(/\d{4}-\d{2}-\d{2}T/);
      await sink.releaseLock();
    });

    it('refuses a second lock while the first is held, and mentions the lock is stale-deletable', async () => {
      const path = join(dir, 'events.jsonl');
      const first = new JsonlFileSink(path);
      const second = new JsonlFileSink(path);
      await first.acquireLock();
      await expect(second.acquireLock()).rejects.toThrow(/another run may be active/i);
      await expect(second.acquireLock()).rejects.toThrow(/delete/i);
      await first.releaseLock();
    });

    it('lets a new lock be acquired once the previous one is released', async () => {
      const path = join(dir, 'events.jsonl');
      const sink = new JsonlFileSink(path);
      await sink.acquireLock();
      await sink.releaseLock();
      await expect(new JsonlFileSink(path).acquireLock()).resolves.toBeUndefined();
    });

    it('releaseLock without a held lock is a no-op', async () => {
      const sink = new JsonlFileSink(join(dir, 'events.jsonl'));
      await expect(sink.releaseLock()).resolves.toBeUndefined();
    });
  });

  describe('injectable filesystem', () => {
    it('routes reads and writes through the injected functions instead of node:fs/promises', async () => {
      const real = await import('node:fs/promises');
      const calls: string[] = [];
      const fs: JsonlFileSinkFs = {
        open: (path, flags) => {
          calls.push('open');
          return real.open(path, flags);
        },
        mkdir: (path, options) => {
          calls.push('mkdir');
          return real.mkdir(path, options);
        },
        readFile: (path, encoding) => {
          calls.push('readFile');
          return real.readFile(path, encoding);
        },
        stat: (path) => {
          calls.push('stat');
          return real.stat(path);
        },
        unlink: (path) => {
          calls.push('unlink');
          return real.unlink(path);
        },
      };
      const path = join(dir, 'events.jsonl');
      const sink = new JsonlFileSink(path, fs);
      await sink.append([event(0)]);
      await sink.exists();
      await sink.acquireLock();
      await sink.releaseLock();
      expect(calls).toEqual(expect.arrayContaining(['mkdir', 'open', 'stat', 'unlink']));
    });
  });
});
