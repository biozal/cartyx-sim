/** The subset of a paused `RunResult` the pause message needs. */
export interface PauseInfo {
  seat: string;
  error: string;
  kind: 'seat' | 'backstop';
}

function withoutTrailingPeriod(text: string): string {
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

/**
 * The message printed to stderr when a run pauses (exit code 2). A `backstop` pause is not a seat
 * failure, so it is reported on its own, without "Fix it" (which would contradict the backstop's
 * own resume-aware advice) or a doubled period after `error`.
 */
export function formatPauseMessage(result: PauseInfo): string {
  const reason = withoutTrailingPeriod(result.error);
  return result.kind === 'backstop'
    ? `Paused: ${reason}. Rerun with --resume to continue.`
    : `Paused on seat ${result.seat}: ${reason}. Fix it and rerun with --resume.`;
}
