import { describe, expect, it } from 'vitest';
import {
  finishLine,
  hasWords,
  Mask,
  pairQuotes,
  removeEmphasis,
  removeMarkdown,
  removeQuotes,
  sliceText,
  sourceLines,
} from '../src/normalize';

describe('Mask', () => {
  it('reports kept runs and text with source offsets', () => {
    const mask = new Mask('ab**cd**ef');
    mask.remove(2, 4);
    mask.remove(6, 8);
    expect(mask.kept(0, 10)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
      { start: 8, end: 10 },
    ]);
    expect(mask.keptText(0, 10)).toBe('abcdef');
    expect(sliceText(mask.raw, mask.kept(0, 10))).toBe('abcdef');
    expect(mask.isRemoved(2)).toBe(true);
    expect(mask.isRemoved(4)).toBe(false);
  });

  it('clamps removals to the text', () => {
    const mask = new Mask('abc');
    mask.remove(-5, 1);
    mask.remove(2, 99);
    expect(mask.keptText(0, 3)).toBe('b');
  });
});

describe('finishLine', () => {
  it('collapses whitespace and trims', () => {
    expect(finishLine('  Stay\n  close.  ')).toBe('Stay close.');
  });

  it('ends a line that ends in a comma, semicolon, or colon with a period', () => {
    expect(finishLine('You... opened... the door,')).toBe('You... opened... the door.');
    expect(finishLine('She whispers:')).toBe('She whispers.');
  });

  it('adds a period when there is no ending punctuation', () => {
    expect(finishLine('Iron door')).toBe('Iron door.');
  });

  it('keeps existing endings, including dashes, ellipses, and closing brackets', () => {
    for (const text of ['Run!', 'Why?', 'Wait...', 'I think—', 'Wait…', "the 'owners'", '(soft)']) {
      expect(finishLine(text)).toBe(text);
    }
  });

  it('returns empty for text with no letters or digits', () => {
    expect(finishLine(' , ... ')).toBe('');
  });
});

describe('removeEmphasis', () => {
  it('removes asterisks and word-edge underscores but not inner underscores', () => {
    const mask = new Mask('**Bold** and *soft* and _lean_ snake_case');
    removeEmphasis(mask);
    expect(mask.keptText(0, mask.raw.length)).toBe('Bold and soft and lean snake_case');
  });
});

describe('removeQuotes', () => {
  it('removes straight and curly double quotes but keeps apostrophes and single quotes', () => {
    const mask = new Mask("\"Kira's\" “take” on 'owners'");
    removeQuotes(mask);
    expect(mask.keptText(0, mask.raw.length)).toBe("Kira's take on 'owners'");
  });
});

describe('removeMarkdown', () => {
  it('removes heading, bullet, and rule markers and reports standalone lines', () => {
    const raw = '## The Hall\nIntro line.\n- first item\n2. second item\n---\n**Hand** it over.';
    const mask = new Mask(raw);
    const standalone = removeMarkdown(mask);
    const lines = sourceLines(raw);
    expect([...standalone].sort((a, b) => a - b)).toEqual([
      lines[0]!.start,
      lines[2]!.start,
      lines[3]!.start,
    ]);
    expect(mask.keptText(0, raw.length)).toBe(
      'The Hall\nIntro line.\nfirst item\nsecond item\n\nHand it over.'
    );
  });
});

describe('sourceLines', () => {
  it('returns each line without its newline', () => {
    expect(sourceLines('a\nbc\n')).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 4 },
      { start: 5, end: 5 },
    ]);
  });
});

describe('pairQuotes', () => {
  it('pairs quote marks in order and leaves an odd one open to the end', () => {
    const raw = '"A" said "B" and "C';
    const spans = pairQuotes(new Mask(raw), 0, raw.length);
    expect(spans).toEqual([
      { open: 0, close: 2 },
      { open: 9, close: 11 },
      { open: 17, close: null },
    ]);
  });

  it('ignores marks already removed and marks outside the range', () => {
    const raw = '"A" "B"';
    const mask = new Mask(raw);
    mask.remove(0, 1);
    expect(pairQuotes(mask, 0, 3)).toEqual([{ open: 2, close: null }]);
  });
});

describe('hasWords', () => {
  it('is true only when kept text in the ranges has a letter or digit', () => {
    const mask = new Mask('**, ab');
    removeEmphasis(mask);
    expect(hasWords(mask, [{ start: 0, end: 4 }])).toBe(false);
    expect(hasWords(mask, [{ start: 0, end: 6 }])).toBe(true);
  });
});
