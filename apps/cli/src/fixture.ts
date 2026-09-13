import { readFile } from 'node:fs/promises';
import { LoreHit, ModelResponse } from '@cartyx-sim/core';
import { Combatant } from '@cartyx-sim/rules';
import { z } from 'zod';

/** A fully scripted session: party, seats, lore, optional dice, and every model response per seat. */
export const Fixture = z.object({
  loreCommit: z.string().default('fixture'),
  targetMinutes: z.number().positive(),
  party: z.array(Combatant).min(1),
  seats: z.object({
    dm: z.string().min(1),
    players: z.record(z.string(), z.string().min(1)),
  }),
  lore: z.array(LoreHit).default([]),
  dice: z.array(z.number().int().min(1)).optional(),
  script: z.record(
    z.string(),
    // The throw form is listed first: ModelResponse's defaults would otherwise accept it.
    z.array(z.union([z.object({ throw: z.string().min(1) }), ModelResponse]))
  ),
});
export type Fixture = z.output<typeof Fixture>;

export async function loadFixture(path: string): Promise<Fixture> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  const parsed = Fixture.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid fixture ${path}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
