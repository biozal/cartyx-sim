import { describe, expect, it } from 'vitest';
import { headingOf, shiftHeadings, splitSections, toText } from '../src/srd/markdown';

describe('headingOf', () => {
  it('reads ATX headings', () => {
    expect(headingOf('## Weapons')).toEqual({ level: 2, title: 'Weapons' });
    expect(headingOf('#### Acid Arrow  ')).toEqual({ level: 4, title: 'Acid Arrow' });
  });
  it('ignores non-headings', () => {
    expect(headingOf('#hashtag')).toBeUndefined();
    expect(headingOf('Text # not a heading')).toBeUndefined();
    expect(headingOf('')).toBeUndefined();
  });
});

describe('splitSections', () => {
  const md = [
    '# Equipment',
    '',
    'Intro.',
    '',
    '## Coins',
    'c',
    '### Sub',
    's',
    '## Weapons',
    'w',
  ].join('\n');
  it('splits at the given level and keeps deeper headings inside', () => {
    const { preamble, sections } = splitSections(md, 2);
    expect(preamble).toEqual(['# Equipment', '', 'Intro.', '']);
    expect(sections.map((s) => s.title)).toEqual(['Coins', 'Weapons']);
    expect(sections[0]!.lines).toEqual(['## Coins', 'c', '### Sub', 's']);
    expect(sections[0]!.level).toBe(2);
  });
});

describe('shiftHeadings', () => {
  it('promotes and demotes headings only', () => {
    expect(shiftHeadings(['## A', 'text # x', '#### B'], -1)).toEqual(['# A', 'text # x', '### B']);
    expect(shiftHeadings(['## A'], 1)).toEqual(['### A']);
  });
  it('refuses to leave the 1–6 range', () => {
    expect(() => shiftHeadings(['# A'], -1)).toThrow(/heading level/);
  });
});

describe('toText', () => {
  it('trims surrounding blank lines and ends with one newline', () => {
    expect(toText(['', '# A', '', 'b', '', ''])).toBe('# A\n\nb\n');
  });
});
