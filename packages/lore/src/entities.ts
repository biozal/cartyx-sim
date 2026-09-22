import type { Chunk } from './chunk';
import { slugify } from './chunk';

/** One entity from the Kanka export mirror. */
export interface KankaEntity {
  entityId: string;
  kankaId: number;
  entityType: string;
  entityName: string;
}

export interface EntityIndex {
  /** Normalized name -> the one entity with that name, or 'ambiguous' when several share it. */
  byName: ReadonlyMap<string, KankaEntity | 'ambiguous'>;
  /** Display names that resolved to more than one entity, for `sim index` to report. */
  ambiguous: readonly string[];
}

/** What a chunk records about the entity it describes. */
export interface ChunkEntity {
  entityId: string;
  entityName: string;
  entityType: string;
  kankaId?: number;
}

/**
 * Titles a lore writer uses in prose but Kanka usually omits. Stripped only when something follows,
 * so an NPC actually named "Captain" keeps their name.
 */
const HONORIFICS = [
  'professor',
  'prof',
  'headmistress',
  'headmaster',
  'dean',
  'doctor',
  'dr',
  'mr',
  'mrs',
  'ms',
  'miss',
  'lord',
  'lady',
  'captain',
  'sir',
  'dame',
];

export function normalizeName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const [first, ...rest] = base.split(' ');
  if (first !== undefined && rest.length > 0 && HONORIFICS.includes(first)) return rest.join(' ');
  return base;
}

/** `kanka-export/markdown/<type>/<id>-<id>.md` -> the entity it holds. */
const KANKA_PATH = /^kanka-export\/markdown\/([a-z]+)\/(\d+)-\d+\.md$/;

/** `characters` -> `character`; `families` -> `family`. */
function singular(folder: string): string {
  if (folder.endsWith('ies')) return `${folder.slice(0, -3)}y`;
  return folder.endsWith('s') ? folder.slice(0, -1) : folder;
}

export function parseKankaFile(path: string, markdown: string): KankaEntity | undefined {
  const match = KANKA_PATH.exec(path.replaceAll('\\', '/'));
  if (!match) return undefined;
  const heading = /^#\s+(.*\S)\s*$/m.exec(markdown);
  if (!heading) return undefined;
  const kankaId = Number(match[2]);
  if (!Number.isSafeInteger(kankaId) || kankaId <= 0) return undefined;
  return {
    entityId: `kanka-${kankaId}`,
    kankaId,
    entityType: singular(match[1]!),
    entityName: heading[1]!,
  };
}

export function buildEntityIndex(files: readonly { path: string; text: string }[]): EntityIndex {
  const byName = new Map<string, KankaEntity | 'ambiguous'>();
  const ambiguous = new Map<string, string>();
  for (const file of files) {
    const entity = parseKankaFile(file.path, file.text);
    if (!entity) continue;
    const key = normalizeName(entity.entityName);
    if (key === '') continue;
    const existing = byName.get(key);
    if (existing === undefined) {
      byName.set(key, entity);
      continue;
    }
    // A second file for the same Kanka id is the same entity, not a collision.
    if (existing !== 'ambiguous' && existing.kankaId === entity.kankaId) continue;
    byName.set(key, 'ambiguous');
    ambiguous.set(key, entity.entityName);
  }
  return { byName, ambiguous: [...ambiguous.values()].sort() };
}

function pathEntity(chunk: Chunk): ChunkEntity {
  const slugPath = chunk.headings.map(slugify).join('/');
  return {
    entityId: `file:${chunk.source}#${slugPath}`,
    entityName: chunk.headings.at(-1) ?? chunk.source,
    entityType: 'document',
  };
}

/**
 * Walks a chunk's heading path deepest-first and takes the first heading that uniquely names a
 * Kanka entity, so an NPC's section resolves to the NPC and a "Campus" section under a school
 * resolves to the school. An ambiguous name is never guessed: it falls through to the path id.
 */
export function resolveEntity(chunk: Chunk, index: EntityIndex): ChunkEntity {
  for (let depth = chunk.headings.length - 1; depth >= 0; depth--) {
    const match = index.byName.get(normalizeName(chunk.headings[depth]!));
    // An unknown heading ("Campus") keeps walking outward to its parent. An *ambiguous* one stops
    // the walk: the heading does name an entity, we just cannot tell which, and resolving it to
    // the enclosing location instead would be a quiet miscount rather than an honest fallback.
    if (match === 'ambiguous') return pathEntity(chunk);
    if (match === undefined) continue;
    return {
      entityId: match.entityId,
      entityName: match.entityName,
      entityType: match.entityType,
      kankaId: match.kankaId,
    };
  }
  return pathEntity(chunk);
}
