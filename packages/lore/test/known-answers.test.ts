import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildIndex, openIndex, type LoreIndexImpl } from '../src/build';
import { OpenAICompatibleEmbedder } from '../src/embed';

const lorePath = process.env.CARTYX_LORE_PATH;
const baseURL = process.env.CARTYX_EMBED_URL ?? 'http://127.0.0.1:1234/v1';
const model = process.env.CARTYX_EMBED_MODEL ?? 'text-embedding-nomic-embed-text-v1.5';

/**
 * Retrieval quality cannot be measured against a fake embedder, so these run only against the real
 * corpus and a real endpoint. They are the tests that decide `loreThreshold`; see the plan's
 * Task 15 notes for the numbers they produced.
 */
describe.skipIf(!lorePath)('known-answer retrieval', () => {
  let index: LoreIndexImpl;

  beforeAll(async () => {
    const indexDir = join(await mkdtemp(join(tmpdir(), 'lore-known-')), 'index');
    const embedder = new OpenAICompatibleEmbedder({ endpoint: { baseURL }, model });
    const started = Date.now();
    const result = await buildIndex({
      lorePath: lorePath!,
      indexDir,
      embedder,
      log: (line) => console.log(line),
    });
    const elapsedMs = Date.now() - started;
    // Printed so the calibration step has real numbers to read; also written into the plan.
    console.log(
      `Build: ${result.meta.files} files, ${result.meta.chunks} chunks, ${elapsedMs}ms (${(elapsedMs / 1000).toFixed(1)}s)`
    );
    index = await openIndex(indexDir, embedder);
  }, 1_800_000);

  const cases = [
    { query: 'who teaches applied crystal engines at Avalon?', expect: /Sella Vaunt/i },
    { query: 'who runs Avalon Artificers Academy?', expect: /Avonstre/i },
    { query: 'what is the Ghost Match?', expect: /ghost match/i },
    { query: 'which professor coaches technical dueling?', expect: /Wenda Gale/i },
    { query: 'what city is Avalon Artificers Academy in?', expect: /Alpharetta/i },
  ];

  for (const testCase of cases) {
    it(`answers: ${testCase.query}`, async () => {
      const hits = await index.search(testCase.query, 8);
      const joined = hits.map((hit) => `${hit.title}\n${hit.text}`).join('\n\n');
      // Printed so the calibration step has real numbers to read.
      console.log(
        `${testCase.query} -> ${hits
          .slice(0, 5)
          .map((hit) => `${hit.score.toFixed(3)} ${hit.entityName}`)
          .join(' | ')}`
      );
      expect(joined).toMatch(testCase.expect);
      expect(hits[0]!.score).toBeGreaterThan(0.4);
    });
  }

  it('scores an unrelated query below the top of a relevant one', async () => {
    const relevant = await index.search('who teaches applied crystal engines at Avalon?', 1);
    const unrelated = await index.search('zzzz quantum bicycle repair manual', 1);
    console.log(
      `relevant top ${relevant[0]!.score.toFixed(3)}; unrelated top ${unrelated[0]!.score.toFixed(3)}`
    );
    expect(unrelated[0]!.score).toBeLessThan(relevant[0]!.score);
  });
});
