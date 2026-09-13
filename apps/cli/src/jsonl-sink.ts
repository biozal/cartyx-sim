import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SimEvent, type EventSink } from '@cartyx-sim/core';

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Append-only JSON Lines event log. Each turn is written with one append and an fsync. */
export class JsonlFileSink implements EventSink {
  constructor(readonly path: string) {}

  async exists(): Promise<boolean> {
    try {
      await stat(this.path);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async readAll(): Promise<SimEvent[]> {
    let content: string;
    try {
      content = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    return content
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.trim() !== '')
      .map(({ line, number }) => {
        try {
          return SimEvent.parse(JSON.parse(line));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`${this.path}:${number}: invalid event (${reason})`);
        }
      });
  }

  async append(events: readonly SimEvent[]): Promise<void> {
    if (events.length === 0) return;
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, 'a');
    try {
      await handle.appendFile(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
