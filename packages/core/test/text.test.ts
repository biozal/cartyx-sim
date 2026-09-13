import { describe, expect, it } from 'vitest';
import { countWords, escapeRegExp, slugify } from '../src/text';

describe('countWords', () => {
  it('counts words separated by any whitespace', () => {
    expect(countWords('Engine three?  I\ncalibrated it.')).toBe(5);
  });

  it('returns 0 for blank text', () => {
    expect(countWords('   ')).toBe(0);
  });
});

describe('slugify', () => {
  it('builds kebab-case ids', () => {
    expect(slugify('Professor Sella Vaunt')).toBe('professor-sella-vaunt');
  });

  it('strips accents and punctuation', () => {
    expect(slugify("Selûne's  Chosen!")).toBe('selune-s-chosen');
  });

  it('returns an empty string when nothing usable remains', () => {
    expect(slugify('!!!')).toBe('');
  });
});

describe('escapeRegExp', () => {
  it('makes special characters literal', () => {
    const pattern = new RegExp(escapeRegExp('a.b(c)'));
    expect(pattern.test('a.b(c)')).toBe(true);
    expect(pattern.test('axb(c)')).toBe(false);
  });
});
