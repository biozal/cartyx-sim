import { Command } from 'commander';
import { parseNumber } from './args';
import { runSession } from './run';

interface RunCommandOptions {
  campaign: string;
  fixture: string;
  session: number;
  targetMinutes?: number;
  seed?: number;
  campaignsDir: string;
  resume: boolean;
}

const program = new Command().name('sim').description('Cartyx AI D&D session simulator');

program
  .command('run')
  .description('Simulate a session and write its event log')
  .requiredOption('--campaign <id>', 'campaign id (a folder under the campaigns directory)')
  .requiredOption('--fixture <path>', 'scripted fixture to play; real models arrive in Plan 2')
  .option('--session <n>', 'session number', parseNumber('integer'), 1)
  .option(
    '--target-minutes <n>',
    'target spoken minutes (overrides the fixture)',
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

await program.parseAsync(process.argv);
