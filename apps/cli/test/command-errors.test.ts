import { describe, expect, it } from 'vitest';
import { formatCommandError } from '../src/command-errors';

describe('formatCommandError', () => {
  it('is just the message without debug', () => {
    expect(formatCommandError(new Error('No event log at events.jsonl.'), false)).toBe(
      'No event log at events.jsonl.'
    );
  });

  it('is the stack with debug', () => {
    const error = new Error('No event log at events.jsonl.');
    expect(formatCommandError(error, true)).toBe(error.stack);
  });

  it('stringifies a non-Error value either way', () => {
    expect(formatCommandError('boom', false)).toBe('boom');
    expect(formatCommandError('boom', true)).toBe('boom');
    expect(formatCommandError(42, true)).toBe('42');
  });
});
