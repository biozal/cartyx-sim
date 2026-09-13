import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SimEvent, type EventSink } from '@cartyx-sim/core';

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/**
 * The subset of `node:fs/promises` the sink needs, injectable so its durability is testable
 * (see Group 5). Narrowed to the exact call shapes used below, rather than the fully overloaded
 * `typeof fs.mkdir` etc., so a plain wrapper function is assignable without matching every overload.
 */
export interface JsonlFileSinkFs {
  open: (path: string, flags: string) => Promise<FileHandle>;
  mkdir: (path: string, options: { recursive: true }) => Promise<string | undefined>;
  readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  stat: (path: string) => Promise<{ isFile(): boolean }>;
  unlink: (path: string) => Promise<void>;
}

const defaultFs: JsonlFileSinkFs = { open, mkdir, readFile, stat, unlink };

/**
 * Append-only JSON Lines event log. Each turn is written with one append and an fsync.
 *
 * `acquireLock`/`releaseLock` guard against two processes running the same session at once, and
 * `append` refuses to write a turn whose first event does not continue the seq already on disk,
 * so a lost lock or a stale sink can never interleave or gap the log.
 */
export class JsonlFileSink implements EventSink {
  private readonly fs: JsonlFileSinkFs;
  private readonly lockPath: string;
  private lastSeq: number | undefined;

  constructor(
    readonly path: string,
    fs: Partial<JsonlFileSinkFs> = {}
  ) {
    this.fs = { ...defaultFs, ...fs };
    this.lockPath = `${this.path}.lock`;
  }

  async exists(): Promise<boolean> {
    try {
      await this.fs.stat(this.path);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async readAll(): Promise<SimEvent[]> {
    let content: string;
    try {
      content = await this.fs.readFile(this.path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        this.lastSeq = -1;
        return [];
      }
      throw error;
    }
    const events = content
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
    this.lastSeq = events.at(-1)?.seq ?? -1;
    return events;
  }

  async append(events: readonly SimEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (this.lastSeq === undefined) await this.readAll();
    const expected = this.lastSeq! + 1;
    const first = events[0]!;
    if (first.seq !== expected) {
      throw new Error(
        `${this.path}: expected seq ${expected} next but got ${first.seq}. Refusing to write a ` +
          'gap or overlap in the log.'
      );
    }
    await this.fs.mkdir(dirname(this.path), { recursive: true });
    const handle = await this.fs.open(this.path, 'a');
    try {
      await handle.appendFile(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.lastSeq = events.at(-1)!.seq;
  }

  /**
   * Claims an exclusive lock on this session so a second concurrent run is refused instead of
   * interleaving into the log. Throws if the lock is already held; delete the lock file to clear
   * a stale one left behind by a crashed run.
   */
  async acquireLock(): Promise<void> {
    await this.fs.mkdir(dirname(this.path), { recursive: true });
    let handle;
    try {
      handle = await this.fs.open(this.lockPath, 'wx');
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new Error(
          `${this.lockPath} already exists: another run may be active on this session. If it is ` +
            'stale (the process that created it is gone), delete the lock file and retry.'
        );
      }
      throw error;
    }
    try {
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
    } finally {
      await handle.close();
    }
  }

  async releaseLock(): Promise<void> {
    try {
      await this.fs.unlink(this.lockPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}
