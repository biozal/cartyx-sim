import { rollD20, type D20Roll, type RollMode } from './dice';
import type { Rng } from './rng';
import { ABILITY_NAMES, SKILL_ABILITY, type Ability, type Combatant, type Skill } from './schemas';

export type CheckSpec =
  | { type: 'ability'; ability: Ability }
  | { type: 'skill'; skill: Skill }
  | { type: 'save'; ability: Ability };

export interface CheckResult {
  spec: CheckSpec;
  label: string;
  d20: D20Roll;
  modifier: number;
  total: number;
  dc: number;
  success: boolean;
}

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function proficiencyBonusForLevel(level: number): number {
  return Math.ceil(level / 4) + 1;
}

function skillName(skill: Skill): string {
  const spaced = skill.replace(/([A-Z])/g, ' $1');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function checkLabel(spec: CheckSpec): string {
  switch (spec.type) {
    case 'ability':
      return `${ABILITY_NAMES[spec.ability]} check`;
    case 'save':
      return `${ABILITY_NAMES[spec.ability]} save`;
    case 'skill':
      return `${skillName(spec.skill)} check`;
  }
}

export function checkModifier(combatant: Combatant, spec: CheckSpec): number {
  switch (spec.type) {
    case 'ability':
      return abilityModifier(combatant.abilities[spec.ability]);
    case 'save': {
      const proficient = combatant.saveProficiencies.includes(spec.ability);
      return (
        abilityModifier(combatant.abilities[spec.ability]) +
        (proficient ? combatant.proficiencyBonus : 0)
      );
    }
    case 'skill': {
      const base = abilityModifier(combatant.abilities[SKILL_ABILITY[spec.skill]]);
      if (combatant.skillExpertise.includes(spec.skill)) {
        return base + 2 * combatant.proficiencyBonus;
      }
      if (combatant.skillProficiencies.includes(spec.skill)) {
        return base + combatant.proficiencyBonus;
      }
      return base;
    }
  }
}

/** Ability checks and saves succeed when total >= DC; natural 20s and 1s have no special effect. */
export function resolveCheck(
  combatant: Combatant,
  spec: CheckSpec,
  dc: number,
  rng: Rng,
  mode: RollMode = 'normal'
): CheckResult {
  const d20 = rollD20(rng, mode);
  const modifier = checkModifier(combatant, spec);
  const total = d20.natural + modifier;
  return { spec, label: checkLabel(spec), d20, modifier, total, dc, success: total >= dc };
}
