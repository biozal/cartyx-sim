import { z } from 'zod';

/**
 * What world a campaign is set in. Every field is optional and a campaign may have no premise at
 * all, so a campaign written before this existed behaves exactly as it did. v1 design §6.1 listed
 * a bare `tone` field that was never built; this is that field, widened — a single adjective
 * cannot anchor a world.
 */
export const Premise = z.object({
  world: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  party: z.string().min(1).optional(),
  tone: z.string().min(1).optional(),
});
export type Premise = z.infer<typeof Premise>;

/**
 * Who a player character is, as opposed to what they can do. Deliberately kept out of `Combatant`,
 * which is purely mechanical and shared with monsters and NPCs.
 */
export const Persona = z.object({
  backstory: z.string().min(1).optional(),
  motivation: z.string().min(1).optional(),
  personality: z.string().min(1).optional(),
  ties: z.string().min(1).optional(),
  /** Wiki entity ids that seed ambient retrieval at session start. */
  loreEntityIds: z.array(z.string().min(1)).optional(),
});
export type Persona = z.infer<typeof Persona>;

function labelled(pairs: [string, string | undefined][]): string {
  return pairs
    .filter((pair): pair is [string, string] => pair[1] !== undefined && pair[1] !== '')
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

export function renderPremise(premise: Premise | undefined): string {
  if (!premise) return '';
  return labelled([
    ['World', premise.world],
    ['Region', premise.region],
    ['Party', premise.party],
    ['Tone', premise.tone],
  ]);
}

/**
 * A player's own persona, in full. The lore ids are not printed: they exist to seed retrieval, and
 * a model reading "kanka-2418574" learns nothing from it.
 */
export function renderPersona(persona: Persona | undefined): string {
  if (!persona) return '';
  return labelled([
    ['Backstory', persona.backstory],
    ['Motivation', persona.motivation],
    ['Personality', persona.personality],
    ['Ties', persona.ties],
  ]);
}

/** One line for the DM's party list: a DM that does not know a PC's motive cannot hook it. */
export function renderPersonaLine(name: string, persona: Persona | undefined): string {
  const parts = [persona?.motivation, persona?.ties].filter(
    (part): part is string => part !== undefined && part !== ''
  );
  return parts.length === 0 ? `- ${name}` : `- ${name} — ${parts.join(' ')}`;
}

/**
 * The text a persona's lore is looked up by: its prose, never its entity ids, which have nothing
 * to embed. Shared by the director's party lookups and `sim prep`, so both ask the index the same
 * question about a character. Empty when the persona has no prose.
 */
export function personaLoreQuery(persona: Persona): string {
  return [persona.backstory, persona.motivation, persona.ties]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' ');
}
