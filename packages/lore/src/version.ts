import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, { cwd: repoPath });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * The lore version recorded in `session_start` and compared on resume: the commit sha when the
 * tree is clean, and `<sha>-dirty-<digest8>` when it is not, so an uncommitted lore edit is a
 * different version and resuming into it is correctly refused.
 */
export async function loreVersion(repoPath: string, digest: string): Promise<string> {
  const hex = digest.replace(/^sha256:/, '');
  const head = await git(repoPath, ['rev-parse', 'HEAD']);
  if (head === undefined || !/^[0-9a-f]{40}$/.test(head)) return `nogit-${hex.slice(0, 16)}`;
  const status = await git(repoPath, ['status', '--porcelain']);
  if (status === undefined || status === '') return head;
  return `${head}-dirty-${hex.slice(0, 8)}`;
}
