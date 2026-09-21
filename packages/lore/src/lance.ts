import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Float64, Schema, Utf8 } from 'apache-arrow';
import type { ScoredChunk, StoredChunk, VectorStore } from './store';

const TABLE = 'chunks';

/**
 * An explicit schema for `createTable`, rather than letting LanceDB infer one from the rows.
 * `lorePath` is operator-configurable, and a lore repository with no `kanka-export/` directory
 * has every chunk resolve through `pathEntity` (see entities.ts), leaving `kankaId` `null` in
 * every row. LanceDB's inferrer cannot assign a type to an all-null column and throws; an
 * explicit schema sidesteps inference for that column entirely.
 *
 * `kankaId` is `Float64`, not `Int64`: Arrow reads an Int64 column back as a JS `BigInt`, which
 * would fail `LoreHit`'s `z.number()` downstream. `Float64` matches what inference already
 * produced for this numeric column before this schema existed, so the read path is unchanged,
 * and Kanka ids (~7 digits) are far inside Float64's exact-integer range.
 */
function chunkSchema(dims: number): Schema {
  return new Schema([
    new Field('vector', new FixedSizeList(dims, new Field('item', new Float32(), true)), false),
    new Field('chunkId', new Utf8(), false),
    new Field('source', new Utf8(), false),
    new Field('title', new Utf8(), false),
    new Field('text', new Utf8(), false),
    new Field('entityId', new Utf8(), false),
    new Field('entityName', new Utf8(), false),
    new Field('entityType', new Utf8(), false),
    new Field('kankaId', new Float64(), true),
  ]);
}

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
    const dims = rows[0]?.vector.length ?? 0;
    // LanceDB types createTable's rows as Record<string, unknown>[]. `Row` is structurally
    // compatible but lacks an index signature; casting here keeps `Row` strict, so a renamed
    // column is still a type error at every other site.
    await connection.createTable(TABLE, records as unknown as Record<string, unknown>[], {
      mode: 'overwrite',
      schema: chunkSchema(dims),
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
