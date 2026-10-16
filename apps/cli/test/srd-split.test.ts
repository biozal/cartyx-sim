import { describe, expect, it } from 'vitest';
import { buildSrd, SOURCE_FILES } from '../src/srd/split';

const CLASSES = [
  'Barbarian',
  'Bard',
  'Cleric',
  'Druid',
  'Fighter',
  'Monk',
  'Paladin',
  'Ranger',
  'Rogue',
  'Sorcerer',
  'Warlock',
  'Wizard',
];

const sections = (titles: string[]) => titles.flatMap((t) => [`## ${t}`, '', `${t} text.`, '']);

function fixture(): Record<string, string> {
  return {
    'playing-the-game.md': [
      '# Playing the Game',
      '',
      ...sections([
        'Rhythm of Play',
        'The Six Abilities',
        'D20 Tests',
        'Proficiency',
        'Actions',
        'Social Interaction',
        'Exploration',
        'Combat',
        'Damage and Healing',
      ]),
    ].join('\n'),
    'character-creation.md': '# Character Creation\n\nMake one.\n',
    'classes.md': [
      '# Classes',
      '',
      ...CLASSES.flatMap((c) => [
        `## ${c}`,
        '',
        `${c} text.`,
        '',
        `### ${c} Class Features`,
        '',
        'x',
        '',
      ]),
    ].join('\n'),
    'character-origins.md': [
      '# Character Origins',
      '',
      '## Character Backgrounds',
      '',
      '### Background Descriptions',
      '',
      '#### Acolyte',
      '',
      'a',
      '',
      '#### Sage',
      '',
      's',
      '',
      '## Character Species',
      '',
      '### Species Descriptions',
      '',
      '#### Elf',
      '',
      'e',
      '',
    ].join('\n'),
    'feats.md': '# Feats\n\n## Feat Descriptions\n\n### Origin Feats\n\n#### Alert\n\nx\n',
    'equipment.md': [
      '# Equipment',
      '',
      ...sections([
        'Coins',
        'Weapons',
        'Armor',
        'Tools',
        'Adventuring Gear',
        'Mounts and Vehicles',
        'Lifestyle Expenses',
        'Food, Drink, and Lodging',
        'Hirelings',
        'Spellcasting',
        'Magic Items',
        'Crafting Nonmagical Items',
        'Brewing Potions of Healing',
        'Scribing Spell Scrolls',
      ]),
    ].join('\n'),
    'spells.md': [
      '# Spells',
      '',
      '## Casting Spells',
      '',
      'How.',
      '',
      '## Spell Descriptions',
      '',
      '#### Acid Splash',
      '',
      '_Evocation Cantrip (Sorcerer, Wizard)_',
      '',
      'Acid.',
      '',
      '#### Find Steed',
      '',
      '_Level 2 Conjuration (Paladin)_',
      '',
      'A steed.',
      '',
      '## Otherworldly Steed',
      '',
      '_Large Celestial_',
      '',
      '#### Actions',
      '',
      'Hoof.',
      '',
      '#### Fireball',
      '',
      '_Level 3 Evocation (Sorcerer, Wizard)_',
      '',
      'Boom.',
      '',
    ].join('\n'),
    'rules-glossary.md': '# Rules Glossary\n\nTerms.\n',
    'gameplay-toolbox.md': '# Gameplay Toolbox\n\nTools.\n',
    'magic-items.md':
      '# Magic Items\n\n## Magic Item Rarity\n\nRare.\n\n## Magic Items A–Z\n\n#### Bag of Holding\n\nBig.\n',
    'monsters.md': '# Monsters\n\n## Stat Block Overview\n\nRead it.\n',
    'monsters-A-Z.md': [
      '# Monsters A–Z',
      '',
      '## Aboleth',
      '',
      '### Aboleth',
      '',
      'x',
      '',
      '## Goblins',
      '',
      '### Goblin Warrior',
      '',
      'x',
      '',
      '### Goblin Boss',
      '',
      'x',
      '',
      '## Zombies',
      '',
      '### Zombie',
      '',
      'x',
      '',
    ].join('\n'),
    'animals.md': '# Animals\n\n## Ape\n\nx\n\n## Bat\n\nx\n',
  };
}

