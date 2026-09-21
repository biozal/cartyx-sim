import { readFile } from 'node:fs/promises';
import {
  basicPrompts,
  describeEvent,
  Director,
  type DirectorConfig,
  type LoreIndex,
  type ModelClient,
  type RunResult,
} from '@cartyx-sim/core';
import { ScriptedModelClient, StaticLoreIndex } from '@cartyx-sim/core/testing';
import { openIndex, readMeta, type Embedder } from '@cartyx-sim/lore';
import { OpenAICompatibleModelClient } from '@cartyx-sim/models';
import { scriptedRng, secureRng, seededRng, type Rng } from '@cartyx-sim/rules';
import { loadCampaign } from './campaign';
import { loadFixture } from './fixture';
import { currentIdentity, embedderFor, ensureIndex, loreIndexDir } from './index-lore';
import { JsonlFileSink } from './jsonl-sink';
import { sessionEventsPath } from './paths';

export interface RunOptions {
  campaignsDir: string;
  campaign: string;
  session: number;
  /** Plays a scripted fixture instead of the campaign's configured model seats. */
  fixturePath?: string;
  targetMinutes?: number;
  seed?: number;
  resume: boolean;
  log?: (line: string) => void;
  /** Injected by tests; production builds one from the campaign's embed seat. */
  embedder?: Embedder;
}

export type RunSessionResult = RunResult & { eventsPath: string };

interface SessionSetup {
  config: DirectorConfig;
  model: ModelClient;
  lore: LoreIndex;
  rng: Rng;
}

function rngFor(seed: number | undefined): Rng {
  return seed === undefined ? secureRng() : seededRng(seed);
}

async function fixtureSetup(options: RunOptions, fixturePath: string): Promise<SessionSetup> {
  const fixture = await loadFixture(fixturePath);
  return {
    config: {
      session: options.session,
      targetMinutes: options.targetMinutes ?? fixture.targetMinutes,
      loreCommit: fixture.loreCommit,
      party: fixture.party,
      seats: fixture.seats,
    },
    model: new ScriptedModelClient(fixture.script),
    lore: new StaticLoreIndex(fixture.lore),
    rng: fixture.dice ? scriptedRng(fixture.dice) : rngFor(options.seed),
  };
}

/** The lore commit stamped on a session's `session_start`, or undefined if the log has none. */
async function loggedLoreCommit(eventsPath: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(eventsPath, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const event = JSON.parse(line) as { type?: string; loreCommit?: string };
      if (event.type === 'session_start') return event.loreCommit;
    } catch {
      // A torn final line is recovered elsewhere; here it simply is not a session_start.
    }
  }
  return undefined;
}

