import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loreVersion } from '../src/version';

const run = promisify(execFile);

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lore-git-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(join(dir, 'gods.md'), '# Gods\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-qm', 'first'], { cwd: dir });
  return dir;
}

describe('loreVersion', () => {
  it('is the commit sha on a clean tree', async () => {
    const dir = await gitRepo();
    expect(await loreVersion(dir, 'sha256:abc')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('appends a dirty marker built from the digest when the tree is dirty', async () => {
    const dir = await gitRepo();
    await writeFile(join(dir, 'gods.md'), '# Gods\n\nA new line.\n');
    const version = await loreVersion(dir, 'sha256:0123456789abcdef');
    expect(version).toMatch(/^[0-9a-f]{40}-dirty-01234567$/);
  });

  it('falls back to the digest when the path is not a git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lore-plain-'));
    expect(await loreVersion(dir, 'sha256:0123456789abcdef')).toBe('nogit-0123456789abcdef');
  });
});
