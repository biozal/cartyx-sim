import { rename, unlink, writeFile } from 'node:fs/promises';

/**
 * The subset of `node:fs/promises` `writeFileAtomic` needs, injectable so its cleanup path is
 * testable (a real filesystem rarely fails `unlink` in a way a test can trigger on demand).
 */
export interface AtomicWriteFs {
  writeFile: (path: string, content: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
}

const defaultFs: AtomicWriteFs = { writeFile, rename, unlink };

/**
 * Writes `content` to `path` so a reader never sees a partial file: it writes to
 * `<path>.tmp-<pid>` and renames that into place. On any failure it removes the temp file,
 * ignoring any error from that cleanup unlink (including one that was never created), and
 * rethrows the original write or rename error, so nothing is left behind.
 */
export async function writeFileAtomic(
  path: string,
  content: string,
  fs: Partial<AtomicWriteFs> = {}
): Promise<void> {
  const { writeFile, rename, unlink } = { ...defaultFs, ...fs };
  const temp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temp, content);
    await rename(temp, path);
  } catch (error) {
    try {
      await unlink(temp);
    } catch {
      // Ignored either way: a failed cleanup must never mask the original error above.
    }
    throw error;
  }
}
