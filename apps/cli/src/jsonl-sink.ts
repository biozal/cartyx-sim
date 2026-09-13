import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readFile, stat, truncate, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SimEvent, type EventSink } from '@cartyx-sim/core';

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/** Whether `pid` is a running process on this machine. EPERM means it exists but is not ours. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

/** The pid a lock file starts with, or undefined if it has none (0 and below are not pids). */
function lockPid(content: string): number | undefined {
  const match = /^\s*(\d+)(?!\S)/.exec(content);
  const pid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
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
  stat: (path: string) => Promise<unknown>;
  unlink: (path: string) => Promise<void>;
  truncate: (path: string, length: number) => Promise<void>;
}

const defaultFs: JsonlFileSinkFs = { open, mkdir, readFile, stat, unlink, truncate };

/** Sinks holding a session lock in this process, so a signal handler can release them. */
const heldLocks = new Set<JsonlFileSink>();

/**
 * Releases every session lock this process still holds. For signal handlers: a SIGINT or SIGTERM
 * exit skips `finally` blocks, which would otherwise leave the lock behind.
 */
export async function releaseHeldLocks(): Promise<void> {
  await Promise.allSettled([...heldLocks].map((sink) => sink.releaseLock()));
}

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
  /** How to make the file end cleanly before the next append, when `readAll` found it did not. */
  private repair: { truncateTo: number } | { appendNewline: true } | undefined;
  /**
   * Set by `readAll` when the log ended in an unterminated line that is not a valid event: the
   * remains of a write cut off by a crash or power loss. The line is ignored on read and removed
   * before the next append.
   */
  tornTail: { line: number; text: string } | undefined;

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
    const events: SimEvent[] = [];
    const lines = content.split('\n');
    const terminated = content === '' || content.endsWith('\n');
    this.tornTail = undefined;
    this.repair = undefined;
    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') continue;
      const number = index + 1;
      let event: SimEvent;
      try {
        event = SimEvent.parse(JSON.parse(line));
      } catch (error) {
        // Only an unterminated final line can be a torn write; anything else is corruption.
        if (!terminated && index === lines.length - 1) {
          this.tornTail = { line: number, text: line };
          this.repair = { truncateTo: Buffer.byteLength(content) - Buffer.byteLength(line) };
          break;
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${this.path}:${number}: invalid event (${reason})`);
      }
      // The same rule `append` enforces: seqs count up from 0 with no gap or overlap.
      if (event.seq !== events.length) {
        throw new Error(
          `${this.path}:${number}: expected seq ${events.length} but got ${event.seq}. The log ` +
            'has a gap or overlap.'
        );
      }
      events.push(event);
    }
    if (!terminated && !this.tornTail) this.repair = { appendNewline: true };
    this.lastSeq = events.length - 1;
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
    if (this.repair && 'truncateTo' in this.repair) {
      await this.fs.truncate(this.path, this.repair.truncateTo);
    }
    const separator = this.repair && 'appendNewline' in this.repair ? '\n' : '';
    const handle = await this.fs.open(this.path, 'a');
    try {
      await handle.appendFile(
        `${separator}${events.map((event) => JSON.stringify(event)).join('\n')}\n`
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.repair = undefined;
    this.tornTail = undefined;
    this.lastSeq = events.at(-1)!.seq;
  }

  /**
   * Claims an exclusive lock on this session so a second concurrent run is refused instead of
   * interleaving into the log. A lock whose recorded pid is not a running process on this machine
   * is stale (its run crashed or was killed): it is replaced, and its pid is returned so the
   * caller can say so. Otherwise returns undefined. Throws if a live process holds the lock, or if
   * the lock file has no readable pid.
   */
  async acquireLock(): Promise<number | undefined> {
    await this.fs.mkdir(dirname(this.path), { recursive: true });
    let replacedPid: number | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle: FileHandle;
      try {
        handle = await this.fs.open(this.lockPath, 'wx');
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const content = await this.readLock();
        // Released between the open and the read: try again.
        if (content === undefined) continue;
        const pid = lockPid(content);
        if (attempt > 0 || pid === undefined || isProcessAlive(pid)) throw this.lockHeld(pid);
        // Only remove the lock if it still names the dead process, so a live run that replaced
        // it in the meantime keeps its lock.
        if ((await this.readLock()) === content) await this.removeLock();
        replacedPid = pid;
        continue;
      }
      // Tracked as soon as the file exists, so a signal while writing it still releases it.
      heldLocks.add(this);
      try {
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      } finally {
        await handle.close();
      }
      return replacedPid;
    }
    throw this.lockHeld(undefined);
  }

  async releaseLock(): Promise<void> {
    heldLocks.delete(this);
    await this.removeLock();
  }

  private async readLock(): Promise<string | undefined> {
    try {
      return await this.fs.readFile(this.lockPath, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private async removeLock(): Promise<void> {
    try {
      await this.fs.unlink(this.lockPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private lockHeld(pid: number | undefined): Error {
    const holder = pid === undefined ? '' : ` is held by process ${pid}`;
    return new Error(
      `${this.lockPath}${holder || ' already exists'}: another run may be active on this ` +
        'session. If that process is gone, delete the lock file and retry.'
    );
  }
}
