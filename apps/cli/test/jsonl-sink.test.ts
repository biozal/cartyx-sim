import { spawnSync } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimEvent } from '@cartyx-sim/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFileSink, releaseHeldLocks, type JsonlFileSinkFs } from '../src/jsonl-sink';

function notFound(): Error {
  return Object.assign(new Error('not found'), { code: 'ENOENT' });
}

/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.pid === undefined) throw new Error('could not spawn a process');
  return child.pid;
}

/** A fake filesystem that records call order/counts and lets one test script the file handle. */
function fakeFs(handle: {
  appendFile: (content: string) => Promise<void>;
  sync: () => Promise<void>;
  close: () => Promise<void>;
}): { fs: JsonlFileSinkFs; calls: string[] } {
  const calls: string[] = [];
  const fs: JsonlFileSinkFs = {
    open: async () => {
      calls.push('open');
      return {
        appendFile: async (content: string) => {
          calls.push('appendFile');
          await handle.appendFile(content);
        },
        sync: async () => {
          calls.push('sync');
          await handle.sync();
        },
        close: async () => {
          calls.push('close');
          await handle.close();
        },
      } as unknown as FileHandle;
    },
    mkdir: async () => undefined,
    readFile: async () => {
      throw notFound();
    },
    stat: async () => {
      throw notFound();
    },
    unlink: async () => {},
  };
  return { fs, calls };
}

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

    it('M2: readAll rejects a log whose seqs skip a number, naming the file and line', async () => {
      const path = join(dir, 'events.jsonl');
      const lines = [event(0), event(1), event(3)].map((e) => JSON.stringify(e));
      await writeFile(path, `${lines.join('\n')}\n`);
      await expect(new JsonlFileSink(path).readAll()).rejects.toThrow(
        `${path}:3: expected seq 2 but got 3`
      );
    });

    it('M2: readAll rejects a log that does not start at seq 0', async () => {
      const path = join(dir, 'events.jsonl');
      await writeFile(path, `\n${JSON.stringify(event(1))}\n`);
      await expect(new JsonlFileSink(path).readAll()).rejects.toThrow(
        `${path}:2: expected seq 0 but got 1`
      );
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

    it('F6: replaces a lock whose pid is no longer running and returns that pid', async () => {
      const path = join(dir, 'events.jsonl');
      const pid = deadPid();
      await writeFile(`${path}.lock`, `${pid} 2026-09-13T12:00:00.000Z\n`);

      await expect(new JsonlFileSink(path).acquireLock()).resolves.toBe(pid);

      const content = await readFile(`${path}.lock`, 'utf8');
      expect(content).toMatch(new RegExp(`^${process.pid} `));
    });

    it('F6: refuses a lock held by a live pid and leaves it in place', async () => {
      const path = join(dir, 'events.jsonl');
      const content = `${process.pid} 2026-09-13T12:00:00.000Z\n`;
      await writeFile(`${path}.lock`, content);

      await expect(new JsonlFileSink(path).acquireLock()).rejects.toThrow(
        new RegExp(`held by process ${process.pid}: another run may be active`)
      );

      expect(await readFile(`${path}.lock`, 'utf8')).toBe(content);
    });

    it('F6: refuses a lock file with no readable pid rather than guessing it is stale', async () => {
      const path = join(dir, 'events.jsonl');
      await writeFile(`${path}.lock`, 'not a pid\n');
      await expect(new JsonlFileSink(path).acquireLock()).rejects.toThrow(
        /another run may be active/i
      );
      expect(await readFile(`${path}.lock`, 'utf8')).toBe('not a pid\n');
    });

    it('F6: releaseHeldLocks releases every lock this process still holds', async () => {
      const first = new JsonlFileSink(join(dir, 'a', 'events.jsonl'));
      const second = new JsonlFileSink(join(dir, 'b', 'events.jsonl'));
      const released = new JsonlFileSink(join(dir, 'c', 'events.jsonl'));
      await first.acquireLock();
      await second.acquireLock();
      await released.acquireLock();
      await released.releaseLock();

      await releaseHeldLocks();

      for (const sink of [first, second, released]) {
        await expect(stat(`${sink.path}.lock`)).rejects.toThrow();
      }
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

  describe('G5.1: append durability', () => {
    it('opens the file once, appends every event in one call, syncs once, and closes the handle', async () => {
      let written = '';
      const { fs, calls } = fakeFs({
        appendFile: async (content) => {
          written = content;
        },
        sync: async () => {},
        close: async () => {},
      });
      const sink = new JsonlFileSink(join(dir, 'events.jsonl'), fs);

      await sink.append([event(0), event(1), event(2)]);

      expect(calls.filter((c) => c === 'open')).toHaveLength(1);
      expect(calls.filter((c) => c === 'appendFile')).toHaveLength(1);
      expect(calls.filter((c) => c === 'sync')).toHaveLength(1);
      expect(calls.filter((c) => c === 'close')).toHaveLength(1);
      expect(
        written
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line).seq)
      ).toEqual([0, 1, 2]);
    });

    it('still closes the handle and propagates the error when appendFile rejects', async () => {
      const { fs, calls } = fakeFs({
        appendFile: async () => {
          throw new Error('disk full');
        },
        sync: async () => {},
        close: async () => {},
      });
      const sink = new JsonlFileSink(join(dir, 'events.jsonl'), fs);

      await expect(sink.append([event(0)])).rejects.toThrow('disk full');

      expect(calls.filter((c) => c === 'appendFile')).toHaveLength(1);
      expect(calls).not.toContain('sync');
      expect(calls.filter((c) => c === 'close')).toHaveLength(1);
    });
  });
});
