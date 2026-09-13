import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimEvent } from '@cartyx-sim/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFileSink } from '../src/jsonl-sink';

const event = (seq: number): SimEvent =>
  SimEvent.parse({
    seq,
    ts: '2026-09-13T12:00:00.000Z',
    turnId: `turn-${seq}`,
    visibility: 'dm',
    type: 'ooc_note',
    text: `note ${seq}`,
  });

describe('JsonlFileSink torn writes', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cartyx-sim-torn-'));
    path = join(dir, 'events.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('ignores an unterminated, unparseable final line and removes it on the next append', async () => {
    const whole = `${JSON.stringify(event(0))}\n`;
    await writeFile(path, `${whole}{"seq":1,"ts":"2026-09-13T12:0`);
    const sink = new JsonlFileSink(path);

    expect(await sink.readAll()).toEqual([event(0)]);
    expect(sink.tornTail).toEqual({ line: 2, text: '{"seq":1,"ts":"2026-09-13T12:0' });

    await sink.append([event(1)]);
    expect(await readFile(path, 'utf8')).toBe(`${whole}${JSON.stringify(event(1))}\n`);
    expect(sink.tornTail).toBeUndefined();
    expect(await new JsonlFileSink(path).readAll()).toEqual([event(0), event(1)]);
  });

  it('keeps a valid final event that lacks its newline and appends after it cleanly', async () => {
    await writeFile(path, JSON.stringify(event(0)));
    const sink = new JsonlFileSink(path);

    expect(await sink.readAll()).toEqual([event(0)]);
    expect(sink.tornTail).toBeUndefined();

    await sink.append([event(1)]);
    expect(await new JsonlFileSink(path).readAll()).toEqual([event(0), event(1)]);
  });

  it('still rejects a corrupt line that is not the unterminated tail', async () => {
    await writeFile(path, `{"seq":0,"ts\n${JSON.stringify(event(1))}\n`);
    await expect(new JsonlFileSink(path).readAll()).rejects.toThrow(`${path}:1: invalid event`);
  });

  it('still rejects a corrupt final line that was fully terminated', async () => {
    await writeFile(path, `${JSON.stringify(event(0))}\n{"seq":1,"ts\n`);
    await expect(new JsonlFileSink(path).readAll()).rejects.toThrow(`${path}:2: invalid event`);
  });
});
