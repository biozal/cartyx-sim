import { Command } from 'commander';
import { parseNumber } from './args';
import { benchPassed, runBench } from './bench';
import { releaseHeldLocks } from './jsonl-sink';
import { runSession } from './run';

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
  .action(async (options: RunCommandOptions) => {
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
      console.error(
        `Paused on seat ${result.seat}: ${result.error}. Fix it and rerun with --resume.`
      );
      process.exitCode = 2;
    }
  });

program
  .command('bench')
  .description("Check each seat's endpoint: reachability, speed, and tool-call reliability")
  .requiredOption('--campaign <id>', 'campaign id (a folder under the campaigns directory)')
  .option('--trials <n>', 'tool-call trials per seat', parseNumber('integer'), 5)
  .option('--campaigns-dir <path>', 'campaigns directory', 'campaigns')
  .action(async (options: BenchCommandOptions) => {
    const report = await runBench({
      campaignsDir: options.campaignsDir,
      campaign: options.campaign,
      trials: options.trials,
      log: (line) => console.log(line),
    });
    console.log(`\nBench report: ${report.reportPath}`);
    if (!benchPassed(report.results)) process.exitCode = 1;
  });

await program.parseAsync(process.argv);
