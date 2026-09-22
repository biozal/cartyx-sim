import { describe, expect, it } from 'vitest';
import { DOCUMENT_PREFIX, FakeEmbedder, QUERY_PREFIX } from '../src/embed';

describe('nomic task prefixes', () => {
  it('uses the prefixes the model was trained with', () => {
    expect(DOCUMENT_PREFIX).toBe('search_document: ');
    expect(QUERY_PREFIX).toBe('search_query: ');
  });
});

describe('FakeEmbedder', () => {
  it('is deterministic for the same text', async () => {
    const embedder = new FakeEmbedder(8);
    const [first] = await embedder.embedDocuments(['Sella Vaunt']);
    const [second] = await embedder.embedDocuments(['Sella Vaunt']);
    expect([...first!]).toEqual([...second!]);
    expect(first).toHaveLength(8);
  });

  it('gives different texts different vectors', async () => {
    const embedder = new FakeEmbedder(8);
    const [a, b] = await embedder.embedDocuments(['Sella Vaunt', 'Wenda Gale']);
    expect([...a!]).not.toEqual([...b!]);
  });

  it('embeds a query into the same space as a document with the same text', async () => {
    const embedder = new FakeEmbedder(8);
    const [document] = await embedder.embedDocuments(['Sella Vaunt']);
    const query = await embedder.embedQuery('Sella Vaunt');
    expect([...query]).toEqual([...document!]);
  });

  it('returns one vector per input, in order', async () => {
    const vectors = await new FakeEmbedder(4).embedDocuments(['a', 'b', 'c']);
    expect(vectors).toHaveLength(3);
  });
});
