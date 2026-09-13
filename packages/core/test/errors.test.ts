import { describe, expect, it } from 'vitest';
import { SessionPausedError } from '../src/errors';

describe('SessionPausedError', () => {
  it('prefixes a seat-kind pause with "Seat ... failed" (the default kind)', () => {
    const error = new SessionPausedError('dm', 'connection refused');
    expect(error.kind).toBe('seat');
    expect(error.message).toBe('Seat "dm" failed: connection refused');
  });

  it('uses the reason alone for a backstop-kind pause, with no "Seat ... failed" prefix', () => {
    const error = new SessionPausedError(
      'dm',
      'No one has spoken or changed the game state for 12 turns in a row.',
      'backstop'
    );
    expect(error.kind).toBe('backstop');
    expect(error.message).toBe(
      'No one has spoken or changed the game state for 12 turns in a row.'
    );
    expect(error.message).not.toContain('failed');
  });
});
