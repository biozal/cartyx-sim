import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** One markdown file from the lore repository. */
export interface LoreFile {
  path: string;
  text: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * Everything markdown is lore, including the Kanka mirror. The only markdown left out is the
 * export's generated navigation, which is a list of links rather than anything a DM could use.
 */
export function isIndexable(relativePath: string): boolean {
  const path = relativePath.replaceAll('\\', '/');
  if (!path.endsWith('.md')) return false;
  if (path.split('/').some((part) => SKIP_DIRS.has(part))) return false;
  const name = path.split('/').at(-1)!;
  if (path.startsWith('kanka-export/') && (name === '_index.md' || name === 'index.md')) {
    return false;
  }
  return true;
}

export async function readLoreFiles(
  repoPath: string,
  include: (relativePath: string) => boolean = isIndexable
): Promise<LoreFile[]> {
  const files: LoreFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(repoPath, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !include(rel)) continue;
      files.push({ path: rel, text: await readFile(full, 'utf8') });
    }
  };
  await walk(repoPath);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/**
 * A digest over the paths and bytes actually ingested. This, not the git commit, is what decides
 * whether an index is stale: a commit touching no lore file must not cost a rebuild, and an
 * uncommitted edit must.
 */
export function contentDigest(files: readonly LoreFile[]): string {
  const lines = files
    .map((file) => `${file.path}\0${createHash('sha256').update(file.text).digest('hex')}`)
    .sort();
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
  return `sha256:${digest}`;
}
