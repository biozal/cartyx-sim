import { describe, expect, it } from 'vitest';
import { Persona, Premise, renderPersona, renderPersonaLine, renderPremise } from '../src/persona';

describe('Premise', () => {
  it('accepts an empty object and any subset of fields', () => {
    expect(Premise.parse({})).toEqual({});
    expect(Premise.parse({ world: 'Cartyx', tone: 'cozy' })).toEqual({
      world: 'Cartyx',
      tone: 'cozy',
    });
  });

  it('rejects a non-string field', () => {
    expect(Premise.safeParse({ world: 42 }).success).toBe(false);
  });
});

describe('renderPremise', () => {
  it('is empty when there is no premise, so a campaign without one is unchanged', () => {
    expect(renderPremise(undefined)).toBe('');
    expect(renderPremise({})).toBe('');
  });

  it('labels each field it was given and omits the rest', () => {
    const text = renderPremise({ world: 'Cartyx, a fantasy Earth.', region: 'Atlanta metro.' });
    expect(text).toContain('World: Cartyx, a fantasy Earth.');
    expect(text).toContain('Region: Atlanta metro.');
    expect(text).not.toContain('Tone:');
    expect(text).not.toContain('Party:');
  });
});

describe('Persona', () => {
  it('accepts an empty object and a full one', () => {
    expect(Persona.parse({})).toEqual({});
    const full = {
      backstory: 'b',
      motivation: 'm',
      personality: 'p',
      ties: 't',
      loreEntityIds: ['kanka-2418574'],
    };
    expect(Persona.parse(full)).toEqual(full);
  });

  it('rejects a non-string lore entity id', () => {
    expect(Persona.safeParse({ loreEntityIds: [7] }).success).toBe(false);
  });
});

describe('renderPersona', () => {
  it('is empty when absent', () => {
    expect(renderPersona(undefined)).toBe('');
    expect(renderPersona({})).toBe('');
  });

  it('labels each prose field and never prints lore ids, which are for retrieval not for reading', () => {
    const text = renderPersona({
      backstory: 'Raised in Alpharetta.',
      motivation: 'Prove the shop was not at fault.',
      loreEntityIds: ['kanka-2418574'],
    });
    expect(text).toContain('Backstory: Raised in Alpharetta.');
    expect(text).toContain('Motivation: Prove the shop was not at fault.');
    expect(text).not.toContain('Personality:');
    expect(text).not.toContain('kanka-2418574');
  });
});

describe('renderPersonaLine', () => {
  it('gives the DM one line of name, motivation and ties', () => {
    expect(
      renderPersonaLine('Kira Vale', { motivation: 'Clear her name.', ties: 'Owes Vaunt.' })
    ).toBe('- Kira Vale — Clear her name. Owes Vaunt.');
  });

  it('falls back to the name alone when there is no persona', () => {
    expect(renderPersonaLine('Kira Vale', undefined)).toBe('- Kira Vale');
    expect(renderPersonaLine('Kira Vale', {})).toBe('- Kira Vale');
  });
});
