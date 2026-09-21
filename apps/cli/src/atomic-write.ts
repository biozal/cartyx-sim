import { rename, unlink, writeFile } from 'node:fs/promises';

/**
 * The subset of `node:fs/promises` `writeFilesAtomic` needs, injectable so its cleanup path is
 * testable (a real filesystem rarely fails `unlink` in a way a test can trigger on demand).
 */
export interface AtomicWriteFs {
  writeFile: (path: string, content: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
}

const defaultFs: AtomicWriteFs = { writeFile, rename, unlink };

/**
 * Writes each of `files` so a reader never sees a partial one: every `<path>.tmp-<pid>` is
 * written first, then the temp files are renamed into place in the given order, so a caller can
 * put the file that signals completion (e.g. `script.json`) last. On any failure it removes every
 * temp file that has not yet been renamed, ignoring any error from that cleanup (including one
 * for a temp file that was never created), and rethrows the original write or rename error, so
 * nothing durable is left half-written.
 */
export async function writeFilesAtomic(
  files: { path: string; content: string }[],
  fs: Partial<AtomicWriteFs> = {}
): Promise<void> {
  const { writeFile, rename, unlink } = { ...defaultFs, ...fs };
  const temps = files.map((file) => `${file.path}.tmp-${process.pid}`);
  let renamed = 0;
  try {
    for (const [index, file] of files.entries()) {
      await writeFile(temps[index]!, file.content);
    }
    for (const [index, file] of files.entries()) {
      await rename(temps[index]!, file.path);
      renamed++;
    }
  } catch (error) {
    await Promise.all(
      temps.slice(renamed).map(async (temp) => {
        try {
          await unlink(temp);
        } catch {
          // Ignored either way: a failed cleanup must never mask the original error above.
        }
      })
    );
    throw error;
  }
}

/** `writeFilesAtomic` for a single file. */
export async function writeFileAtomic(
  path: string,
  content: string,
  fs: Partial<AtomicWriteFs> = {}
): Promise<void> {
  await writeFilesAtomic([{ path, content }], fs);
}
