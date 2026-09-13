import { describe, expect, it } from 'vitest';
import { formatPauseMessage } from '../src/pause-message';

describe('formatPauseMessage', () => {
  it('names the seat and asks to fix it for a seat-kind pause', () => {
    expect(
      formatPauseMessage({ seat: 'player-kira', error: 'connection refused', kind: 'seat' })
    ).toBe('Paused on seat player-kira: connection refused. Fix it and rerun with --resume.');
  });

  it('does not double a trailing period for a seat-kind pause', () => {
    expect(formatPauseMessage({ seat: 'dm', error: 'connection refused.', kind: 'seat' })).toBe(
      'Paused on seat dm: connection refused. Fix it and rerun with --resume.'
    );
  });

  it('reports a backstop pause on its own, without the seat framing or "Fix it"', () => {
    const message = formatPauseMessage({
      seat: 'dm',
      error:
        'No one has spoken or changed the game state for 12 turns in a row. Resuming gives the ' +
        "table another 12 turns; check the seats' model output.",
      kind: 'backstop',
    });
    expect(message).toBe(
      'Paused: No one has spoken or changed the game state for 12 turns in a row. Resuming gives ' +
        "the table another 12 turns; check the seats' model output. Rerun with --resume to continue."
    );
    expect(message).not.toContain('Seat "dm" failed');
    expect(message).not.toContain('Fix it');
    // No doubled period between the reason and "Rerun".
    expect(message).not.toContain('..');
  });
});
