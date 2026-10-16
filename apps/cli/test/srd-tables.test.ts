import { describe, expect, it } from 'vitest';
import { normalizeTables } from '../src/srd/tables';

const row = (cells: string[], tag = 'td') =>
  `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;

const statBlock = [
  '<table>',
  `<thead>${row(['', '', 'MOD', 'SAVE', '', '', 'MOD', 'SAVE', '', '', 'MOD', 'SAVE'], 'th')}</thead>`,
  '<tbody>',
  row([
    '<strong>STR</strong>',
    '8',
    '−1',
    '−1',
    '<strong>DEX</strong>',
    '15',
    '+2',
    '+2',
    '<strong>CON</strong>',
    '10',
    '+0',
    '+0',
  ]),
  row([
    '<strong>INT</strong>',
    '10',
    '+0',
    '+0',
    '<strong>WIS</strong>',
    '8',
    '−1',
    '−1',
    '<strong>CHA</strong>',
    '8',
    '−1',
    '+1',
  ]),
  '</tbody>',
  '</table>',
].join('\n');

describe('normalizeTables', () => {
  it('turns a stat-block ability table into one line', () => {
    const { text, stats } = normalizeTables(`before\n\n${statBlock}\n\nafter`);
    expect(text).toBe(
      'before\n\nSTR 8 (−1, save −1) | DEX 15 (+2, save +2) | CON 10 (+0, save +0) | INT 10 (+0, save +0) | WIS 8 (−1, save −1) | CHA 8 (−1, save +1)\n\nafter'
    );
    expect(stats).toEqual({ pipeTables: 0, statBlocks: 1, keptHtml: 0 });
  });

  it('turns a simple table into a pipe table with inline formatting', () => {
    const html = [
      '<table>',
      `<thead>${row(['Ability', 'Score Measures …'], 'th')}</thead>`,
      `<tbody>${row(['<strong>Strength</strong>', 'Physical<br>might'])}${row(['Dex | Agility'])}</tbody>`,
      '</table>',
    ].join('\n');
    expect(normalizeTables(html).text).toBe(
      [
        '| Ability | Score Measures … |',
        '| --- | --- |',
        '| **Strength** | Physical might |',
        '| Dex \\| Agility |  |',
      ].join('\n')
    );
  });

  it('uses the first row as the header when there is no thead', () => {
    const html = `<table><tbody>${row(['A', 'B'])}${row(['1', '2'])}</tbody></table>`;
    expect(normalizeTables(html).text).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('reads a thead without a tbody once', () => {
    const html = `<table><thead>${row(['A'], 'th')}</thead>${row(['1'])}</table>`;
    expect(normalizeTables(html).text).toBe('| A |\n| --- |\n| 1 |');
  });

  it('leaves tables with colspan, rowspan or two header rows untouched', () => {
    const spans = `<table><thead><tr><th colspan="2">Slots</th></tr></thead><tbody>${row(['1', '2'])}</tbody></table>`;
    const twoHeads = `<table><thead>${row(['A'], 'th')}${row(['B'], 'th')}</thead><tbody>${row(['1'])}</tbody></table>`;
    for (const html of [spans, twoHeads]) {
      const { text, stats } = normalizeTables(html);
      expect(text).toBe(html);
      expect(stats.keptHtml).toBe(1);
    }
  });

  it('removes trailing <br> outside tables', () => {
    expect(normalizeTables('**AC** 15 <br>\n**HP** 10<br>\nkeep<br>this').text).toBe(
      '**AC** 15\n**HP** 10\nkeep<br>this'
    );
  });
});