const byPath = (build: ReturnType<typeof buildSrd>) =>
  new Map(build.files.map((f) => [f.path, f.text]));

describe('buildSrd', () => {
  it('names all 13 source files', () => {
    expect([...SOURCE_FILES].sort()).toEqual(Object.keys(fixture()).sort());
  });

  it('promotes single sections and groups the rest', () => {
    const files = byPath(buildSrd(fixture()));
    expect(files.get('playing-the-game/combat.md')).toBe('# Combat\n\nCombat text.\n');
    expect(files.get('playing-the-game/d20-tests.md')).toMatch(
      /^# Playing the Game\n\n## Rhythm of Play\n/
    );
    expect(files.get('classes/barbarian.md')).toMatch(
      /^# Barbarian\n\nBarbarian text.\n\n## Barbarian Class Features/
    );
    expect(files.get('equipment/services.md')).toMatch(/^# Services\n\n## Lifestyle Expenses/);
    expect(files.get('equipment/coins-and-gear.md')).toMatch(
      /^# Equipment\n\n## Coins[\s\S]*## Adventuring Gear/
    );
    expect(files.get('feats.md')).toBe(
      '# Feats\n\n## Feat Descriptions\n\n### Origin Feats\n\n#### Alert\n\nx\n'
    );
  });

  it('files spells by level and keeps a summoned stat block inside its spell', () => {
    const files = byPath(buildSrd(fixture()));
    expect(files.get('spells/rules.md')).toBe('# Spells\n\n## Casting Spells\n\nHow.\n');
    expect(files.get('spells/cantrips.md')).toMatch(/^# Cantrips\n\n## Acid Splash\n/);
    expect(files.get('spells/level-2.md')).toBe(
      '# Level 2 Spells\n\n## Find Steed\n\n_Level 2 Conjuration (Paladin)_\n\nA steed.\n\n### Otherworldly Steed\n\n_Large Celestial_\n\n#### Actions\n\nHoof.\n'
    );
    expect(files.get('spells/level-3.md')).toMatch(/## Fireball/);
  });

  it('files monsters by letter and records generated and dropped headings', () => {
    const build = buildSrd(fixture());
    const files = byPath(build);
    expect(files.get('monsters/a-f.md')).toMatch(/^# Monsters A–F\n\n## Aboleth/);
    expect(files.get('monsters/g-l.md')).toMatch(/## Goblins[\s\S]*### Goblin Boss/);
    expect(files.get('monsters/s-z.md')).toMatch(/## Zombies/);
    expect(files.has('monsters/m-r.md')).toBe(false);
    expect(build.generatedTitles).toEqual(
      expect.arrayContaining(['Services', 'Crafting', 'Cantrips', 'Level 2 Spells', 'Monsters A–F'])
    );
    expect(build.droppedHeadings.sort()).toEqual(
      ['Character Origins', 'Classes', 'Monsters A–Z', 'Spell Descriptions'].sort()
    );
  });

  it('counts entries', () => {
    expect(buildSrd(fixture()).counts).toEqual({
      classes: 12,
      backgrounds: 2,
      species: 1,
      feats: 1,
      spells: 3,
      spellsByLevel: { '0': 1, '2': 1, '3': 1 },
      magicItems: 1,
      monsters: 4,
      animals: 2,
    });
  });

  it('refuses an unmapped section rather than drop it', () => {
    const sources = fixture();
    sources['equipment.md'] += '\n## Siege Engines\n\nNew.\n';
    expect(() => buildSrd(sources)).toThrow(/Siege Engines/);
  });

  it('refuses a dropped preamble that holds text', () => {
    const sources = fixture();
    sources['classes.md'] = sources['classes.md']!.replace(
      '# Classes\n',
      '# Classes\n\nIntro text.\n'
    );
    expect(() => buildSrd(sources)).toThrow(/preamble/);
  });
});
