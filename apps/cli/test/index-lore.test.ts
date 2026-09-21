import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEmbedder } from '@cartyx-sim/lore';
import { describe, expect, it } from 'vitest';
import { ensureIndex, formatIndexSummary, runIndex } from '../src/index-lore';

/** Writes a campaign whose lorePath points at a tiny lore repo, and returns both paths. */
async function fixture(): Promise<{ campaignsDir: string; campaign: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sim-index-'));
  const lore = join(root, 'lore');
  await mkdir(join(lore, 'dm'), { recursive: true });
  await writeFile(
    join(lore, 'dm', 'avalon.md'),
    '# Avalon Artificers Academy\n\nA polished rival school north of the river, famous for its duels, its bake-offs and its extremely well-funded workshops.\n'
  );
  const campaignsDir = join(root, 'campaigns');
  const campaignDir = join(campaignsDir, 'test');
  await mkdir(join(campaignDir, 'characters'), { recursive: true });
  await writeFile(
    join(campaignDir, 'campaign.json'),
    JSON.stringify({
      name: 'Test',
      targetMinutes: 5,
      lorePath: lore,
      endpoints: { local: { baseURL: 'http://127.0.0.1:1234/v1' } },
      seats: {
        dm: { endpoint: 'local', model: 'dm-model' },
        embed: { endpoint: 'local', model: 'embed-model' },
        players: { kira: { endpoint: 'local', model: 'pc-model' } },
      },
    })
  );
  await writeFile(
    join(campaignDir, 'characters', 'kira.json'),
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
  return { campaignsDir, campaign: 'test' };
}

describe('runIndex', () => {
  it('builds an index and reports what it indexed', async () => {
    const { campaignsDir, campaign } = await fixture();
    const result = await runIndex({
      campaignsDir,
      campaign,
      embedder: new FakeEmbedder(16),
    });
    expect(result.rebuilt).toBe(true);
    expect(result.meta!.chunks).toBe(1);
    expect(formatIndexSummary(result).join('\n')).toContain('1 chunk');
  });

  it('reports how long a rebuild took, and never claims a build time it did not spend', async () => {
    const { campaignsDir, campaign } = await fixture();
    const embedder = new FakeEmbedder(16);
    const built = await runIndex({ campaignsDir, campaign, embedder });
    expect(built.rebuilt).toBe(true);
    expect(built.buildMs).toBeGreaterThanOrEqual(0);
    expect(formatIndexSummary(built).join('\n')).toMatch(/in \d+\.\ds/);

    const fresh = await ensureIndex({ campaignsDir, campaign, embedder });
    expect(fresh.rebuilt).toBe(false);
    expect(fresh.buildMs).toBeUndefined();
    expect(formatIndexSummary(fresh).join('\n')).not.toMatch(/in \d+\.\ds/);

    const checked = await runIndex({ campaignsDir, campaign, check: true, embedder });
    expect(checked.buildMs).toBeUndefined();
  });

  it('--check reports freshness without building', async () => {
    const { campaignsDir, campaign } = await fixture();
    const checked = await runIndex({
      campaignsDir,
      campaign,
      check: true,
      embedder: new FakeEmbedder(16),
    });
    expect(checked.rebuilt).toBe(false);
    expect(checked.stale).toBe(true);
    expect(checked.meta).toBeUndefined();
  });

  it('--check reports staleness after a lore file changes, without rebuilding', async () => {
    const { campaignsDir, campaign } = await fixture();
    const embedder = new FakeEmbedder(16);
    const first = await runIndex({ campaignsDir, campaign, embedder });
    const lorePath = first.meta!.lorePath;
    await writeFile(
      join(lorePath, 'dm', 'avalon.md'),
      '# Avalon Artificers Academy\n\nA polished rival school north of the river, now with a fresh coat of paint on every workshop wall.\n'
    );
    const checked = await runIndex({ campaignsDir, campaign, check: true, embedder });
    expect(checked.stale).toBe(true);
    expect(checked.rebuilt).toBe(false);
    expect(checked.meta!.builtAt).toBe(first.meta!.builtAt);
    expect(formatIndexSummary(checked).join('\n')).toContain('stale');
  });
});

describe('ensureIndex', () => {
  it('skips the rebuild when the index is already fresh', async () => {
    const { campaignsDir, campaign } = await fixture();
    const embedder = new FakeEmbedder(16);
    await runIndex({ campaignsDir, campaign, embedder });
    const again = await ensureIndex({ campaignsDir, campaign, embedder });
    expect(again.rebuilt).toBe(false);
    expect(again.meta!.chunks).toBe(1);
  });

  it('rebuilds after a lore file changes', async () => {
    const { campaignsDir, campaign } = await fixture();
    const embedder = new FakeEmbedder(16);
    const first = await runIndex({ campaignsDir, campaign, embedder });
    const lorePath = first.meta!.lorePath;
    await writeFile(
      join(lorePath, 'dm', 'avalon.md'),
      '# Avalon Artificers Academy\n\nA polished rival school, rewritten here with a longer opening paragraph so the chunker keeps it.\n\n## Duel Hall\n\nThe hall where House Duel Day is fought every spring term, under a roof of salvaged airship glass.\n'
    );
    const second = await ensureIndex({ campaignsDir, campaign, embedder });
    expect(second.rebuilt).toBe(true);
    expect(second.meta!.chunks).toBe(2);
  });

  it('--force rebuilds a fresh index', async () => {
    const { campaignsDir, campaign } = await fixture();
    const embedder = new FakeEmbedder(16);
    const first = await runIndex({ campaignsDir, campaign, embedder });
    const forced = await runIndex({ campaignsDir, campaign, force: true, embedder });
    expect(forced.rebuilt).toBe(true);
    expect(forced.meta!.builtAt).not.toBe(first.meta!.builtAt);
  });
});
