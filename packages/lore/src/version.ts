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
 * different version and resuming into it is correctly refused. The `-unknown-` marker means a
 * status check failed — we don't know if content differs — but the digest fingerprints the
 * content, so an `-unknown-` string still compares correctly: same content yields the same
 * version and a resume is allowed; changed content is a different one and a resume is refused.
 */
export async function loreVersion(repoPath: string, digest: string): Promise<string> {
  const hex = digest.replace(/^sha256:/, '');
  const head = await git(repoPath, ['rev-parse', 'HEAD']);
  if (head === undefined || !/^[0-9a-f]{40}$/.test(head)) return `nogit-${hex.slice(0, 16)}`;
  const status = await git(repoPath, ['status', '--porcelain']);
  if (status === '') return head;
  if (status === undefined) return `${head}-unknown-${hex.slice(0, 8)}`;
  return `${head}-dirty-${hex.slice(0, 8)}`;
}
