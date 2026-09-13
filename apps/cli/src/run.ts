import { basicPrompts, describeEvent, Director, type RunResult } from '@cartyx-sim/core';
import { ScriptedModelClient, StaticLoreIndex } from '@cartyx-sim/core/testing';
import { scriptedRng, secureRng, seededRng, type Rng } from '@cartyx-sim/rules';
import { loadFixture, type Fixture } from './fixture';
import { JsonlFileSink } from './jsonl-sink';
import { sessionEventsPath } from './paths';

export interface RunOptions {
  campaignsDir: string;
  campaign: string;
  session: number;
  fixturePath: string;
  targetMinutes?: number;
  seed?: number;
  resume: boolean;
  log?: (line: string) => void;
}

export type RunSessionResult = RunResult & { eventsPath: string };

function pickRng(fixture: Fixture, seed: number | undefined): Rng {
  if (fixture.dice) return scriptedRng(fixture.dice);
  return seed === undefined ? secureRng() : seededRng(seed);
}

export async function runSession(options: RunOptions): Promise<RunSessionResult> {
  const fixture = await loadFixture(options.fixturePath);
  const eventsPath = sessionEventsPath(options.campaignsDir, options.campaign, options.session);
  const sink = new JsonlFileSink(eventsPath);
  if (!options.resume && (await sink.exists())) {
    throw new Error(`${eventsPath} already exists. Pass --resume to continue that session.`);
  }
  const log = options.log ?? (() => {});

  const director = await Director.create(
    {
      session: options.session,
      targetMinutes: options.targetMinutes ?? fixture.targetMinutes,
      loreCommit: fixture.loreCommit,
      party: fixture.party,
      seats: fixture.seats,
    },
    {
      model: new ScriptedModelClient(fixture.script),
      lore: new StaticLoreIndex(fixture.lore),
      rng: pickRng(fixture, options.seed),
      sink,
      prompts: basicPrompts,
      onCommit: (events, state) => {
        for (const event of events) {
          if (event.visibility !== 'public') continue;
          const line = describeEvent(event, state);
          if (line) log(line);
        }
      },
    }
  );
  const result = await director.run();
  return { ...result, eventsPath };
}
