import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFileSink } from '../src/jsonl-sink';
import { sessionEventsPath } from '../src/paths';
import { runSession, type RunOptions } from '../src/run';

const FIXTURE = fileURLToPath(new URL('../fixtures/demo-session.json', import.meta.url));

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
  });
});
