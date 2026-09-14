import { describe, expect, it } from 'vitest';
import { countWords, escapeRegExp, slugify, unwrapQuotes } from '../src/text';

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

describe('unwrapQuotes', () => {
  it('removes one pair of straight double quotes around the whole line', () => {
    expect(unwrapQuotes('"Keep an eye on him, Bram."')).toBe('Keep an eye on him, Bram.');
  });

  it('removes curly double quotes and trims what is inside', () => {
    expect(unwrapQuotes('“ Stay close. ”')).toBe('Stay close.');
  });

  it('removes a mismatched pair of straight and curly quotes', () => {
    expect(unwrapQuotes('“Hold the line."')).toBe('Hold the line.');
  });

  it('keeps a line whose quotes are only part of it', () => {
    const line = '"One word, then." (I wait a beat.) "...Which?"';
    expect(unwrapQuotes(line)).toBe(line);
    expect(unwrapQuotes('He said "go".')).toBe('He said "go".');
    expect(unwrapQuotes('"Wait')).toBe('"Wait');
  });

  it('empties a line with nothing inside its quotes', () => {
    expect(unwrapQuotes('""')).toBe('');
    expect(unwrapQuotes('"   "')).toBe('');
  });

  it('trims a line it otherwise leaves alone, including single quotes', () => {
    expect(unwrapQuotes('  Hello there.  ')).toBe('Hello there.');
    expect(unwrapQuotes("'Tis nothing, friend'")).toBe("'Tis nothing, friend'");
  });
});

describe('escapeRegExp', () => {
  it('makes special characters literal', () => {
    const pattern = new RegExp(escapeRegExp('a.b(c)'));
    expect(pattern.test('a.b(c)')).toBe(true);
    expect(pattern.test('axb(c)')).toBe(false);
  });
});
