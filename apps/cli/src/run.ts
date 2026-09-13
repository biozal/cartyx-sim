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
import { OpenAICompatibleModelClient } from '@cartyx-sim/models';
import { scriptedRng, secureRng, seededRng, type Rng } from '@cartyx-sim/rules';
import { loadCampaign } from './campaign';
import { loadFixture } from './fixture';
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

async function campaignSetup(options: RunOptions): Promise<SessionSetup> {
  const campaign = await loadCampaign(options.campaignsDir, options.campaign);
  return {
    config: {
      session: options.session,
      targetMinutes: options.targetMinutes ?? campaign.targetMinutes,
      loreCommit: campaign.loreCommit,
      party: campaign.party,
      seats: campaign.seats,
    },
    model: new OpenAICompatibleModelClient(campaign.models),
    // No lore yet: every lookup reports a gap. Plan 2B replaces this with the cartyx-lore index.
    lore: new StaticLoreIndex([]),
    rng: rngFor(options.seed),
  };
}

export async function runSession(options: RunOptions): Promise<RunSessionResult> {
  // Load and validate everything before taking the lock, so a config error leaves nothing behind.
  const setup = options.fixturePath
    ? await fixtureSetup(options, options.fixturePath)
    : await campaignSetup(options);
  const eventsPath = sessionEventsPath(options.campaignsDir, options.campaign, options.session);
  const sink = new JsonlFileSink(eventsPath);
  const log = options.log ?? (() => {});

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
}
