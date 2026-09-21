import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import type { ScoredChunk, StoredChunk, VectorStore } from './store';

const TABLE = 'chunks';

interface Row {
  vector: number[];
  chunkId: string;
  source: string;
  title: string;
  text: string;
  entityId: string;
  entityName: string;
  entityType: string;
  kankaId: number | null;
}

function toStored(row: Row): StoredChunk {
  return {
    chunkId: row.chunkId,
    source: row.source,
    title: row.title,
    text: row.text,
    entityId: row.entityId,
    entityName: row.entityName,
    entityType: row.entityType,
    ...(row.kankaId === null ? {} : { kankaId: row.kankaId }),
  };
}

export class LanceStore implements VectorStore {
  private constructor(
    private readonly connection: lancedb.Connection,
    private readonly table: lancedb.Table
  ) {}

  static async open(indexDir: string): Promise<LanceStore> {
    const connection = await lancedb.connect(indexDir);
    const table = await connection.openTable(TABLE);
    return new LanceStore(connection, table);
  }

  static async write(
    indexDir: string,
    rows: readonly { chunk: StoredChunk; vector: Float32Array }[]
  ): Promise<void> {
    const records: Row[] = rows.map(({ chunk, vector }) => ({
      vector: Array.from(vector),
      chunkId: chunk.chunkId,
      source: chunk.source,
      title: chunk.title,
      text: chunk.text,
      entityId: chunk.entityId,
      entityName: chunk.entityName,
      entityType: chunk.entityType,
      kankaId: chunk.kankaId ?? null,
    }));
    const connection = await lancedb.connect(indexDir);
    // LanceDB types createTable's rows as Record<string, unknown>[]. `Row` is structurally
    // compatible but lacks an index signature; casting here keeps `Row` strict, so a renamed
    // column is still a type error at every other site.
    await connection.createTable(TABLE, records as unknown as Record<string, unknown>[], {
      mode: 'overwrite',
    });
    // A plain JSON mirror of the rows, for tests and for reading an index without LanceDB.
    await writeFile(
      join(indexDir, 'chunks.json'),
      `${JSON.stringify(rows.map(({ chunk, vector }) => ({ chunk, vector: Array.from(vector) })))}\n`
    );
  }

  async search(vector: Float32Array, limit: number): Promise<ScoredChunk[]> {
    const rows = (await this.table
      .vectorSearch(Array.from(vector))
      .distanceType('cosine')
      .limit(limit)
      .toArray()) as (Row & { _distance: number })[];
    return rows.map((row) => ({
      ...toStored(row),
      // LanceDB reports cosine *distance*; the engine's threshold is a similarity.
      score: 1 - row._distance,
    }));
  }

  async byChunkId(chunkId: string): Promise<StoredChunk | undefined> {
    const rows = (await this.table
      .query()
      // Lance's `where` predicate is SQL, where double quotes name a *column*, not a string —
      // JSON.stringify's double-quoted output would silently match against a (nonexistent) column
      // named after the id instead of comparing the value. Single-quoted string literals are the
      // correct form here, and doubling an embedded single quote escapes it.
      .where(`chunkId = '${chunkId.replaceAll("'", "''")}'`)
      .limit(1)
      .toArray()) as Row[];
    return rows[0] === undefined ? undefined : toStored(rows[0]);
  }

  async close(): Promise<void> {
    this.connection.close();
  }
}
