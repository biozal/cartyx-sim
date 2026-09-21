import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { benchSeat, type BenchResult } from '@cartyx-sim/models';
import type { Embedder } from '@cartyx-sim/lore';
import { CHECKER_SEAT, EMBED_SEAT, loadCampaign, SCRIPT_SEAT } from './campaign';

export interface BenchOptions {
  campaignsDir: string;
  campaign: string;
  /** Tool-call trials per seat. Default 5. */
  trials?: number;
  now?: () => Date;
  log?: (line: string) => void;
  /** Injected by tests; production builds one from the campaign's embed seat. */
  embedder?: Embedder;
}

export interface EmbedBenchResult {
  seat: string;
  model: string;
  reachable: boolean;
  dims: number | null;
  latencyMs: number | null;
  errors: string[];
}

export interface BenchReport {
  results: BenchResult[];
  embed?: EmbedBenchResult;
  reportPath: string;
}

/**
 * Whether every seat is reachable and every trial was usable: a well-formed tool call, or (for a
 * `toolChoice: auto` seat) a plain-text reply, which the engine accepts as narration or speech.
 */
export function benchPassed(results: readonly BenchResult[], embed?: EmbedBenchResult): boolean {
  const seatsPass = results.every(
    (result) =>
      result.reachable && result.toolCallSuccesses + result.textReplies === result.toolCallTrials
  );
  return seatsPass && (embed === undefined || embed.reachable);
}

export function formatBenchTable(results: readonly BenchResult[]): string[] {
  const header = ['seat', 'model', 'reachable', 'listed', 'tok/s', 'latency ms', 'tool calls'];
  const rows = results.map((result) => [
    result.seat,
    result.model,
    result.reachable ? 'yes' : 'NO',
    result.modelListed === null ? '?' : result.modelListed ? 'yes' : 'NO',
    result.tokensPerSecond === null ? '-' : String(result.tokensPerSecond),
    result.latencyMs === null ? '-' : String(result.latencyMs),
    `${result.toolCallSuccesses}/${result.toolCallTrials}` +
      (result.textReplies > 0 ? ` (+${result.textReplies} text)` : ''),
  ]);
  const widths = header.map((_, column) =>
    Math.max(...[header, ...rows].map((row) => row[column]!.length))
  );
  const lines = [header, ...rows].map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join('  ')
      .trimEnd()
  );
  for (const result of results) {
    for (const error of result.errors) lines.push(`  ${result.seat}: ${error}`);
  }
  return lines;
}

/**
 * One embedding call. A misconfigured embedding endpoint otherwise surfaces at the first
 * `lookup_lore`, a dozen minutes into a session.
 */
export async function benchEmbedSeat(embedder: Embedder): Promise<EmbedBenchResult> {
  const started = Date.now();
  try {
    const vector = await embedder.embedQuery('who teaches applied crystal engines');
    return {
      seat: EMBED_SEAT,
      model: embedder.model,
      reachable: true,
      dims: vector.length,
      latencyMs: Date.now() - started,
      errors: [],
    };
  } catch (error) {
    return {
      seat: EMBED_SEAT,
      model: embedder.model,
      reachable: false,
      dims: null,
      latencyMs: null,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function formatEmbedBench(result: EmbedBenchResult): string[] {
  const lines = [
    `${result.seat}  ${result.model}  ${result.reachable ? 'yes' : 'NO'}  ` +
      `${result.dims === null ? '-' : `${result.dims} dims`}  ` +
      `${result.latencyMs === null ? '-' : `${result.latencyMs} ms`}`,
  ];
  for (const error of result.errors) lines.push(`  ${result.seat}: ${error}`);
  return lines;
}

/** Benchmarks every seat in a campaign, prints a table, and saves a JSON report under bench/. */
export async function runBench(options: BenchOptions): Promise<BenchReport> {
  const campaign = await loadCampaign(options.campaignsDir, options.campaign);
  const log = options.log ?? (() => {});
  const results: BenchResult[] = [];
  for (const [seat, model] of Object.entries(campaign.models)) {
    // Skip the embed seat — it's benched separately via benchEmbedSeat.
    if (seat === EMBED_SEAT) continue;
    log(`Benchmarking ${seat} (${model.model} at ${model.endpoint.baseURL})...`);
    // The checker and script seats answer in JSON without tools, so they get no tool-call trials.
    const trials = seat === CHECKER_SEAT || seat === SCRIPT_SEAT ? 0 : options.trials;
    results.push(await benchSeat(seat, model, { trials }));
  }
  for (const line of formatBenchTable(results)) log(line);

  let embed: EmbedBenchResult | undefined;
  if (campaign.embedSeat) {
    log(`Benchmarking ${EMBED_SEAT}...`);
    const embedder = options.embedder ?? (await import('./index-lore')).embedderFor(campaign);
    embed = await benchEmbedSeat(embedder);
    for (const line of formatEmbedBench(embed)) log(line);
  }

  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const dir = join(campaign.dir, 'bench');
  await mkdir(dir, { recursive: true });
  const reportPath = join(dir, `${createdAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(
    reportPath,
    `${JSON.stringify({ campaign: campaign.id, createdAt, results, ...(embed && { embed }) }, null, 2)}\n`
  );
  return { results, embed, reportPath };
}
