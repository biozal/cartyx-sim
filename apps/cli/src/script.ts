import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SimEvent } from '@cartyx-sim/core';
import { OpenAICompatibleModelClient } from '@cartyx-sim/models';
import {
  buildScript,
  ModelLabeler,
  renderScriptMarkdown,
  SpeakerOverrides,
  type BuildStats,
  type Labeler,
  type Note,
} from '@cartyx-sim/script';
import { z } from 'zod';
import { writeFilesAtomic } from './atomic-write';
import { loadCampaign } from './campaign';
import { JsonlFileSink } from './jsonl-sink';
import { FileLabelCache } from './label-cache';
import { sessionDir } from './paths';

const WORDS_PER_MINUTE = 150;

export interface ScriptOptions {
  campaignsDir: string;
  campaign: string;
  session: number;
  /** Label quotes in narration with the campaign's script (or checker) seat. */
  useModel: boolean;
  /** Ignore cached model answers. */
  refresh: boolean;
  log?: (line: string) => void;
}

export interface ScriptResult {
  scriptPath: string;
  markdownPath: string;
  stats: BuildStats;
  notes: Note[];
  /** The seat that labeled quotes, when one was used. */
  labelSeat?: string;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function loadSpeakerOverrides(path: string): Promise<SpeakerOverrides | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : error})`);
  }
  const parsed = SpeakerOverrides.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${path}: invalid speaker overrides\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

async function campaignLabeler(
  options: ScriptOptions,
  dir: string,
  log: (line: string) => void
): Promise<{ labeler?: Labeler; seat?: string }> {
  const campaign = await loadCampaign(options.campaignsDir, options.campaign);
  const seat = campaign.scriptSeat;
  if (!seat) {
    log('No script or checker seat in campaign.json; attributing quotes by rules only.');
    return {};
  }
  const labeler = new ModelLabeler({
    model: new OpenAICompatibleModelClient(campaign.models),
    seat,
    modelId: campaign.models[seat]!.model,
    cache: new FileLabelCache(join(dir, '.script-cache')),
    refresh: options.refresh,
  });
  return { labeler, seat };
}

/**
 * Builds `script.json` and `script.md` for one session from its event log, which it never
 * modifies. Holds the session lock only while it reads and hashes the log, so it refuses to start
 * while the session is being played, but does not hold the lock while the (potentially slow)
 * labeling model runs or while the outputs are written.
 */
export async function makeScript(options: ScriptOptions): Promise<ScriptResult> {
  const log = options.log ?? (() => {});
  const dir = sessionDir(options.campaignsDir, options.campaign, options.session);
  const eventsPath = join(dir, 'events.jsonl');
  const sink = new JsonlFileSink(eventsPath);
  if (!(await sink.exists())) throw new Error(`No event log at ${eventsPath}.`);
  // Load everything that can fail on configuration before taking the lock.
  const labeling: { labeler?: Labeler; seat?: string } = options.useModel
    ? await campaignLabeler(options, dir, log)
    : {};
  if (options.refresh && !labeling.labeler) {
    log('--refresh has no effect: no model labels quotes in this run.');
  }
  const speakers = await loadSpeakerOverrides(join(dir, 'speakers.json'));

  const stalePid = await sink.acquireLock();
  if (stalePid !== undefined) {
    log(
      `Replaced a stale lock from process ${stalePid}, which is no longer running: ${eventsPath}.lock`
    );
  }
  let events: SimEvent[];
  let eventsSha256: string;
  try {
    events = await sink.readAll();
    if (sink.lastReadSha256 === undefined) throw new Error(`No event log at ${eventsPath}.`);
    eventsSha256 = sink.lastReadSha256;
    if (sink.tornTail) {
      log(
        `Ignoring an incomplete final line (line ${sink.tornTail.line}) left by an interrupted ` +
          `write: ${eventsPath}`
      );
    }
  } finally {
    await sink.releaseLock();
  }

  const { script, stats } = await buildScript({
    campaign: options.campaign,
    session: options.session,
    eventsSha256,
    events,
    labeler: labeling.labeler,
    speakers,
  });
  const scriptPath = join(dir, 'script.json');
  const markdownPath = join(dir, 'script.md');
  // script.json last, so its rename is the durable signal that both outputs are complete.
  await writeFilesAtomic([
    { path: markdownPath, content: renderScriptMarkdown(script) },
    { path: scriptPath, content: `${JSON.stringify(script, null, 2)}\n` },
  ]);
  return {
    scriptPath,
    markdownPath,
    stats,
    notes: script.notes,
    ...(labeling.seat ? { labelSeat: labeling.seat } : {}),
  };
}

/** The lines to print after `makeScript` finishes: counts by kind, labeling stats, and notes. */
export function formatScriptSummary(result: ScriptResult): string[] {
  const { stats } = result;
  const kinds = Object.entries(stats.lines)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(', ');
  const minutes = (stats.spokenWords / WORDS_PER_MINUTE).toFixed(1);
  const seat = result.labelSeat ? ` (seat "${result.labelSeat}")` : '';
  const lines = [
    `Lines: ${kinds || 'none'}`,
    `Spoken words: ${stats.spokenWords} (~${minutes} min)`,
    `Quote labels: model ${stats.labels.model}, cache ${stats.labels.cache}, rules ${stats.labels.fallback}${seat}`,
    `Stage directions dropped: ${stats.stageDirections}`,
    `Unlisted NPC speakers: ${stats.unlisted.join(', ') || 'none'}`,
  ];
  for (const note of result.notes) lines.push(`Note (event ${note.seq}): ${note.text}`);
  lines.push(`Script: ${result.scriptPath}`, `Book: ${result.markdownPath}`);
  return lines;
}
