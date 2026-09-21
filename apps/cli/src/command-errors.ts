/**
 * The text a CLI command prints on failure. Without `debug` it is just the message (or
 * `String(error)` for a thrown value that is not an `Error`), so an operator sees a clean line
 * instead of a stack trace. With `debug` (`SIM_DEBUG=1`) it is the stack when the error has one,
 * for a bug report or a session where a stack trace is worth the noise.
 */
export function formatCommandError(error: unknown, debug: boolean): string {
  if (!(error instanceof Error)) return String(error);
  return debug && error.stack ? error.stack : error.message;
}
