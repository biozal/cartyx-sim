import { rename, unlink, writeFile } from 'node:fs/promises';

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Writes `content` to `path` so a reader never sees a partial file: it writes to
 * `<path>.tmp-<pid>` and renames that into place. On any failure it removes the temp file
 * (ignoring one that was never created) and rethrows the original error, so nothing is left
 * behind.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temp, content);
    await rename(temp, path);
  } catch (error) {
    try {
      await unlink(temp);
    } catch (unlinkError) {
      if (!isNotFound(unlinkError)) throw unlinkError;
    }
    throw error;
  }
}
