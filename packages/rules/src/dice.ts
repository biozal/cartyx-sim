import { RulesError } from './errors';
import type { Rng } from './rng';

export interface DiceTerm {
  count: number;
  sides: number;
}

export interface DiceExpr {
  terms: DiceTerm[];
  modifier: number;
}

export interface DiceResult {
  expr: string;
  rolls: number[];
  modifier: number;
  total: number;
}

export type RollMode = 'normal' | 'advantage' | 'disadvantage';

export interface D20Roll {
  rolls: number[];
  natural: number;
  mode: RollMode;
}

const VALID = /^(\d*d\d+|\d+)([+-](\d*d\d+|\d+))*$/;
const TOKEN = /([+-]?)(\d*d\d+|\d+)/g;
const DICE_TERM = /^(\d*)d(\d+)$/;

/** Parses expressions like "2d6+3", "d20", "1d8+1d6-2", or "5". */
export function parseDice(expr: string): DiceExpr {
  const compact = expr.replace(/\s+/g, '').toLowerCase();
  if (!VALID.test(compact)) {
    throw new RulesError(`Invalid dice expression "${expr}"`);
  }
  const terms: DiceTerm[] = [];
  let modifier = 0;
  for (const [, sign, body = ''] of compact.matchAll(TOKEN)) {
    const dice = DICE_TERM.exec(body);
    if (!dice) {
      modifier += (sign === '-' ? -1 : 1) * Number(body);
      continue;
    }
    if (sign === '-') {
      throw new RulesError(`Subtracted dice are not supported in "${expr}"`);
    }
    const count = dice[1] === '' ? 1 : Number(dice[1]);
    const sides = Number(dice[2]);
    if (count < 1 || count > 100 || sides < 2 || sides > 1000) {
      throw new RulesError(`Invalid dice term "${body}" in "${expr}"`);
    }
    terms.push({ count, sides });
  }
  return { terms, modifier };
}

/** Rolls a damage/healing expression. A critical doubles the dice, not the modifier. Never below 0. */
export function rollDice(
  expr: string,
  rng: Rng,
  options: { critical?: boolean } = {},
): DiceResult {
  const { terms, modifier } = parseDice(expr);
  const multiplier = options.critical ? 2 : 1;
  const rolls = terms.flatMap((term) =>
    Array.from({ length: term.count * multiplier }, () => rng.die(term.sides))
  );
  const total = Math.max(0, rolls.reduce((sum, roll) => sum + roll, 0) + modifier);
  return { expr, rolls, modifier, total };
}

export function rollD20(rng: Rng, mode: RollMode = 'normal'): D20Roll {
  if (mode === 'normal') {
    const roll = rng.die(20);
    return { rolls: [roll], natural: roll, mode };
  }
  const rolls = [rng.die(20), rng.die(20)];
  const natural = mode === 'advantage' ? Math.max(...rolls) : Math.min(...rolls);
  return { rolls, natural, mode };
}

export function formatModifier(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}
