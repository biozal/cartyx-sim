import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEmbedder } from '@cartyx-sim/lore';
import { describe, expect, it } from 'vitest';
import { formatIndexSummary } from '../src/index-lore';
import { ensureRulesIndex, isRulesFile } from '../src/srd/rules-index';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sim-rules-'));
  const srdDir = join(root, 'srd');
  await mkdir(join(root, 'lore'), { recursive: true });
  await mkdir(join(srdDir, 'spells'), { recursive: true });
  await mkdir(join(srdDir, 'source'), { recursive: true });
  await writeFile(
    join(srdDir, 'README.md'),
    '# SRD\n\nAbout this folder, long enough to be a chunk if it were indexed at all.\n'
  );
  await writeFile(
    join(srdDir, 'source', 'spells.md'),
    '# Spells\n\nThe untouched upstream copy, which must never be indexed twice.\n'
  );
  await writeFile(
    join(srdDir, 'spells', 'level-3.md'),
    '# Level 3 Spells\n\n## Fireball\n\nA bright streak flashes from your pointing finger to a point you choose within range.\n'
  );
  const campaignsDir = join(root, 'campaigns');
  await mkdir(join(campaignsDir, 'test', 'characters'), { recursive: true });
  await writeFile(
    join(campaignsDir, 'test', 'campaign.json'),
    JSON.stringify({
      name: 'Test',
      targetMinutes: 5,
      lorePath: join(root, 'lore'),
      endpoints: { local: { baseURL: 'http://127.0.0.1:1234/v1' } },
      seats: {
        dm: { endpoint: 'local', model: 'dm-model' },
        embed: { endpoint: 'local', model: 'embed-model' },
        players: { kira: { endpoint: 'local', model: 'pc-model' } },
      },
    })
  );
  await writeFile(
    join(campaignsDir, 'test', 'characters', 'kira.json'),
    JSON.stringify({
      id: 'kira',
      name: 'Kira Vale',
      kind: 'pc',
      level: 1,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      proficiencyBonus: 2,
      saveProficiencies: [],
      skillProficiencies: [],
      ac: 12,
      maxHp: 8,
      hp: 8,
    })
  );
  return { campaignsDir, campaign: 'test', srdDir, indexDir: join(root, 'index') };
}

describe('isRulesFile', () => {
  it('indexes area files only', () => {
    expect(isRulesFile('spells/level-3.md')).toBe(true);
    expect(isRulesFile('README.md')).toBe(false);
    expect(isRulesFile('source/spells.md')).toBe(false);
    expect(isRulesFile('counts.json')).toBe(false);
  });
});

describe('ensureRulesIndex', () => {
  it('builds from area files, then reports fresh without rebuilding', async () => {
    const options = { ...(await fixture()), embedder: new FakeEmbedder(16) };
    const built = await ensureRulesIndex(options);
    expect(built.rebuilt).toBe(true);
    expect(built.meta?.files).toBe(1);
    const again = await ensureRulesIndex(options);
    expect(again.rebuilt).toBe(false);
    expect(again.stale).toBe(false);
    expect(formatIndexSummary(again, 'rules')[0]).toMatch(/^Index is fresh/);
  });

  it('says "rules" when no index exists yet', async () => {
    const options = { ...(await fixture()), embedder: new FakeEmbedder(16), check: true };
    const result = await ensureRulesIndex(options);
    expect(formatIndexSummary(result, 'rules')[0]).toMatch(/^No rules index/);
  });
});
