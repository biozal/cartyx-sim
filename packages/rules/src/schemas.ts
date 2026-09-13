import { z } from 'zod';

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export const Ability = z.enum(ABILITIES);
export type Ability = z.infer<typeof Ability>;

export const ABILITY_NAMES: Record<Ability, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};

export const SKILLS = [
  'acrobatics',
  'animalHandling',
  'arcana',
  'athletics',
  'deception',
  'history',
  'insight',
  'intimidation',
  'investigation',
  'medicine',
  'nature',
  'perception',
  'performance',
  'persuasion',
  'religion',
  'sleightOfHand',
  'stealth',
  'survival',
] as const;
export const Skill = z.enum(SKILLS);
export type Skill = z.infer<typeof Skill>;

export const SKILL_ABILITY: Record<Skill, Ability> = {
  acrobatics: 'dex',
  animalHandling: 'wis',
  arcana: 'int',
  athletics: 'str',
  deception: 'cha',
  history: 'int',
  insight: 'wis',
  intimidation: 'cha',
  investigation: 'int',
  medicine: 'wis',
  nature: 'int',
  perception: 'wis',
  performance: 'cha',
  persuasion: 'cha',
  religion: 'int',
  sleightOfHand: 'dex',
  stealth: 'dex',
  survival: 'wis',
};

export const CONDITIONS = [
  'blinded',
  'charmed',
  'deafened',
  'exhaustion',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
] as const;
export const Condition = z.enum(CONDITIONS);
export type Condition = z.infer<typeof Condition>;

const score = z.number().int().min(1).max(30);
export const AbilityScores = z.object({
  str: score,
  dex: score,
  con: score,
  int: score,
  wis: score,
  cha: score,
});
export type AbilityScores = z.infer<typeof AbilityScores>;

export const Attack = z.object({
  name: z.string().min(1),
  bonus: z.number().int(),
  damage: z.string().min(1),
  damageType: z.string().min(1),
});
export type Attack = z.infer<typeof Attack>;

export const SpellSlot = z.object({
  level: z.number().int().min(1).max(9),
  max: z.number().int().min(0),
  used: z.number().int().min(0),
});
export type SpellSlot = z.infer<typeof SpellSlot>;

export const InventoryItem = z.object({
  name: z.string().min(1),
  quantity: z.number().int().min(1),
});
export type InventoryItem = z.infer<typeof InventoryItem>;

export const Combatant = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'ids are lowercase kebab-case'),
  name: z.string().min(1),
  kind: z.enum(['pc', 'npc', 'monster']),
  level: z.number().int().min(1).max(20),
  abilities: AbilityScores,
  proficiencyBonus: z.number().int().min(2).max(9),
  saveProficiencies: z.array(Ability).default([]),
  skillProficiencies: z.array(Skill).default([]),
  skillExpertise: z.array(Skill).default([]),
  ac: z.number().int().min(1),
  maxHp: z.number().int().min(1),
  hp: z.number().int().min(0),
  tempHp: z.number().int().min(0).default(0),
  conditions: z.array(Condition).default([]),
  dead: z.boolean().default(false),
  spellSlots: z.array(SpellSlot).default([]),
  attacks: z.array(Attack).default([]),
  inventory: z.array(InventoryItem).default([]),
});
export type Combatant = z.output<typeof Combatant>;
export type CombatantInput = z.input<typeof Combatant>;

export const InitiativeEntry = z.object({
  combatantId: z.string(),
  roll: z.number().int(),
  dexMod: z.number().int(),
  total: z.number().int(),
});
export type InitiativeEntry = z.infer<typeof InitiativeEntry>;
