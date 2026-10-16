/** What `normalizeTables` did to one text. */
export interface TableStats {
  pipeTables: number;
  statBlocks: number;
  keptHtml: number;
}

interface Cell {
  attrs: string;
  html: string;
}

const TABLE = /<table>[\s\S]*?<\/table>/g;
const ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
const CELL = /<(th|td)([^>]*)>([\s\S]*?)<\/\1>/g;
/** The header row of a monster's ability-score table: three groups of name, score, MOD, SAVE. */
const STAT_HEADER = ['', '', 'MOD', 'SAVE', '', '', 'MOD', 'SAVE', '', '', 'MOD', 'SAVE'];

function rows(html: string): Cell[][] {
  return [...html.matchAll(ROW)].map((row) =>
    [...row[1]!.matchAll(CELL)].map((cell) => ({ attrs: cell[2]!, html: cell[3]! }))
  );
}

/** A cell's content as one line of Markdown. */
function plain(html: string): string {
  return html
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**')
    .replace(/<em>([\s\S]*?)<\/em>/g, '_$1_')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function statBlockLine(body: Cell[][]): string {
  const parts: string[] = [];
  for (const row of body) {
    for (let i = 0; i < 12; i += 4) {
      const [name, score, mod, save] = row
        .slice(i, i + 4)
        .map((cell) => plain(cell.html).replace(/\*/g, ''));
      parts.push(`${name} ${score} (${mod}, save ${save})`);
    }
  }
  return parts.join(' | ');
}

function pipeTable(all: Cell[][]): string {
  const width = Math.max(...all.map((row) => row.length));
  const line = (row: Cell[]) => {
    const cells = Array.from({ length: width }, (_, i) =>
      row[i] ? plain(row[i]!.html).replace(/\|/g, '\\|') : ''
    );
    return `| ${cells.join(' | ')} |`;
  };
  const [header, ...body] = all;
  return [line(header!), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map(line)].join(
    '\n'
  );
}

/**
 * Rewrites the SRD's HTML tables: a monster's ability-score table becomes one line, a table with
 * merged cells or two header rows stays HTML (flattening it would misalign its columns), and any
 * other table becomes a Markdown pipe table. A `<br>` ending a line outside a table is removed.
 */
export function normalizeTables(markdown: string): { text: string; stats: TableStats } {
  const stats: TableStats = { pipeTables: 0, statBlocks: 0, keptHtml: 0 };
  const replaced = markdown.replace(TABLE, (table) => {
    const head = /<thead>([\s\S]*?)<\/thead>/.exec(table)?.[1];
    const bodyHtml =
      /<tbody>([\s\S]*?)<\/tbody>/.exec(table)?.[1] ??
      table.replace(/<thead>[\s\S]*?<\/thead>/, '');
    const headRows = head === undefined ? [] : rows(head);
    const bodyRows = rows(bodyHtml);
    const all = [...headRows, ...bodyRows];
    if (
      headRows.length > 1 ||
      all.some((row) => row.some((cell) => /colspan|rowspan/.test(cell.attrs)))
    ) {
      stats.keptHtml++;
      return table;
    }
    const header = headRows[0]?.map((cell) => plain(cell.html));
    if (
      header?.join('\u0000') === STAT_HEADER.join('\u0000') &&
      bodyRows.length === 2 &&
      bodyRows.every((row) => row.length === 12)
    ) {
      stats.statBlocks++;
      return statBlockLine(bodyRows);
    }
    stats.pipeTables++;
    return pipeTable(all);
  });
  const text = replaced.replace(/[ \t]*<br\s*\/?>[ \t]*$/gm, '');
  return { text, stats };
}
