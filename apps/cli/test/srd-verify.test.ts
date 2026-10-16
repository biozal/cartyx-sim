import { describe, expect, it } from 'vitest';
import { wordCounts, wordDifference } from '../src/srd/verify';

describe('wordCounts', () => {
  it('counts words and numbers across texts, ignoring tags, case and mod/save', () => {
    const counts = wordCounts(['<td><strong>STR</strong></td> 8 MOD SAVE', 'str save 8']);
    expect(Object.fromEntries(counts)).toEqual({ str: 2, '8': 2 });
  });
  it('splits on apostrophes of both kinds', () => {
    expect(Object.fromEntries(wordCounts(["it’s it's"]))).toEqual({ it: 2, s: 2 });
  });
});

describe('wordDifference', () => {
  it('reports what is missing and what is extra', () => {
    const expected = new Map([
      ['acid', 2],
      ['arrow', 1],
    ]);
    const actual = new Map([
      ['acid', 1],
      ['bolt', 1],
    ]);
    expect(wordDifference(expected, actual)).toEqual({
      missing: [
        ['acid', 1],
        ['arrow', 1],
      ],
      extra: [['bolt', 1]],
    });
  });
  it('is empty for equal multisets', () => {
    expect(wordDifference(new Map([['a', 1]]), new Map([['a', 1]]))).toEqual({
      missing: [],
      extra: [],
    });
  });
});
