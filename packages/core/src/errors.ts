/**
 * A seat (a model seat, or the "lore" pseudo-seat) failed in a way the session can resume from
 * later. The director records a `session_paused` event and stops instead of crashing.
 *
 * `kind` distinguishes a seat/infrastructure failure (`'seat'`, the default) from the
 * runaway-loop backstop (`'backstop'`): a backstop pause is not a seat failure, so its message is
 * the reason alone, without the "Seat ... failed" prefix.
 */
export class SessionPausedError extends Error {
  constructor(
    readonly seat: string,
    readonly reason: string,
    readonly kind: 'seat' | 'backstop' = 'seat'
  ) {
    super(kind === 'backstop' ? reason : `Seat "${seat}" failed: ${reason}`);
    this.name = 'SessionPausedError';
  }
}
