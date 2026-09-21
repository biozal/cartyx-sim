import { describe, expect, it } from 'vitest';
import { findJsonReply } from '../src/json-reply';

const readLabels = (value: unknown): string[] | null =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { labels?: unknown }).labels)
    ? (value as { labels: string[] }).labels
    : null;

describe('findJsonReply', () => {
  it('reads an object wrapped in prose and a code fence', () => {
    const reply = 'Sure.\n```json\n{"labels": ["a", "b"]}\n```\nDone.';
    expect(findJsonReply(reply, readLabels)).toEqual(['a', 'b']);
  });

  it('ignores closed think blocks, even with braces inside', () => {
    const reply = '<think>maybe {"labels": ["wrong"]}</think>{"labels": ["right"]}';
    expect(findJsonReply(reply, readLabels)).toEqual(['right']);
  });

  it('skips objects the reader rejects and returns the first accepted one', () => {
    const reply = '{"other": 1} then {"labels": ["x"]}';
    expect(findJsonReply(reply, readLabels)).toEqual(['x']);
  });

  it('returns null when nothing is accepted', () => {
    expect(findJsonReply('no json here', readLabels)).toBeNull();
    expect(findJsonReply('{"other": 1}', readLabels)).toBeNull();
  });

  it('gives up quickly on a degenerate brace-heavy reply', () => {
    const reply = '{"'.repeat(5000) + '}'.repeat(5000);
    const started = Date.now();
    expect(findJsonReply(reply, readLabels)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
