import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFileSink } from '../src/jsonl-sink';
import { sessionEventsPath } from '../src/paths';
import { runSession, type RunOptions } from '../src/run';

const FIXTURE = fileURLToPath(new URL('../fixtures/demo-session.json', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.pid === undefined) throw new Error('could not spawn a process');
  return child.pid;
}

async function writeLock(eventsPath: string, pid: number): Promise<string> {
  const lockPath = `${eventsPath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${pid} 2026-09-13T12:00:00.000Z\n`);
  return lockPath;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('runSession', () => {
  let dir: string;
  let options: RunOptions;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cartyx-sim-run-'));
    options = {
      campaignsDir: dir,
      campaign: 'demo',
      session: 1,
      fixturePath: FIXTURE,
      resume: false,
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('plays the fixture to the end and writes a valid event log', async () => {
    const lines: string[] = [];
    const result = await runSession({ ...options, log: (line) => lines.push(line) });

    expect(result.status).toBe('ended');
    expect(result.eventsPath).toBe(join(dir, 'demo', 'sessions', '001', 'events.jsonl'));
    const events = await new JsonlFileSink(result.eventsPath).readAll();
    expect(events.map((e) => e.type)).toEqual([
      'session_start',
      'scene_change',
      'narration',
      'hand_off',
      'turn_end',
      'dialogue',
      'turn_end',
      'narration',
      'scene_change',
      'hand_off',
      'turn_end',
      'session_end',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'session_end', reason: 'target_reached' });
    expect(lines).toEqual([
      '[scene] Avalon Artificers Academy — Crystal Engine Lab',
      'DM: The lab lights flicker as you arrive.',
      'Kira Vale: "Who turned off the wards?"',
      'DM: A shadow slips out the east door, leaving frost behind.',
      '[scene] Avalon Artificers Academy — East Corridor',
    ]);
  });

  it('refuses to overwrite an existing session without resume', async () => {
    await runSession(options);
    await expect(runSession(options)).rejects.toThrow('already exists. Pass --resume');
  });

  it('refuses to resume a session that already ended', async () => {
    await runSession(options);
    await expect(runSession({ ...options, resume: true })).rejects.toThrow(
      'Session 1 has already ended'
    );
  });

  it('rejects unsafe campaign ids', async () => {
    await expect(runSession({ ...options, campaign: '../escape' })).rejects.toThrow(
      'must be lowercase letters, digits, and dashes'
    );
  });

  describe('locking', () => {
    it('refuses a concurrent run while the lock is held, leaving the log untouched', async () => {
      const eventsPath = sessionEventsPath(dir, 'demo', 1);
      const holder = new JsonlFileSink(eventsPath);
      await holder.acquireLock();
      try {
        await expect(runSession(options)).rejects.toThrow(/another run may be active/i);
        expect(await holder.readAll()).toEqual([]);
      } finally {
        await holder.releaseLock();
      }
    });

    it('releases the lock once a run completes', async () => {
      await runSession(options);
      const lockPath = `${sessionEventsPath(dir, 'demo', 1)}.lock`;
      await expect(stat(lockPath)).rejects.toThrow();
    });

    it('releases the lock even when Director.create throws', async () => {
      await runSession(options);
      await expect(runSession({ ...options, resume: true })).rejects.toThrow('already ended');
      const lockPath = `${sessionEventsPath(dir, 'demo', 1)}.lock`;
      await expect(stat(lockPath)).rejects.toThrow();
    });

    it('F6: replaces a stale lock left by a dead process, says so, and runs', async () => {
      const pid = deadPid();
      const lockPath = await writeLock(sessionEventsPath(dir, 'demo', 1), pid);
      const lines: string[] = [];

      const result = await runSession({ ...options, log: (line) => lines.push(line) });

      expect(result.status).toBe('ended');
      expect(lines[0]).toBe(
        `Replaced a stale lock from process ${pid}, which is no longer running: ${lockPath}`
      );
      await expect(stat(lockPath)).rejects.toThrow();
    });

    it('F6: refuses a lock held by a live process and leaves that lock alone', async () => {
      const eventsPath = sessionEventsPath(dir, 'demo', 1);
      const lockPath = await writeLock(eventsPath, process.pid);

      await expect(runSession(options)).rejects.toThrow(/another run may be active/i);

      expect(await readFile(lockPath, 'utf8')).toContain(String(process.pid));
      expect(await new JsonlFileSink(eventsPath).exists()).toBe(false);
    });

    it('F6: checks for an existing log only under the lock', async () => {
      await runSession(options);
      await writeLock(sessionEventsPath(dir, 'demo', 1), process.pid);

      await expect(runSession(options)).rejects.toThrow(/another run may be active/i);
    });

    it('F6: Ctrl-C releases the lock and exits with code 130', async () => {
      const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'));
      // A DM seat that keeps failing holds the run in its retry delays, lock taken.
      fixture.script = { dm: [{ throw: 'endpoint down' }] };
      const fixturePath = join(dir, 'down.json');
      await writeFile(fixturePath, JSON.stringify(fixture));
      const lockPath = `${sessionEventsPath(dir, 'demo', 1)}.lock`;
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'apps/cli/src/main.ts',
          'run',
          '--campaign',
          'demo',
          '--fixture',
          fixturePath,
          '--campaigns-dir',
          dir,
        ],
        { cwd: ROOT, stdio: 'ignore' }
      );
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));

      try {
        await waitFor(
          () =>
            stat(lockPath).then(
              () => true,
              () => false
            ),
          10_000
        );
        child.kill('SIGINT');
        expect(await exited).toBe(130);
      } finally {
        child.kill('SIGKILL');
      }
      await expect(stat(lockPath)).rejects.toThrow();
    }, 20_000);
  });
});
