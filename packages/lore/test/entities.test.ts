import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../src/chunk';
import { buildEntityIndex, normalizeName, parseKankaFile, resolveEntity } from '../src/entities';

const FILES = [
  {
    path: 'kanka-export/markdown/characters/2418574-2418574.md',
    text: '# Professor Sella Vaunt\n\n**Type:** NPC\n\nTeaches applied crystal engines.\n',
  },
  {
    path: 'kanka-export/markdown/locations/1465238-1465238.md',
    text: '# Avalon Artificers Academy\n\n**Type:** School\n\nA polished rival school.\n',
  },
  // Two characters of the SAME type: a real duplicate in the wiki, and the case worth reporting.
  {
    path: 'kanka-export/markdown/characters/9000001-9000001.md',
    text: '# Borin Ash\n\nA smith.\n',
  },
  {
    path: 'kanka-export/markdown/characters/9000003-9000003.md',
    text: '# Borin Ash\n\nA different smith entirely.\n',
  },
  // A location and its own map: facets of one subject, not a naming mistake.
  {
    path: 'kanka-export/markdown/locations/9000004-9000004.md',
    text: '# Brookhaven\n\nA district north of the river.\n',
  },
  {
    path: 'kanka-export/markdown/maps/9000005-9000005.md',
    text: '# Brookhaven\n\nA map of the district.\n',
  },
  { path: 'kanka-export/markdown/characters/_index.md', text: '# characters (3)\n\n- [x](y.md)\n' },
];

const INDEX = buildEntityIndex(FILES);

describe('normalizeName', () => {
  it('folds case, punctuation, and a leading honorific', () => {
    expect(normalizeName('Prof. Sella Vaunt')).toBe(normalizeName('Professor Sella Vaunt'));
    expect(normalizeName('Headmistress Avonstre')).toBe('avonstre');
    expect(normalizeName('  Dean  Ambrose   Crandall ')).toBe('ambrose crandall');
  });

  it('does not strip an honorific that is the whole name', () => {
    expect(normalizeName('Captain')).toBe('captain');
  });
});

describe('parseKankaFile', () => {
  it('reads the id from the filename, the type from the folder, the name from the H1', () => {
    expect(parseKankaFile(FILES[0]!.path, FILES[0]!.text)).toEqual({
      entityId: 'kanka-2418574',
      kankaId: 2418574,
      entityType: 'character',
      entityName: 'Professor Sella Vaunt',
    });
  });

  it('ignores an index stub', () => {
    // Found by name, not position: adding a fixture above must not silently retarget this.
    const stub = FILES.find((file) => file.path.endsWith('_index.md'))!;
    expect(parseKankaFile(stub.path, stub.text)).toBeUndefined();
  });

  it('ignores a file outside the kanka export', () => {
    expect(parseKankaFile('dm/roster.md', '# Prof. Sella Vaunt\n')).toBeUndefined();
  });
});

describe('buildEntityIndex', () => {
  it('marks a name shared by two entities OF THE SAME TYPE as ambiguous and reports it', () => {
    expect(INDEX.byName.get(normalizeName('Borin Ash'))).toBe('ambiguous');
    expect(INDEX.ambiguous).toEqual(['Borin Ash']);
  });

  it('resolves a name shared across DIFFERENT types by precedence, and does not report it', () => {
    // A wiki holds a map of Brookhaven beside the location Brookhaven. Prose naming it means the
    // location, so this is not a duplicate to fix — reporting it would send someone to "clean up"
    // data that is correct.
    const hit = INDEX.byName.get(normalizeName('Brookhaven'));
    expect(hit).toMatchObject({ entityType: 'location', kankaId: 9000004 });
    expect(INDEX.ambiguous).not.toContain('Brookhaven');
  });
});

describe('resolveEntity', () => {
  const roster = `# Avalon Artificers Academy

The campus sits north of the river, a walled quarter of workshops, orchards and duelling halls
that the town has never quite decided whether to be proud of.

## Prof. Sella Vaunt

Prof. Sella Vaunt, 38, human, teaches applied crystal engines at the Academy every term.

## Campus

The orchard strip runs along the north wall and is where prototypes get field-tested.

## Borin Ash

Borin Ash keeps the forge behind the dormitories and sharpens every practice blade.
`;
  const chunks = chunkMarkdown('dm/regions/south/cities/avalon.md', roster);

  it('matches the deepest heading that names a Kanka entity', () => {
    expect(resolveEntity(chunks[1]!, INDEX)).toEqual({
      entityId: 'kanka-2418574',
      kankaId: 2418574,
      entityType: 'character',
      entityName: 'Professor Sella Vaunt',
    });
  });

  it('falls back to an enclosing heading when the deepest one names nothing', () => {
    expect(resolveEntity(chunks[2]!, INDEX)).toEqual({
      entityId: 'kanka-1465238',
      kankaId: 1465238,
      entityType: 'location',
      entityName: 'Avalon Artificers Academy',
    });
  });

  it('falls back to a path id when the name is ambiguous', () => {
    expect(resolveEntity(chunks[3]!, INDEX)).toEqual({
      entityId: 'file:dm/regions/south/cities/avalon.md#avalon-artificers-academy/borin-ash',
      entityName: 'Borin Ash',
      entityType: 'document',
    });
  });

  it('falls back to a path id and the source name when nothing matches', () => {
    const [chunk] = chunkMarkdown(
      'population/georgia.md',
      '# Georgia\n\nCensus rows for the top twenty cities of the state, with populations, counties and the year each was chartered.\n'
    );
    expect(resolveEntity(chunk!, INDEX)).toEqual({
      entityId: 'file:population/georgia.md#georgia',
      entityName: 'Georgia',
      entityType: 'document',
    });
  });

  it('uses the source path as the name for a chunk with no heading', () => {
    const [chunk] = chunkMarkdown(
      'dm/loose.md',
      'A paragraph with no heading at all, written long enough that the chunker keeps it instead of dropping it as a stub.'
    );
    expect(resolveEntity(chunk!, INDEX)).toEqual({
      entityId: 'file:dm/loose.md#',
      entityName: 'dm/loose.md',
      entityType: 'document',
    });
  });
});
