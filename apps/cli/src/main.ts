import { Command } from 'commander';
import { parseNumber } from './args';
import { benchPassed, runBench } from './bench';
import { formatCommandError } from './command-errors';
import { releaseHeldLocks } from './jsonl-sink';
import { formatIndexSummary, runIndex } from './index-lore';
import { formatPauseMessage } from './pause-message';
import { runSession } from './run';
import { formatScriptSummary, makeScript } from './script';

// An exit by signal skips `finally`, so release any session lock first; otherwise the lock stays
// behind. Exit codes follow the shell convention of 128 + the signal number.
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;
for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
  process.once(signal, () => {
    console.error(`\nReceived ${signal}; releasing the session lock and exiting.`);
    void releaseHeldLocks().finally(() => process.exit(code));
  });
}

interface RunCommandOptions {
  campaign: string;
  fixture?: string;
  session: number;
  targetMinutes?: number;
  seed?: number;
  campaignsDir: string;
  resume: boolean;
}

interface BenchCommandOptions {
  campaign: string;
  trials: number;
  campaignsDir: string;
}

interface IndexCommandOptions {
  campaign: string;
  force: boolean;
  check: boolean;
  campaignsDir: string;
}

interface ScriptCommandOptions {
  campaign: string;
  session: number;
  /** False with --no-model. */
  model: boolean;
  refresh: boolean;
  campaignsDir: string;
}

/**
 * Wraps a command action so a thrown error becomes a clean message on stderr and exit code 1,
 * instead of commander's raw stack trace. Set `SIM_DEBUG=1` to print the stack instead.
 */
function action<T>(body: (options: T) => Promise<void>): (options: T) => Promise<void> {
  return async (options: T) => {
    try {
      await body(options);
    } catch (error) {
      console.error(formatCommandError(error, process.env.SIM_DEBUG === '1'));
      process.exitCode = 1;
    }
  };
}

const program = new Command().name('sim').description('Cartyx AI D&D session simulator');

program
  .command('run')
  .description("Simulate a session with the campaign's model seats and write its event log")
  .requiredOption('--campaign <id>', 'campaign id (a folder under the campaigns directory)')
  .option('--fixture <path>', 'play a scripted fixture instead of the configured model seats')
  .option('--session <n>', 'session number', parseNumber('integer'), 1)
  .option(
    '--target-minutes <n>',
    'target spoken minutes (overrides the campaign or fixture)',
    parseNumber('positive')
  )
  .option('--seed <n>', 'seed for reproducible dice', parseNumber('integer'))
  .option('--campaigns-dir <path>', 'campaigns directory', 'campaigns')
  .option('--resume', 'continue an existing session log', false)
  .action(
    action<RunCommandOptions>(async (options) => {
      const result = await runSession({
        campaignsDir: options.campaignsDir,
        campaign: options.campaign,
        session: options.session,
        fixturePath: options.fixture,
        targetMinutes: options.targetMinutes,
        seed: options.seed,
        resume: options.resume,
        log: (line) => console.log(line),
      });
      console.log(`\nSession ${result.status}. Event log: ${result.eventsPath}`);
      if (result.status === 'paused') {
        console.error(formatPauseMessage(result));
        process.exitCode = 2;
      }
    })
  );

program
  .command('bench')
  .description("Check each seat's endpoint: reachability, speed, and tool-call reliability")
  .requiredOption('--campaign <id>', 'campaign id (a folder under the campaigns directory)')
  .option('--trials <n>', 'tool-call trials per seat', parseNumber('integer'), 5)
  .option('--campaigns-dir <path>', 'campaigns directory', 'campaigns')
  .action(
    action<BenchCommandOptions>(async (options) => {
      const report = await runBench({
        campaignsDir: options.campaignsDir,
        campaign: options.campaign,
        trials: options.trials,
        log: (line) => console.log(line),
      });
      console.log(`\nBench report: ${report.reportPath}`);
      if (!benchPassed(report.results, report.embed)) process.exitCode = 1;
    })
  );

program
  .command('index')
  .description("Build or refresh the lore index from the campaign's cartyx-lore checkout")
  .requiredOption('--campaign <id>', 'campaign id (a folder under the campaigns directory)')
  .option('--force', 'rebuild even when the index is fresh', false)
  .option('--check', 'report freshness without building', false)
  .option('--campaigns-dir <path>', 'campaigns directory', 'campaigns')
  .action(
    action<IndexCommandOptions>(async (options) => {
      const result = await runIndex({
        campaignsDir: options.campaignsDir,
        campaign: options.campaign,
        force: options.force,
        check: options.check,
        log: (line) => console.log(line),
      });
      for (const line of formatIndexSummary(result)) console.log(line);
    })
  );

program
  .command('script')
  .description(
    'Turn a session event log into script.json (for voicing) and script.md (for reading)'
  )
  .requiredOption('--campaign <id>', 'campaign id (a folder under the campaigns directory)')
  .option('--session <n>', 'session number', parseNumber('integer'), 1)
  .option('--no-model', 'attribute quotes in DM narration by rules only')
  .option('--refresh', 'ignore cached model answers', false)
  .option('--campaigns-dir <path>', 'campaigns directory', 'campaigns')
  .action(
    action<ScriptCommandOptions>(async (options) => {
      const result = await makeScript({
        campaignsDir: options.campaignsDir,
        campaign: options.campaign,
        session: options.session,
        useModel: options.model,
        refresh: options.refresh,
        log: (line) => console.log(line),
      });
      for (const line of formatScriptSummary(result)) console.log(line);
    })
  );

await program.parseAsync(process.argv);