async function campaignSetup(options: RunOptions): Promise<SessionSetup> {
  const campaign = await loadCampaign(options.campaignsDir, options.campaign);
  if (!campaign.lorePath) {
    return {
      config: {
        session: options.session,
        targetMinutes: options.targetMinutes ?? campaign.targetMinutes,
        loreCommit: campaign.loreCommit,
        party: campaign.party,
        seats: campaign.seats,
      },
      model: new OpenAICompatibleModelClient(campaign.models),
      // A campaign with no lorePath plays with no lore: every lookup reports a gap.
      lore: new StaticLoreIndex([]),
      rng: rngFor(options.seed),
    };
  }

  const embedder = options.embedder ?? embedderFor(campaign);
  const indexDir = loreIndexDir(campaign);

  if (options.resume) {
    // A resume never rebuilds: the logged commit is the lore that session is playing, and
    // re-indexing mid-story would change the world underneath it. The director's own check
    // compares the configured commit against the logged one; this makes the message specific.
    const meta = await readMeta(indexDir);
    const logged = await loggedLoreCommit(
      sessionEventsPath(options.campaignsDir, options.campaign, options.session)
    );
    if (!meta) {
      throw new Error(
        `No lore index at ${indexDir}, and session ${options.session} was played against lore ` +
          `${logged ?? 'of an unrecorded version'}. Restore that lore commit and run \`sim index\`.`
      );
    }
    if (logged !== undefined) {
      // Compares against the actual lore repo too, not only the frozen index: a lore file edited
      // in place after the session started is a real drift even though it hasn't been reindexed
      // yet, and `ensureIndex` must never be called here to find that out.
      const { loreCommit: current } = await currentIdentity(campaign, embedder, meta.dims);
      const mismatch: { source: string; value: string } | undefined =
        meta.loreCommit !== logged
          ? { source: 'the on-disk index', value: meta.loreCommit }
          : current !== logged
            ? { source: 'the lore repository', value: current }
            : undefined;
      if (mismatch) {
        throw new Error(
          `The lore has changed since session ${options.session} started: the log records ` +
            `${logged}, but ${mismatch.source} is now at ${mismatch.value}. Restore that lore ` +
            `commit and run \`sim index\` before resuming.`
        );
      }
    }
    const lore = await openIndex(indexDir, embedder);
    return {
      config: {
        session: options.session,
        targetMinutes: options.targetMinutes ?? campaign.targetMinutes,
        loreCommit: meta.loreCommit,
        party: campaign.party,
        seats: campaign.seats,
      },
      model: new OpenAICompatibleModelClient(campaign.models),
      lore,
      rng: rngFor(options.seed),
    };
  }

  const index = await ensureIndex({
    campaignsDir: options.campaignsDir,
    campaign: options.campaign,
    embedder,
    log: options.log,
  });
  if (index.rebuilt) options.log?.(`Rebuilt the lore index: ${index.indexDir}`);
  const lore = await openIndex(index.indexDir, embedder);
  return {
    config: {
      session: options.session,
      targetMinutes: options.targetMinutes ?? campaign.targetMinutes,
      loreCommit: index.meta!.loreCommit,
      party: campaign.party,
      seats: campaign.seats,
    },
    model: new OpenAICompatibleModelClient(campaign.models),
    lore,
    rng: rngFor(options.seed),
  };
}

/** Closes a `LoreIndex` if it holds a real handle (`StaticLoreIndex` doesn't; the real,
 * LanceDB-backed one does), so a session never leaks an open database connection. */
async function closeLore(lore: LoreIndex): Promise<void> {
  if ('close' in lore && typeof lore.close === 'function') {
    await (lore as { close(): Promise<void> }).close();
  }
}

export async function runSession(options: RunOptions): Promise<RunSessionResult> {
  // Load and validate everything before taking the lock, so a config error leaves nothing behind.
  const setup = options.fixturePath
    ? await fixtureSetup(options, options.fixturePath)
    : await campaignSetup(options);
  const eventsPath = sessionEventsPath(options.campaignsDir, options.campaign, options.session);
  const sink = new JsonlFileSink(eventsPath);
  const log = options.log ?? (() => {});

  // The lore index is closed here, outside the lock's own try/finally: `acquireLock` genuinely
  // throws when another live process already holds this session's lock, and that must not leak
  // the LanceDB connection `campaignSetup`/`fixtureSetup` already opened above.
  try {
    const stalePid = await sink.acquireLock();
    if (stalePid !== undefined) {
      log(
        `Replaced a stale lock from process ${stalePid}, which is no longer running: ${eventsPath}.lock`
      );
    }
    try {
      // Checked under the lock, so a concurrent run cannot create the log between check and use.
      if (!options.resume && (await sink.exists())) {
        throw new Error(`${eventsPath} already exists. Pass --resume to continue that session.`);
      }
      const director = await Director.create(setup.config, {
        model: setup.model,
        lore: setup.lore,
        rng: setup.rng,
        sink,
        prompts: basicPrompts,
        onCommit: (events, state) => {
          for (const event of events) {
            if (event.visibility !== 'public') continue;
            const line = describeEvent(event, state);
            if (line) log(line);
          }
        },
      });
      if (sink.tornTail) {
        log(
          `Ignoring an incomplete final line (line ${sink.tornTail.line}) left by an interrupted ` +
            `write; it will be removed on the next write: ${eventsPath}`
        );
      }
      const result = await director.run();
      return { ...result, eventsPath };
    } finally {
      await sink.releaseLock();
    }
  } finally {
    await closeLore(setup.lore);
  }
}
