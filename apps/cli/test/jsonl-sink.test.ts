import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimEvent } from '@cartyx-sim/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFileSink } from '../src/jsonl-sink';

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
});
