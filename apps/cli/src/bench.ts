import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { benchSeat, type BenchResult } from '@cartyx-sim/models';
import { loadCampaign } from './campaign';

export interface BenchOptions {
  campaignsDir: string;
  campaign: string;
  /** Tool-call trials per seat. Default 5. */
  trials?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface BenchReport {
  results: BenchResult[];
  reportPath: string;
}

/** Whether every seat is reachable and made every tool call correctly. */
export function benchPassed(results: readonly BenchResult[]): boolean {
  return results.every(
    (result) => result.reachable && result.toolCallSuccesses === result.toolCallTrials
  );
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
    `${result.toolCallSuccesses}/${result.toolCallTrials}`,
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

/** Benchmarks every seat in a campaign, prints a table, and saves a JSON report under bench/. */
export async function runBench(options: BenchOptions): Promise<BenchReport> {
  const campaign = await loadCampaign(options.campaignsDir, options.campaign);
  const log = options.log ?? (() => {});
  const results: BenchResult[] = [];
  for (const [seat, model] of Object.entries(campaign.models)) {
    log(`Benchmarking ${seat} (${model.model} at ${model.endpoint.baseURL})...`);
    results.push(await benchSeat(seat, model, { trials: options.trials }));
  }
  for (const line of formatBenchTable(results)) log(line);

  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const dir = join(campaign.dir, 'bench');
  await mkdir(dir, { recursive: true });
  const reportPath = join(dir, `${createdAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(
    reportPath,
    `${JSON.stringify({ campaign: campaign.id, createdAt, results }, null, 2)}\n`
  );
  return { results, reportPath };
}
