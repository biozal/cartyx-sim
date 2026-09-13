/**
 * A seat (a model seat, or the "lore" pseudo-seat) failed in a way the session can resume from
 * later. The director records a pause `ooc_note` and stops instead of crashing.
 */
export class SessionPausedError extends Error {
  constructor(
    readonly seat: string,
    readonly reason: string
  ) {
    super(`Seat "${seat}" failed: ${reason}`);
    this.name = 'SessionPausedError';
  }
}
