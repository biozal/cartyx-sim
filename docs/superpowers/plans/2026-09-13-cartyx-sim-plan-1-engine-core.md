# cartyx-sim Plan 1 — Engine Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the model-free heart of the simulator — 5e bookkeeping rules, the event log contract, the state projection, the tool layer, validators, the session clock, and the director turn loop — and prove it end to end by running a scripted session from the `sim run` CLI into `events.jsonl`.

**Architecture:** An npm-workspaces TypeScript monorepo. `packages/rules` is pure 5e bookkeeping over a Zod `Combatant` schema. `packages/core` is pure engine logic behind interfaces (`ModelClient`, `LoreIndex`, `EventSink`, `PromptBuilder`, `Rng`): models act only through typed tools, every effect becomes a validated `SimEvent`, each turn is buffered by a `TurnRecorder` and committed atomically, and `GameState` is a fold over the log. `apps/cli` wires the director to a JSONL file sink and scripted fixtures. Real models, lore retrieval, and SRD data arrive in Plan 2.

**Tech Stack:** Node ≥ 22.22 (verified on 26.8), TypeScript 7.0.2, Vitest 5.0.0, Zod 4.6.4, tsx 4.23.13, Commander 15.0.0, Prettier 3.9.6.

**Spec:** `docs/superpowers/specs/2026-09-13-cartyx-sim-v1-design.md` (roadmap and spec deviations: `docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md`)

## Global Constraints

- Language: TypeScript everywhere; ES modules (`"type": "module"`); `module: preserve`, `moduleResolution: bundler`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Workspace packages export `./src/*.ts` directly and run through `tsx`/Vitest — there is no build step.
- `packages/core` must not import `node:*` modules or touch the network or filesystem directly (it must stay embeddable in `cartyx-app`). Only `apps/cli` does I/O.
- The event log is the single source of truth. Every state change is a `SimEvent`; `GameState` is only ever derived by folding events.
- All dice go through an `Rng`. Tests use `scriptedRng`; nothing in `rules` or `core` calls `Math.random`.
- Mechanics are SRD-only (spec §3.2). Plan 1 has no SRD data yet: the DM supplies monster stat blocks and spell details as tool arguments.
- Tools must finish every check that can fail before their first `recorder.emit`, so a rejected call leaves no partial events.
- Formatting follows the cartyx-app Prettier config: single quotes, semicolons, 2-space indent, `trailingComma: es5`, `printWidth: 100`.
- Pin dependency versions to the ones above. `campaigns/` and `.cache/` stay git-ignored.
- Do not commit or push until the user has approved commits for this repository.

## File Structure

```
package.json                  workspace root, scripts
tsconfig.json                 one typecheck over every package
vitest.config.ts              runs packages/*/test and apps/*/test
.prettierrc
packages/rules/
  src/errors.ts               RulesError
  src/rng.ts                  Rng + seeded/secure/scripted generators
  src/dice.ts                 dice expressions, d20 with advantage
  src/schemas.ts              Combatant and related Zod schemas
  src/checks.ts               ability/skill checks and saves
  src/hp.ts                   damage, healing, conditions
  src/combat.ts               attack rolls and criticals
  src/slots.ts                spell slots
  src/inventory.ts            items
  src/initiative.ts           initiative order
  src/testing.ts              makeCombatant (tests and fixtures)
  src/index.ts
packages/core/
  src/text.ts                 word counts, slugs
  src/events.ts               SimEvent — the event log contract
  src/state.ts                GameState reducer, turn scheduling helpers
  src/recorder.ts             TurnRecorder (per-turn buffer)
  src/sink.ts                 EventSink, MemorySink
  src/clock.ts                spoken-runtime session clock
  src/model.ts                ModelClient and LoreIndex interfaces
  src/transcript.ts           audience-filtered transcripts
  src/validators.ts           table-rule validators
  src/tools/types.ts          tool framework
  src/tools/narrative.ts      narrate, NPCs, scenes, lore, hand_off
  src/tools/mechanics.ts      checks, attacks, spells
  src/tools/state-tools.ts    damage, healing, conditions, items
  src/tools/combat.ts         start_combat, end_combat
  src/tools/player.ts         speak, act, interject, declare_spell, pass
  src/tools/registry.ts       DM_TOOLS, PLAYER_TOOLS
  src/prompts.ts              PromptBuilder, basicPrompts
  src/director.ts             Director turn loop
  src/testing.ts              ScriptedModelClient, StaticLoreIndex
  src/index.ts
apps/cli/
  src/jsonl-sink.ts           JSONL EventSink with fsync per turn
  src/paths.ts                campaign/session paths
  src/fixture.ts              scripted fixture schema
  src/run.ts                  runSession
  src/main.ts                 `sim` command
  fixtures/demo-session.json
```

---

### Task 1: Workspace scaffold, RNG, and dice

Create the npm workspace and the first `rules` modules: pluggable RNG and dice expressions.

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.prettierrc`
- Create: `packages/rules/package.json`
- Create: `packages/rules/src/errors.ts`
- Create: `packages/rules/src/rng.ts`
- Create: `packages/rules/src/dice.ts`
- Test: `packages/rules/test/rng.test.ts`
- Test: `packages/rules/test/dice.test.ts`

**Interfaces:**

- Consumes: Nothing.
- Produces:
  - `interface Rng { die(sides: number): number }`; `seededRng(seed)`, `secureRng()`, `scriptedRng(values)`
  - `parseDice(expr): DiceExpr`, `rollDice(expr, rng, { critical? }): DiceResult` (`{ expr, rolls, modifier, total }`)
  - `type RollMode = 'normal' | 'advantage' | 'disadvantage'`; `rollD20(rng, mode): D20Roll` (`{ rolls, natural, mode }`); `formatModifier(n)`
  - `class RulesError extends Error` — every rules violation a model can correct

- [ ] **Step 1: Create the package configuration**

`package.json`

```json
{
  "name": "cartyx-sim",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.22.0"
  },
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json",
    "format": "prettier --write .",
    "sim": "tsx apps/cli/src/main.ts"
  }
}
```

`tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["packages/*/src", "packages/*/test", "apps/*/src", "apps/*/test", "vitest.config.ts"]
}
```

`vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
});
```

`.prettierrc`

```
{
  "singleQuote": true,
  "semi": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100,
  "arrowParens": "always"
}
```

`packages/rules/package.json`

```json
{
  "name": "@cartyx-sim/rules",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts"
  },
  "dependencies": {
    "zod": "^4.6.4"
  }
}
```

- [ ] **Step 2: Install the pinned toolchain (this also installs `zod` for the rules workspace and adds `devDependencies` to the root `package.json`)**

Run: `npm install -D typescript@7.0.2 vitest@5.0.0 tsx@4.23.13 prettier@3.9.6 @types/node@26.5.1`
Expected: install completes with no errors.

- [ ] **Step 3: Write the failing tests**

`packages/rules/test/rng.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { scriptedRng, secureRng, seededRng } from '../src/rng';

function rollMany(die: (sides: number) => number, sides: number, count: number): number[] {
  return Array.from({ length: count }, () => die(sides));
}

describe('seededRng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    expect(rollMany((s) => a.die(s), 20, 50)).toEqual(rollMany((s) => b.die(s), 20, 50));
  });

  it('produces different sequences for different seeds', () => {
    const a = seededRng(1);
    const b = seededRng(2);
    expect(rollMany((s) => a.die(s), 20, 20)).not.toEqual(rollMany((s) => b.die(s), 20, 20));
  });

  it('stays within 1..sides and reaches both ends', () => {
    const rng = seededRng(7);
    const rolls = rollMany((s) => rng.die(s), 6, 2000);
    expect(Math.min(...rolls)).toBe(1);
    expect(Math.max(...rolls)).toBe(6);
  });
});

describe('secureRng', () => {
  it('stays within 1..sides', () => {
    const rng = secureRng();
    const rolls = rollMany((s) => rng.die(s), 20, 2000);
    expect(Math.min(...rolls)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...rolls)).toBeLessThanOrEqual(20);
  });
});

describe('scriptedRng', () => {
  it('returns the scripted values in order', () => {
    const rng = scriptedRng([3, 18]);
    expect(rng.die(6)).toBe(3);
    expect(rng.die(20)).toBe(18);
  });

  it('throws when exhausted', () => {
    const rng = scriptedRng([1]);
    rng.die(4);
    expect(() => rng.die(4)).toThrow('scriptedRng exhausted after 1 rolls');
  });

  it('rejects values that do not fit the die', () => {
    expect(() => scriptedRng([7]).die(6)).toThrow('out of range for d6');
  });
});
```

`packages/rules/test/dice.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { formatModifier, parseDice, rollD20, rollDice } from '../src/dice';
import { RulesError } from '../src/errors';
import { scriptedRng } from '../src/rng';

describe('parseDice', () => {
  it('parses dice with a modifier', () => {
    expect(parseDice('2d6+3')).toEqual({ terms: [{ count: 2, sides: 6 }], modifier: 3 });
  });

  it('treats a bare "d20" as one die and ignores spaces and case', () => {
    expect(parseDice(' D20 ')).toEqual({ terms: [{ count: 1, sides: 20 }], modifier: 0 });
  });

  it('parses multiple terms and negative flat modifiers', () => {
    expect(parseDice('1d8+1d6-2')).toEqual({
      terms: [
        { count: 1, sides: 8 },
        { count: 1, sides: 6 },
      ],
      modifier: -2,
    });
  });

  it('parses a flat number', () => {
    expect(parseDice('5')).toEqual({ terms: [], modifier: 5 });
  });

  it.each(['', '2x6', 'd1', '-1d4', '1d4-1d6', '1d', '0d6'])('rejects "%s"', (expr) => {
    expect(() => parseDice(expr)).toThrow(RulesError);
  });
});

describe('rollDice', () => {
  it('sums the dice and the modifier', () => {
    expect(rollDice('2d6+3', scriptedRng([3, 5]))).toEqual({
      expr: '2d6+3',
      rolls: [3, 5],
      modifier: 3,
      total: 11,
    });
  });

  it('doubles the dice but not the modifier on a critical', () => {
    const result = rollDice('1d8+2', scriptedRng([4, 6]), { critical: true });
    expect(result.rolls).toEqual([4, 6]);
    expect(result.total).toBe(12);
  });

  it('never returns a negative total', () => {
    expect(rollDice('1d4-5', scriptedRng([1])).total).toBe(0);
  });
});

describe('rollD20', () => {
  it('rolls once in normal mode', () => {
    expect(rollD20(scriptedRng([11]))).toEqual({ rolls: [11], natural: 11, mode: 'normal' });
  });

  it('keeps the higher roll with advantage', () => {
    expect(rollD20(scriptedRng([5, 17]), 'advantage').natural).toBe(17);
  });

  it('keeps the lower roll with disadvantage', () => {
    expect(rollD20(scriptedRng([5, 17]), 'disadvantage').natural).toBe(5);
  });
});

describe('formatModifier', () => {
  it('always shows a sign', () => {
    expect(formatModifier(3)).toBe('+3');
    expect(formatModifier(0)).toBe('+0');
    expect(formatModifier(-1)).toBe('-1');
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run packages/rules/test/rng.test.ts packages/rules/test/dice.test.ts`
Expected: FAIL — Vitest cannot resolve `../src/rng` because the implementation does not exist yet.

- [ ] **Step 5: Write the implementation**

`packages/rules/src/errors.ts`

```ts
/** A rules violation that can be reported back to a model, e.g. "no spell slot left". */
export class RulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesError';
  }
}
```

`packages/rules/src/rng.ts`

```ts
/** Source of die rolls. Every roll in the engine goes through an Rng so tests can script it. */
export interface Rng {
  /** Returns an integer in [1, sides]. */
  die(sides: number): number;
}

/** Deterministic mulberry32 generator, for reproducible runs (`--seed`). */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    die(sides) {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return 1 + Math.floor(unit * sides);
    },
  };
}

/** Unbiased cryptographic dice; the default for real sessions. */
export function secureRng(): Rng {
  const buffer = new Uint32Array(1);
  return {
    die(sides) {
      const limit = Math.floor(0x100000000 / sides) * sides;
      let value: number;
      do {
        crypto.getRandomValues(buffer);
        value = buffer[0]!;
      } while (value >= limit);
      return 1 + (value % sides);
    },
  };
}

/** Returns the given values in order; throws when exhausted or when a value cannot fit the die. */
export function scriptedRng(values: readonly number[]): Rng {
  let index = 0;
  return {
    die(sides) {
      const value = values[index];
      if (value === undefined) {
        throw new Error(`scriptedRng exhausted after ${values.length} rolls`);
      }
      if (value < 1 || value > sides) {
        throw new Error(`scriptedRng value ${value} is out of range for d${sides}`);
      }
      index++;
      return value;
    },
  };
}
```

`packages/rules/src/dice.ts`

```ts
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
    if (count < 1 || count > 100 || sides < 2) {
      throw new RulesError(`Invalid dice term "${body}" in "${expr}"`);
    }
    terms.push({ count, sides });
  }
  return { terms, modifier };
}

/** Rolls a damage/healing expression. A critical doubles the dice, not the modifier. Never below 0. */
export function rollDice(expr: string, rng: Rng, options: { critical?: boolean } = {}): DiceResult {
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/rules/test/rng.test.ts packages/rules/test/dice.test.ts`
Expected: PASS — 25 tests across 2 file(s).

- [ ] **Step 7: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: `tsc` reports no errors and every test passes.

- [ ] **Step 8: Commit** (only once the user has approved commits)

```bash
git add package.json \
  tsconfig.json \
  vitest.config.ts \
  .prettierrc \
  packages/rules/package.json \
  packages/rules/src/errors.ts \
  packages/rules/src/rng.ts \
  packages/rules/src/dice.ts \
  packages/rules/test/rng.test.ts \
  packages/rules/test/dice.test.ts \
  package-lock.json
git commit -m "feat(rules): scaffold workspace with RNG and dice expressions"
```

### Task 2: Combatant schema and ability checks

Define the combatant data model (the shape of every PC, NPC, and monster) and resolve checks and saves.

**Files:**

- Create: `packages/rules/src/schemas.ts`
- Create: `packages/rules/src/checks.ts`
- Create: `packages/rules/src/testing.ts`
- Test: `packages/rules/test/checks.test.ts`

**Interfaces:**

- Consumes: `rollD20`, `RollMode`, `Rng` from Task 1.
- Produces:
  - Zod schemas and types: `Ability`, `Skill`, `Condition`, `AbilityScores`, `Attack`, `SpellSlot`, `InventoryItem`, `Combatant` (+ `CombatantInput`), `InitiativeEntry`; constants `ABILITIES`, `SKILLS`, `CONDITIONS`, `ABILITY_NAMES`, `SKILL_ABILITY`
  - `type CheckSpec = { type: 'ability'; ability } | { type: 'skill'; skill } | { type: 'save'; ability }`
  - `resolveCheck(combatant, spec, dc, rng, mode?): CheckResult` (`{ spec, label, d20, modifier, total, dc, success }`); `checkModifier`, `checkLabel`, `abilityModifier`, `proficiencyBonusForLevel`
  - `makeCombatant(overrides & { id })` exported from `@cartyx-sim/rules/testing`

- [ ] **Step 1: Write the failing tests**

`packages/rules/test/checks.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  abilityModifier,
  checkLabel,
  checkModifier,
  proficiencyBonusForLevel,
  resolveCheck,
} from '../src/checks';
import { scriptedRng } from '../src/rng';
import { makeCombatant } from '../src/testing';

const kira = makeCombatant({
  id: 'kira',
  name: 'Kira Vale',
  abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 12, cha: 10 },
  proficiencyBonus: 2,
  saveProficiencies: ['int'],
  skillProficiencies: ['investigation'],
  skillExpertise: ['arcana'],
});

describe('abilityModifier', () => {
  it.each([
    [1, -5],
    [8, -1],
    [10, 0],
    [11, 0],
    [16, 3],
    [20, 5],
  ])('score %i gives %i', (score, modifier) => {
    expect(abilityModifier(score)).toBe(modifier);
  });
});

describe('proficiencyBonusForLevel', () => {
  it.each([
    [1, 2],
    [4, 2],
    [5, 3],
    [9, 4],
    [17, 6],
  ])('level %i gives +%i', (level, bonus) => {
    expect(proficiencyBonusForLevel(level)).toBe(bonus);
  });
});

describe('checkModifier', () => {
  it('uses the raw ability modifier for ability checks', () => {
    expect(checkModifier(kira, { type: 'ability', ability: 'str' })).toBe(-1);
  });

  it('adds proficiency to proficient skills', () => {
    expect(checkModifier(kira, { type: 'skill', skill: 'investigation' })).toBe(5);
  });

  it('adds double proficiency for expertise', () => {
    expect(checkModifier(kira, { type: 'skill', skill: 'arcana' })).toBe(7);
  });

  it('adds nothing for untrained skills', () => {
    expect(checkModifier(kira, { type: 'skill', skill: 'stealth' })).toBe(2);
  });

  it('adds proficiency only to proficient saves', () => {
    expect(checkModifier(kira, { type: 'save', ability: 'int' })).toBe(5);
    expect(checkModifier(kira, { type: 'save', ability: 'wis' })).toBe(1);
  });
});

describe('checkLabel', () => {
  it('names checks and saves for the transcript', () => {
    expect(checkLabel({ type: 'skill', skill: 'sleightOfHand' })).toBe('Sleight Of Hand check');
    expect(checkLabel({ type: 'save', ability: 'dex' })).toBe('Dexterity save');
    expect(checkLabel({ type: 'ability', ability: 'str' })).toBe('Strength check');
  });
});

describe('resolveCheck', () => {
  it('succeeds when the total meets the DC', () => {
    const result = resolveCheck(
      kira,
      { type: 'skill', skill: 'investigation' },
      13,
      scriptedRng([8])
    );
    expect(result.total).toBe(13);
    expect(result.success).toBe(true);
  });

  it('fails below the DC, even on a natural 20 with a low total', () => {
    const weak = makeCombatant({
      id: 'weak',
      abilities: { str: 1, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    });
    const result = resolveCheck(weak, { type: 'ability', ability: 'str' }, 25, scriptedRng([20]));
    expect(result.total).toBe(15);
    expect(result.success).toBe(false);
  });

  it('applies advantage', () => {
    const result = resolveCheck(
      kira,
      { type: 'ability', ability: 'int' },
      15,
      scriptedRng([3, 12]),
      'advantage'
    );
    expect(result.d20.rolls).toEqual([3, 12]);
    expect(result.total).toBe(15);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/rules/test/checks.test.ts`
Expected: FAIL — Vitest cannot resolve `../src/checks` because the implementation does not exist yet.

- [ ] **Step 3: Write the implementation**

`packages/rules/src/schemas.ts`

```ts
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
```

`packages/rules/src/checks.ts`

```ts
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
```

`packages/rules/src/testing.ts`

```ts
import { Combatant, type CombatantInput } from './schemas';

/** Builds a valid combatant with plain defaults (all abilities 10, AC 10, 10 HP) for tests and fixtures. */
export function makeCombatant(
  overrides: Partial<CombatantInput> & Pick<CombatantInput, 'id'>
): Combatant {
  return Combatant.parse({
    name: overrides.id,
    kind: 'pc',
    level: 1,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    proficiencyBonus: 2,
    ac: 10,
    maxHp: 10,
    hp: 10,
    ...overrides,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/rules/test/checks.test.ts`
Expected: PASS — 20 tests across 1 file(s).

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: `tsc` reports no errors and every test passes.

- [ ] **Step 6: Commit** (only once the user has approved commits)

```bash
git add packages/rules/src/schemas.ts \
  packages/rules/src/checks.ts \
  packages/rules/src/testing.ts \
  packages/rules/test/checks.test.ts
git commit -m "feat(rules): add combatant schema and ability checks"
```

### Task 3: Hit points, conditions, and attacks

Apply damage and healing with 5e death rules, manage conditions, and resolve attack rolls with criticals.

**Files:**

- Create: `packages/rules/src/hp.ts`
- Create: `packages/rules/src/combat.ts`
- Test: `packages/rules/test/hp.test.ts`
- Test: `packages/rules/test/combat.test.ts`

**Interfaces:**

- Consumes: `Combatant`, `Attack`, `Condition` (Task 2); `rollD20`, `rollDice`, `RulesError` (Task 1).
- Produces:
  - `applyDamage(c, amount)`, `applyHealing(c, amount)`, `addCondition(c, condition)`, `removeCondition(c, condition)` — all pure, returning a new `Combatant`
  - `rollAttack(attack, target, rng, mode?)`, `resolveAttack(attacker, target, attackName, rng, mode?)`, `findAttack(c, name)` → `AttackResult` (`{ attack, d20, total, targetAc, hit, critical, damage, target }`, where `target` is the post-damage combatant)

- [ ] **Step 1: Write the failing tests**

`packages/rules/test/hp.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { RulesError } from '../src/errors';
import { addCondition, applyDamage, applyHealing, removeCondition } from '../src/hp';
import { makeCombatant } from '../src/testing';

describe('applyDamage', () => {
  it('spends temp HP before HP', () => {
    const pc = makeCombatant({ id: 'pc', hp: 10, maxHp: 10, tempHp: 3 });
    const hurt = applyDamage(pc, 5);
    expect(hurt.tempHp).toBe(0);
    expect(hurt.hp).toBe(8);
  });

  it('kills a monster at 0 HP', () => {
    const goblin = makeCombatant({ id: 'goblin', kind: 'monster', hp: 5, maxHp: 7 });
    const result = applyDamage(goblin, 9);
    expect(result.hp).toBe(0);
    expect(result.dead).toBe(true);
  });

  it('knocks a PC unconscious at 0 HP', () => {
    const pc = makeCombatant({ id: 'pc', hp: 4, maxHp: 10 });
    const result = applyDamage(pc, 6);
    expect(result.hp).toBe(0);
    expect(result.dead).toBe(false);
    expect(result.conditions).toContain('unconscious');
  });

  it('kills a PC outright on massive damage', () => {
    const pc = makeCombatant({ id: 'pc', hp: 4, maxHp: 10 });
    expect(applyDamage(pc, 14).dead).toBe(true);
  });

  it('rejects negative or fractional damage and damage to the dead', () => {
    const pc = makeCombatant({ id: 'pc' });
    expect(() => applyDamage(pc, -1)).toThrow(RulesError);
    expect(() => applyDamage(pc, 1.5)).toThrow(RulesError);
    expect(() => applyDamage({ ...pc, dead: true }, 1)).toThrow('already dead');
  });

  it('does not mutate the input', () => {
    const pc = makeCombatant({ id: 'pc', hp: 10 });
    applyDamage(pc, 3);
    expect(pc.hp).toBe(10);
  });
});

describe('applyHealing', () => {
  it('caps at max HP', () => {
    const pc = makeCombatant({ id: 'pc', hp: 8, maxHp: 10 });
    expect(applyHealing(pc, 5).hp).toBe(10);
  });

  it('wakes an unconscious PC', () => {
    const down = makeCombatant({ id: 'pc', hp: 0, maxHp: 10, conditions: ['unconscious'] });
    const healed = applyHealing(down, 3);
    expect(healed.hp).toBe(3);
    expect(healed.conditions).not.toContain('unconscious');
  });

  it('cannot heal the dead', () => {
    const corpse = makeCombatant({ id: 'pc', hp: 0, dead: true });
    expect(() => applyHealing(corpse, 5)).toThrow('dead and cannot be healed');
  });
});

describe('conditions', () => {
  it('adds a condition once', () => {
    const pc = makeCombatant({ id: 'pc' });
    const poisoned = addCondition(addCondition(pc, 'poisoned'), 'poisoned');
    expect(poisoned.conditions).toEqual(['poisoned']);
  });

  it('removes a condition', () => {
    const pc = makeCombatant({ id: 'pc', conditions: ['prone', 'poisoned'] });
    expect(removeCondition(pc, 'prone').conditions).toEqual(['poisoned']);
  });
});
```

`packages/rules/test/combat.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { resolveAttack, rollAttack } from '../src/combat';
import { RulesError } from '../src/errors';
import { scriptedRng } from '../src/rng';
import { makeCombatant } from '../src/testing';

const fighter = makeCombatant({
  id: 'fighter',
  attacks: [{ name: 'Longsword', bonus: 5, damage: '1d8+3', damageType: 'slashing' }],
});
const goblin = makeCombatant({ id: 'goblin', kind: 'monster', ac: 15, hp: 7, maxHp: 7 });

describe('resolveAttack', () => {
  it('hits when the total meets AC and applies damage', () => {
    const result = resolveAttack(fighter, goblin, 'longsword', scriptedRng([10, 2]));
    expect(result.total).toBe(15);
    expect(result.hit).toBe(true);
    expect(result.critical).toBe(false);
    expect(result.damage?.total).toBe(5);
    expect(result.target.hp).toBe(2);
  });

  it('misses below AC and leaves the target unchanged', () => {
    const result = resolveAttack(fighter, goblin, 'Longsword', scriptedRng([9]));
    expect(result.hit).toBe(false);
    expect(result.damage).toBeNull();
    expect(result.target).toBe(goblin);
  });

  it('always misses on a natural 1', () => {
    const sure = makeCombatant({
      id: 'sure',
      attacks: [{ name: 'Blade', bonus: 30, damage: '1d4', damageType: 'slashing' }],
    });
    expect(resolveAttack(sure, goblin, 'Blade', scriptedRng([1])).hit).toBe(false);
  });

  it('always hits on a natural 20 and doubles the damage dice', () => {
    const armored = makeCombatant({ id: 'armored', kind: 'monster', ac: 30, hp: 40, maxHp: 40 });
    const result = resolveAttack(fighter, armored, 'Longsword', scriptedRng([20, 4, 6]));
    expect(result.hit).toBe(true);
    expect(result.critical).toBe(true);
    expect(result.damage?.total).toBe(13);
    expect(result.target.hp).toBe(27);
  });

  it('lists known attacks when the name is wrong', () => {
    expect(() => resolveAttack(fighter, goblin, 'Axe', scriptedRng([10]))).toThrow(
      'Known attacks: Longsword'
    );
  });

  it('refuses to attack the dead', () => {
    const corpse = { ...goblin, hp: 0, dead: true };
    expect(() => rollAttack(fighter.attacks[0]!, corpse, scriptedRng([10]))).toThrow(RulesError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/rules/test/hp.test.ts packages/rules/test/combat.test.ts`
Expected: FAIL — Vitest cannot resolve `../src/hp` because the implementation does not exist yet.

- [ ] **Step 3: Write the implementation**

`packages/rules/src/hp.ts`

```ts
import { RulesError } from './errors';
import type { Combatant, Condition } from './schemas';

function assertAmount(kind: string, amount: number): void {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RulesError(`${kind} must be a non-negative integer, got ${amount}`);
  }
}

export function addCondition(combatant: Combatant, condition: Condition): Combatant {
  if (combatant.conditions.includes(condition)) return combatant;
  return { ...combatant, conditions: [...combatant.conditions, condition] };
}

export function removeCondition(combatant: Combatant, condition: Condition): Combatant {
  return { ...combatant, conditions: combatant.conditions.filter((c) => c !== condition) };
}

/**
 * Temp HP absorbs damage first. At 0 HP, monsters and NPCs die; PCs fall unconscious unless the
 * damage left over after reaching 0 is at least their max HP (massive damage).
 */
export function applyDamage(combatant: Combatant, amount: number): Combatant {
  assertAmount('Damage', amount);
  if (combatant.dead) throw new RulesError(`${combatant.name} is already dead`);
  const absorbed = Math.min(combatant.tempHp, amount);
  const remaining = amount - absorbed;
  const hp = Math.max(0, combatant.hp - remaining);
  const next: Combatant = { ...combatant, tempHp: combatant.tempHp - absorbed, hp };
  if (hp > 0) return next;
  const overflow = remaining - combatant.hp;
  if (combatant.kind !== 'pc' || overflow >= combatant.maxHp) return { ...next, dead: true };
  return addCondition(next, 'unconscious');
}

export function applyHealing(combatant: Combatant, amount: number): Combatant {
  assertAmount('Healing', amount);
  if (combatant.dead) throw new RulesError(`${combatant.name} is dead and cannot be healed`);
  const hp = Math.min(combatant.maxHp, combatant.hp + amount);
  const healed: Combatant = { ...combatant, hp };
  return combatant.hp === 0 && hp > 0 ? removeCondition(healed, 'unconscious') : healed;
}
```

`packages/rules/src/combat.ts`

```ts
import { rollD20, rollDice, type D20Roll, type DiceResult, type RollMode } from './dice';
import { RulesError } from './errors';
import { applyDamage } from './hp';
import type { Rng } from './rng';
import type { Attack, Combatant } from './schemas';

export interface AttackResult {
  attack: Attack;
  d20: D20Roll;
  total: number;
  targetAc: number;
  hit: boolean;
  critical: boolean;
  damage: DiceResult | null;
  /** The target after damage was applied (unchanged on a miss). */
  target: Combatant;
}

export function findAttack(combatant: Combatant, name: string): Attack {
  const attack = combatant.attacks.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!attack) {
    const known = combatant.attacks.map((a) => a.name).join(', ') || 'none';
    throw new RulesError(
      `${combatant.name} has no attack named "${name}". Known attacks: ${known}`
    );
  }
  return attack;
}

/** Natural 20 always hits and doubles damage dice; natural 1 always misses. */
export function rollAttack(
  attack: Attack,
  target: Combatant,
  rng: Rng,
  mode: RollMode = 'normal'
): AttackResult {
  if (target.dead) throw new RulesError(`${target.name} is already dead`);
  const d20 = rollD20(rng, mode);
  const total = d20.natural + attack.bonus;
  const critical = d20.natural === 20;
  const hit = critical || (d20.natural !== 1 && total >= target.ac);
  const base = { attack, d20, total, targetAc: target.ac, hit, critical };
  if (!hit) return { ...base, damage: null, target };
  const damage = rollDice(attack.damage, rng, { critical });
  return { ...base, damage, target: applyDamage(target, damage.total) };
}

export function resolveAttack(
  attacker: Combatant,
  target: Combatant,
  attackName: string,
  rng: Rng,
  mode: RollMode = 'normal'
): AttackResult {
  return rollAttack(findAttack(attacker, attackName), target, rng, mode);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/rules/test/hp.test.ts packages/rules/test/combat.test.ts`
Expected: PASS — 17 tests across 2 file(s).

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: `tsc` reports no errors and every test passes.

- [ ] **Step 6: Commit** (only once the user has approved commits)

```bash
git add packages/rules/src/hp.ts \
  packages/rules/src/combat.ts \
  packages/rules/test/hp.test.ts \
  packages/rules/test/combat.test.ts
git commit -m "feat(rules): add hit points, conditions, and attack resolution"
```

### Task 4: Spell slots, inventory, initiative, and the rules entry point

Finish the bookkeeping core and export the whole `rules` package for `core` to consume.

**Files:**

- Create: `packages/rules/src/slots.ts`
- Create: `packages/rules/src/inventory.ts`
- Create: `packages/rules/src/initiative.ts`
- Create: `packages/rules/src/index.ts`
- Test: `packages/rules/test/slots.test.ts`
- Test: `packages/rules/test/inventory.test.ts`
- Test: `packages/rules/test/initiative.test.ts`

**Interfaces:**

- Consumes: `Combatant`, `InitiativeEntry`, `abilityModifier` (Task 2); `RulesError`, `Rng` (Task 1).
- Produces:
  - `spendSlot(c, level)`, `restoreSlots(c)`, `slotsRemaining(c, level)`, `describeSlots(c)` (e.g. `"L1 2/4, L2 0/2"`)
  - `addItem(c, name, quantity?)`, `removeItem(c, name, quantity?)`
  - `rollInitiative(combatants, rng): InitiativeEntry[]` — rolls in input order, sorts by total, then Dex modifier, then input order
  - `@cartyx-sim/rules` now re-exports every module

- [ ] **Step 1: Write the failing tests**

`packages/rules/test/slots.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { describeSlots, restoreSlots, slotsRemaining, spendSlot } from '../src/slots';
import { makeCombatant } from '../src/testing';

const caster = makeCombatant({
  id: 'caster',
  name: 'Oona',
  spellSlots: [
    { level: 1, max: 4, used: 1 },
    { level: 2, max: 2, used: 2 },
  ],
});

describe('spell slots', () => {
  it('reports remaining slots', () => {
    expect(slotsRemaining(caster, 1)).toBe(3);
    expect(slotsRemaining(caster, 2)).toBe(0);
    expect(slotsRemaining(caster, 3)).toBe(0);
  });

  it('spends a slot', () => {
    expect(slotsRemaining(spendSlot(caster, 1), 1)).toBe(2);
  });

  it('refuses to spend a slot that is not available', () => {
    expect(() => spendSlot(caster, 2)).toThrow(
      'Oona has no level 2 spell slots left (slots: L1 3/4, L2 0/2)'
    );
  });

  it('restores all slots', () => {
    expect(describeSlots(restoreSlots(caster))).toBe('L1 4/4, L2 2/2');
  });
});
```

`packages/rules/test/inventory.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { addItem, removeItem } from '../src/inventory';
import { makeCombatant } from '../src/testing';

const pc = makeCombatant({
  id: 'pc',
  name: 'Tomas',
  inventory: [{ name: 'Healing Potion', quantity: 2 }],
});

describe('inventory', () => {
  it('merges items case-insensitively', () => {
    expect(addItem(pc, 'healing potion').inventory).toEqual([
      { name: 'Healing Potion', quantity: 3 },
    ]);
  });

  it('adds new items', () => {
    expect(addItem(pc, ' Rope ', 1).inventory).toContainEqual({ name: 'Rope', quantity: 1 });
  });

  it('removes part of a stack', () => {
    expect(removeItem(pc, 'Healing Potion').inventory).toEqual([
      { name: 'Healing Potion', quantity: 1 },
    ]);
  });

  it('removes the entry when the stack is used up', () => {
    expect(removeItem(pc, 'Healing Potion', 2).inventory).toEqual([]);
  });

  it('refuses to remove more than is held', () => {
    expect(() => removeItem(pc, 'Healing Potion', 3)).toThrow(
      'Tomas has 2 × "Healing Potion", cannot remove 3'
    );
    expect(() => removeItem(pc, 'Rope')).toThrow('has 0 × "Rope"');
  });

  it('rejects non-positive quantities', () => {
    expect(() => addItem(pc, 'Rope', 0)).toThrow('positive integer');
  });
});
```

`packages/rules/test/initiative.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { rollInitiative } from '../src/initiative';
import { scriptedRng } from '../src/rng';
import { makeCombatant } from '../src/testing';

const abilities = (dex: number) => ({ str: 10, dex, con: 10, int: 10, wis: 10, cha: 10 });

describe('rollInitiative', () => {
  it('orders by total, then Dex modifier, then input order', () => {
    const slow = makeCombatant({ id: 'slow', abilities: abilities(8) });
    const quick = makeCombatant({ id: 'quick', abilities: abilities(16) });
    const tieA = makeCombatant({ id: 'tie-a', abilities: abilities(12) });
    const tieB = makeCombatant({ id: 'tie-b', abilities: abilities(12) });
    const order = rollInitiative([slow, quick, tieA, tieB], scriptedRng([19, 10, 12, 12]));
    expect(order.map((e) => [e.combatantId, e.total])).toEqual([
      ['slow', 18],
      ['quick', 13],
      ['tie-a', 13],
      ['tie-b', 13],
    ]);
    expect(order[1]).toEqual({ combatantId: 'quick', roll: 10, dexMod: 3, total: 13 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/rules/test/slots.test.ts packages/rules/test/inventory.test.ts packages/rules/test/initiative.test.ts`
Expected: FAIL — Vitest cannot resolve `../src/slots` because the implementation does not exist yet.

- [ ] **Step 3: Write the implementation**

`packages/rules/src/slots.ts`

```ts
import { RulesError } from './errors';
import type { Combatant } from './schemas';

export function slotsRemaining(combatant: Combatant, level: number): number {
  const slot = combatant.spellSlots.find((s) => s.level === level);
  return slot ? slot.max - slot.used : 0;
}

/** e.g. "L1 2/4, L2 0/2" (remaining/max). */
export function describeSlots(combatant: Combatant): string {
  return combatant.spellSlots.map((s) => `L${s.level} ${s.max - s.used}/${s.max}`).join(', ');
}

export function spendSlot(combatant: Combatant, level: number): Combatant {
  if (slotsRemaining(combatant, level) < 1) {
    const slots = describeSlots(combatant) || 'none';
    throw new RulesError(
      `${combatant.name} has no level ${level} spell slots left (slots: ${slots})`
    );
  }
  return {
    ...combatant,
    spellSlots: combatant.spellSlots.map((s) =>
      s.level === level ? { ...s, used: s.used + 1 } : s
    ),
  };
}

export function restoreSlots(combatant: Combatant): Combatant {
  return { ...combatant, spellSlots: combatant.spellSlots.map((s) => ({ ...s, used: 0 })) };
}
```

`packages/rules/src/inventory.ts`

```ts
import { RulesError } from './errors';
import type { Combatant } from './schemas';

function sameItem(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function addItem(combatant: Combatant, name: string, quantity = 1): Combatant {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RulesError(`Quantity must be a positive integer, got ${quantity}`);
  }
  const existing = combatant.inventory.find((item) => sameItem(item.name, name));
  const inventory = existing
    ? combatant.inventory.map((item) =>
        item === existing ? { ...item, quantity: item.quantity + quantity } : item
      )
    : [...combatant.inventory, { name: name.trim(), quantity }];
  return { ...combatant, inventory };
}

export function removeItem(combatant: Combatant, name: string, quantity = 1): Combatant {
  const existing = combatant.inventory.find((item) => sameItem(item.name, name));
  if (!existing || existing.quantity < quantity) {
    const held = existing?.quantity ?? 0;
    throw new RulesError(`${combatant.name} has ${held} × "${name}", cannot remove ${quantity}`);
  }
  const inventory =
    existing.quantity === quantity
      ? combatant.inventory.filter((item) => item !== existing)
      : combatant.inventory.map((item) =>
          item === existing ? { ...item, quantity: item.quantity - quantity } : item
        );
  return { ...combatant, inventory };
}
```

`packages/rules/src/initiative.ts`

```ts
import { abilityModifier } from './checks';
import type { Rng } from './rng';
import type { Combatant, InitiativeEntry } from './schemas';

/** Rolls d20 + Dex for each combatant in input order; sorts by total, then Dex modifier, then input order. */
export function rollInitiative(combatants: readonly Combatant[], rng: Rng): InitiativeEntry[] {
  const rolled = combatants.map((combatant, index) => {
    const roll = rng.die(20);
    const dexMod = abilityModifier(combatant.abilities.dex);
    return { index, entry: { combatantId: combatant.id, roll, dexMod, total: roll + dexMod } };
  });
  rolled.sort(
    (a, b) => b.entry.total - a.entry.total || b.entry.dexMod - a.entry.dexMod || a.index - b.index
  );
  return rolled.map((r) => r.entry);
}
```

`packages/rules/src/index.ts`

```ts
export * from './checks';
export * from './combat';
export * from './dice';
export * from './errors';
export * from './hp';
export * from './initiative';
export * from './inventory';
export * from './rng';
export * from './schemas';
export * from './slots';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/rules/test/slots.test.ts packages/rules/test/inventory.test.ts packages/rules/test/initiative.test.ts`
Expected: PASS — 11 tests across 3 file(s).

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: `tsc` reports no errors and every test passes.

- [ ] **Step 6: Commit** (only once the user has approved commits)

```bash
git add packages/rules/src/slots.ts \
  packages/rules/src/inventory.ts \
  packages/rules/src/initiative.ts \
  packages/rules/src/index.ts \
  packages/rules/test/slots.test.ts \
  packages/rules/test/inventory.test.ts \
  packages/rules/test/initiative.test.ts
git commit -m "feat(rules): add spell slots, inventory, and initiative"
```

### Task 5: Event log schema, state reducer, turn recorder, and session clock

Create the `core` package: the event contract every later subsystem reads, the pure state fold over it, per-turn buffering, and the spoken-runtime clock.

**Files:**

- Create: `packages/core/package.json`
- Create: `packages/core/src/text.ts`
- Create: `packages/core/src/events.ts`
- Create: `packages/core/src/state.ts`
- Create: `packages/core/src/recorder.ts`
- Create: `packages/core/src/sink.ts`
- Create: `packages/core/src/clock.ts`
- Create (test support): `packages/core/test/helpers.ts`
- Test: `packages/core/test/text.test.ts`
- Test: `packages/core/test/state.test.ts`
- Test: `packages/core/test/clock.test.ts`
- Test: `packages/core/test/recorder.test.ts`

**Interfaces:**

- Consumes: `@cartyx-sim/rules`: `Combatant`, `InitiativeEntry`; `makeCombatant` from `@cartyx-sim/rules/testing`.
- Produces:
  - `SimEvent` (Zod discriminated union on `type`; spec §4.2) with common fields `seq`, `ts`, `turnId`, `visibility`; also `Emotion`, `EMOTIONS`, `Visibility`, `StateField`, `HandOffTarget`
  - `GameState`, `initialState()`, `applyEvent(state, event)`, `foldEvents(events)`, `nextActor(state): NextActor`, `advanceCombat(state)`, `selectResponders(target, state)`, `isUp(c)`, `OPEN_FLOOR_RESPONDERS`
  - `class TurnRecorder(base, turnId, now)` with `emit(input: EventInput): SimEvent`, `state`, `events`; `type EventInput`
  - `interface EventSink { readAll(); append(events) }`, `class MemorySink`
  - `clockPhase(state, targetMinutes): 'running' | 'wrap_up' | 'end_at_scene_break' | 'hard_stop'`, `clockInstruction(phase)`, `spokenMinutes`, `WORDS_PER_MINUTE`
  - `countWords`, `slugify`, `escapeRegExp`
  - Test support: `kira`, `tomas`, `FIXED_NOW`, `now`, `startedState(party?)` in `packages/core/test/helpers.ts`

- [ ] **Step 1: Create the package configuration**

`packages/core/package.json`

```json
{
  "name": "@cartyx-sim/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts"
  },
  "dependencies": {
    "@cartyx-sim/rules": "*",
    "zod": "^4.6.4"
  }
}
```

- [ ] **Step 2: Link the new workspace package**

Run: `npm install`
Expected: install completes with no errors.

- [ ] **Step 3: Write the failing tests**

`packages/core/test/helpers.ts`

```ts
import type { Combatant } from '@cartyx-sim/rules';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import type { SimEvent } from '../src/events';
import { TurnRecorder } from '../src/recorder';
import { initialState, type GameState } from '../src/state';

export const FIXED_NOW = new Date('2026-09-13T12:00:00.000Z');
export const now = () => FIXED_NOW;

export const kira = makeCombatant({
  id: 'kira',
  name: 'Kira Vale',
  abilities: { str: 10, dex: 14, con: 12, int: 16, wis: 12, cha: 10 },
  skillProficiencies: ['investigation'],
  ac: 15,
  maxHp: 10,
  hp: 10,
  spellSlots: [{ level: 1, max: 2, used: 0 }],
  attacks: [{ name: 'Light Hammer', bonus: 5, damage: '1d4+3', damageType: 'bludgeoning' }],
  inventory: [{ name: 'Healing Potion', quantity: 1 }],
});

export const tomas = makeCombatant({
  id: 'tomas',
  name: 'Tomas Reed',
  abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 12 },
  saveProficiencies: ['str', 'con'],
  ac: 16,
  maxHp: 12,
  hp: 12,
  attacks: [{ name: 'Longsword', bonus: 5, damage: '1d8+3', damageType: 'slashing' }],
});

/** A state and history just after session_start with the given party. */
export function startedState(party: Combatant[] = [kira, tomas]): {
  state: GameState;
  history: SimEvent[];
} {
  const recorder = new TurnRecorder(initialState(), 'setup', now);
  recorder.emit({
    type: 'session_start',
    session: 1,
    loreCommit: 'test',
    targetMinutes: 60,
    party,
  });
  return { state: recorder.state, history: [...recorder.events] };
}
```

`packages/core/test/text.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { countWords, escapeRegExp, slugify } from '../src/text';

describe('countWords', () => {
  it('counts words separated by any whitespace', () => {
    expect(countWords('Engine three?  I\ncalibrated it.')).toBe(5);
  });

  it('returns 0 for blank text', () => {
    expect(countWords('   ')).toBe(0);
  });
});

describe('slugify', () => {
  it('builds kebab-case ids', () => {
    expect(slugify('Professor Sella Vaunt')).toBe('professor-sella-vaunt');
  });

  it('strips accents and punctuation', () => {
    expect(slugify("Selûne's  Chosen!")).toBe('selune-s-chosen');
  });

  it('returns an empty string when nothing usable remains', () => {
    expect(slugify('!!!')).toBe('');
  });
});

describe('escapeRegExp', () => {
  it('makes special characters literal', () => {
    const pattern = new RegExp(escapeRegExp('a.b(c)'));
    expect(pattern.test('a.b(c)')).toBe(true);
    expect(pattern.test('axb(c)')).toBe(false);
  });
});
```

`packages/core/test/state.test.ts`

```ts
import { makeCombatant } from '@cartyx-sim/rules/testing';
import { describe, expect, it } from 'vitest';
import { SimEvent } from '../src/events';
import { TurnRecorder } from '../src/recorder';
import {
  advanceCombat,
  applyEvent,
  foldEvents,
  initialState,
  nextActor,
  selectResponders,
} from '../src/state';
import { kira, now, startedState, tomas } from './helpers';

function recorderAfterStart() {
  const { state } = startedState();
  return new TurnRecorder(state, 'turn', now);
}

const sentry = makeCombatant({ id: 'sentry-1', name: 'Sentry', kind: 'monster', hp: 5, maxHp: 5 });

describe('applyEvent', () => {
  it('rejects events that are not after the last seq', () => {
    const { state, history } = startedState();
    expect(() => applyEvent(state, history[0]!)).toThrow('is not after last seq 0');
  });

  it('does not mutate the previous state', () => {
    const recorder = recorderAfterStart();
    const before = recorder.state;
    recorder.emit({ type: 'narration', speaker: 'dm', text: 'Hello there.', emotion: 'neutral' });
    expect(before.spokenWords).toBe(0);
    expect(recorder.state.spokenWords).toBe(2);
  });

  it('loads the party on session_start and waits for the DM', () => {
    const { state } = startedState();
    expect(state.session).toBe(1);
    expect(state.partyIds).toEqual(['kira', 'tomas']);
    expect(state.combatants.kira).toEqual(kira);
    expect(nextActor(state)).toEqual({ kind: 'dm', reason: 'beat' });
  });

  it('counts spoken words per speaker and tracks silent turns', () => {
    const recorder = recorderAfterStart();
    recorder.emit({
      type: 'dialogue',
      speaker: 'kira',
      speakerKind: 'pc',
      text: 'One two three',
      emotion: 'neutral',
    });
    recorder.emit({ type: 'turn_end', actor: 'kira' });
    recorder.emit({ type: 'turn_end', actor: 'tomas' });
    expect(recorder.state.wordsBySpeaker).toEqual({ kira: 3 });
    expect(recorder.state.spokenWords).toBe(3);
    expect(recorder.state.silentTurns).toBe(1);
    expect(recorder.state.turnWords).toBe(0);
  });

  it('queues hand-off responders and removes them as they finish', () => {
    const recorder = recorderAfterStart();
    recorder.emit({ type: 'hand_off', target: { kind: 'party' }, responders: ['kira', 'tomas'] });
    expect(nextActor(recorder.state)).toEqual({ kind: 'pc', pcId: 'kira', reason: 'response' });
    recorder.emit({ type: 'turn_end', actor: 'kira' });
    expect(nextActor(recorder.state)).toEqual({ kind: 'pc', pcId: 'tomas', reason: 'response' });
    recorder.emit({ type: 'turn_end', actor: 'tomas' });
    expect(nextActor(recorder.state)).toEqual({ kind: 'dm', reason: 'beat' });
  });

  it('applies state changes and validates the result', () => {
    const recorder = recorderAfterStart();
    recorder.emit({
      type: 'state_change',
      entity: 'kira',
      field: 'hp',
      before: 10,
      after: 4,
      cause: 'test',
    });
    expect(recorder.state.combatants.kira?.hp).toBe(4);
    expect(() =>
      recorder.emit({
        type: 'state_change',
        entity: 'kira',
        field: 'hp',
        before: 4,
        after: -1,
        cause: 'test',
      })
    ).toThrow();
    expect(() =>
      recorder.emit({
        type: 'state_change',
        entity: 'ghost',
        field: 'hp',
        before: 1,
        after: 0,
        cause: 'test',
      })
    ).toThrow('unknown combatant "ghost"');
  });

  it('runs the combat turn cycle', () => {
    const recorder = recorderAfterStart();
    recorder.emit({ type: 'combatant_added', combatant: sentry });
    recorder.emit({
      type: 'combat_start',
      order: [
        { combatantId: 'sentry-1', roll: 18, dexMod: 0, total: 18 },
        { combatantId: 'kira', roll: 10, dexMod: 2, total: 12 },
      ],
    });
    expect(nextActor(recorder.state)).toEqual({
      kind: 'dm',
      reason: 'monster',
      combatantId: 'sentry-1',
    });
    recorder.emit({ type: 'combat_turn', round: 1, turnIndex: 1, combatantId: 'kira' });
    expect(nextActor(recorder.state)).toEqual({ kind: 'pc', pcId: 'kira', reason: 'combat_turn' });
    recorder.emit({ type: 'turn_end', actor: 'kira' });
    expect(nextActor(recorder.state)).toEqual({
      kind: 'dm',
      reason: 'resolve',
      combatantId: 'kira',
    });
    recorder.emit({ type: 'combat_end' });
    expect(recorder.state.combat).toBeNull();
    expect(nextActor(recorder.state)).toEqual({ kind: 'dm', reason: 'beat' });
  });

  it('reports the end of the session', () => {
    const recorder = recorderAfterStart();
    recorder.emit({ type: 'session_end', reason: 'manual' });
    expect(nextActor(recorder.state)).toEqual({ kind: 'ended' });
  });
});

describe('foldEvents', () => {
  it('matches applying events one at a time', () => {
    const recorder = recorderAfterStart();
    recorder.emit({ type: 'scene_change', location: 'Lab', artPrompt: 'A lab' });
    const { history } = startedState();
    const all = [...history, ...recorder.events].map((event) => SimEvent.parse(event));
    expect(foldEvents(all)).toEqual(recorder.state);
    expect(foldEvents([])).toEqual(initialState());
  });
});

describe('advanceCombat', () => {
  function combatState(hp: { kira: number; tomas: number; sentry: number }, turnIndex: number) {
    const { state } = startedState([
      { ...kira, hp: hp.kira },
      { ...tomas, hp: hp.tomas },
    ]);
    return {
      ...state,
      combatants: { ...state.combatants, 'sentry-1': { ...sentry, hp: hp.sentry } },
      combat: {
        order: [
          { combatantId: 'sentry-1', roll: 1, dexMod: 0, total: 20 },
          { combatantId: 'kira', roll: 1, dexMod: 0, total: 15 },
          { combatantId: 'tomas', roll: 1, dexMod: 0, total: 10 },
        ],
        round: 1,
        turnIndex,
        declared: true,
      },
    };
  }

  it('moves to the next combatant who can act', () => {
    expect(advanceCombat(combatState({ kira: 0, tomas: 12, sentry: 5 }, 0))).toEqual({
      round: 1,
      turnIndex: 2,
      combatantId: 'tomas',
    });
  });

  it('wraps into the next round', () => {
    expect(advanceCombat(combatState({ kira: 10, tomas: 12, sentry: 5 }, 2))).toEqual({
      round: 2,
      turnIndex: 0,
      combatantId: 'sentry-1',
    });
  });

  it('returns null when nobody can act', () => {
    expect(advanceCombat(combatState({ kira: 0, tomas: 0, sentry: 0 }, 0))).toBeNull();
  });
});

describe('selectResponders', () => {
  const { state } = startedState();
  const chatty = { ...state, wordsBySpeaker: { kira: 40, tomas: 3 } };

  it('keeps named PCs who can act, in the order given', () => {
    const downed = { ...chatty, combatants: { ...chatty.combatants, tomas: { ...tomas, hp: 0 } } };
    expect(selectResponders({ kind: 'pcs', ids: ['tomas', 'kira'] }, downed)).toEqual(['kira']);
  });

  it('orders the whole party quietest first', () => {
    expect(selectResponders({ kind: 'party' }, chatty)).toEqual(['tomas', 'kira']);
  });

  it('gives the open floor to the two quietest players', () => {
    const three = startedState([kira, tomas, makeCombatant({ id: 'oona' })]).state;
    const counts = { ...three, wordsBySpeaker: { kira: 40, tomas: 3, oona: 10 } };
    expect(selectResponders({ kind: 'open' }, counts)).toEqual(['tomas', 'oona']);
  });

  it('returns nobody during combat', () => {
    const fighting = { ...chatty, combat: { order: [], round: 1, turnIndex: 0, declared: false } };
    expect(selectResponders({ kind: 'party' }, fighting)).toEqual([]);
  });
});
```

`packages/core/test/clock.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { clockInstruction, clockPhase, spokenMinutes } from '../src/clock';

describe('session clock', () => {
  it('converts spoken words to minutes at 150 words per minute', () => {
    expect(spokenMinutes({ spokenWords: 1500 })).toBe(10);
  });

  it.each([
    [0, 'running'],
    [1199, 'running'],
    [1200, 'wrap_up'],
    [1499, 'wrap_up'],
    [1500, 'end_at_scene_break'],
    [1724, 'end_at_scene_break'],
    [1800, 'hard_stop'],
  ])('%i words of a 10-minute target is %s', (spokenWords, phase) => {
    expect(clockPhase({ spokenWords }, 10)).toBe(phase);
  });

  it('only instructs the DM once wrap-up begins', () => {
    expect(clockInstruction('running')).toBe('');
    expect(clockInstruction('wrap_up')).toContain('nearing its time limit');
    expect(clockInstruction('end_at_scene_break')).toContain('call scene_change');
  });
});
```

`packages/core/test/recorder.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { TurnRecorder } from '../src/recorder';
import { MemorySink } from '../src/sink';
import { FIXED_NOW, now, startedState } from './helpers';

describe('TurnRecorder', () => {
  it('stamps seq, time, turn id, and default visibility', () => {
    const { state } = startedState();
    const recorder = new TurnRecorder(state, 'turn-7', now);
    const event = recorder.emit({ type: 'scene_change', location: 'Lab', artPrompt: 'A lab' });
    expect(event).toMatchObject({
      seq: 1,
      ts: FIXED_NOW.toISOString(),
      turnId: 'turn-7',
      visibility: 'public',
    });
    expect(recorder.emit({ type: 'ooc_note', visibility: 'dm', text: 'note' }).seq).toBe(2);
    expect(recorder.events).toHaveLength(2);
  });

  it('applies each event to its working state', () => {
    const { state } = startedState();
    const recorder = new TurnRecorder(state, 'turn', now);
    recorder.emit({ type: 'scene_change', location: 'Lab', artPrompt: 'A lab' });
    expect(recorder.state.scene).toEqual({ location: 'Lab', loreEntityId: undefined });
    expect(state.scene).toBeNull();
  });

  it('rejects invalid events without recording them', () => {
    const { state } = startedState();
    const recorder = new TurnRecorder(state, 'turn', now);
    expect(() =>
      recorder.emit({
        type: 'dialogue',
        speaker: 'kira',
        speakerKind: 'pc',
        text: '',
        emotion: 'neutral',
      })
    ).toThrow();
    expect(recorder.events).toHaveLength(0);
    expect(recorder.state).toBe(state);
  });
});

describe('MemorySink', () => {
  it('appends and returns copies of its events', async () => {
    const sink = new MemorySink();
    const { history } = startedState();
    await sink.append(history);
    const read = await sink.readAll();
    read.pop();
    expect(await sink.readAll()).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/text.test.ts packages/core/test/state.test.ts packages/core/test/clock.test.ts packages/core/test/recorder.test.ts`
Expected: FAIL — Vitest cannot resolve `../src/text` because the implementation does not exist yet.

- [ ] **Step 5: Write the implementation**

`packages/core/src/text.ts`

```ts
export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

/** "Professor Sella Vaunt" → "professor-sella-vaunt". */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

`packages/core/src/events.ts`

```ts
import { Combatant, InitiativeEntry } from '@cartyx-sim/rules';
import { z } from 'zod';

export const EMOTIONS = [
  'neutral',
  'happy',
  'excited',
  'amused',
  'angry',
  'sad',
  'afraid',
  'surprised',
  'whisper',
  'sarcastic',
  'determined',
  'pained',
] as const;
export const Emotion = z.enum(EMOTIONS);
export type Emotion = z.infer<typeof Emotion>;

export const Visibility = z.enum(['public', 'dm']);
export type Visibility = z.infer<typeof Visibility>;

export const StateField = z.enum([
  'hp',
  'tempHp',
  'maxHp',
  'conditions',
  'dead',
  'spellSlots',
  'inventory',
  'level',
]);
export type StateField = z.infer<typeof StateField>;

export const HandOffTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pcs'), ids: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('party') }),
  z.object({ kind: z.literal('open') }),
]);
export type HandOffTarget = z.infer<typeof HandOffTarget>;

const base = {
  seq: z.number().int().min(0),
  ts: z.string().min(1),
  turnId: z.string().min(1),
  visibility: Visibility,
};

export const SimEvent = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('session_start'),
    session: z.number().int().min(1),
    loreCommit: z.string(),
    targetMinutes: z.number().positive(),
    party: z.array(Combatant).min(1),
  }),
  z.object({
    ...base,
    type: z.literal('session_end'),
    reason: z.enum(['target_reached', 'hard_stop', 'manual']),
  }),
  z.object({
    ...base,
    type: z.literal('narration'),
    speaker: z.literal('dm'),
    text: z.string().min(1),
    emotion: Emotion,
  }),
  z.object({
    ...base,
    type: z.literal('dialogue'),
    speaker: z.string().min(1),
    speakerKind: z.enum(['pc', 'npc']),
    text: z.string().min(1),
    emotion: Emotion,
    overlaps: z.number().int().min(0).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('action'),
    actor: z.string().min(1),
    intent: z.string().min(1),
    target: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal('pass'), actor: z.string().min(1) }),
  z.object({
    ...base,
    type: z.literal('roll'),
    actor: z.string().min(1),
    kind: z.enum(['check', 'save', 'attack', 'damage', 'healing', 'initiative']),
    label: z.string().min(1),
    expr: z.string().min(1),
    rolls: z.array(z.number().int()),
    modifier: z.number().int(),
    total: z.number().int(),
    target: z.number().int().optional(),
    outcome: z.enum(['success', 'failure', 'hit', 'miss', 'critical']).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('state_change'),
    entity: z.string().min(1),
    field: StateField,
    before: z.unknown(),
    after: z.unknown(),
    cause: z.string().min(1),
  }),
  z.object({ ...base, type: z.literal('combatant_added'), combatant: Combatant }),
  z.object({
    ...base,
    type: z.literal('lore_lookup'),
    query: z.string().min(1),
    hits: z.array(z.object({ chunkId: z.string(), source: z.string(), score: z.number() })),
    used: z.array(z.string()),
  }),
  z.object({
    ...base,
    type: z.literal('lore_invention'),
    fact: z.string().min(1),
    reason: z.string().min(1),
    query: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('npc_introduced'),
    npcId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    invented: z.boolean(),
    loreEntityId: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('scene_change'),
    location: z.string().min(1),
    artPrompt: z.string().min(1),
    loreEntityId: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('hand_off'),
    target: HandOffTarget,
    responders: z.array(z.string()),
  }),
  z.object({ ...base, type: z.literal('combat_start'), order: z.array(InitiativeEntry).min(1) }),
  z.object({
    ...base,
    type: z.literal('combat_turn'),
    round: z.number().int().min(1),
    turnIndex: z.number().int().min(0),
    combatantId: z.string().min(1),
  }),
  z.object({ ...base, type: z.literal('combat_end') }),
  z.object({ ...base, type: z.literal('turn_end'), actor: z.string().min(1) }),
  z.object({
    ...base,
    type: z.literal('validator_flag'),
    seat: z.string().min(1),
    rule: z.string().min(1),
    retries: z.number().int().min(0),
    resolution: z.enum(['accepted_with_flag', 'forced_pass', 'forced_hand_off']),
  }),
  z.object({ ...base, type: z.literal('ooc_note'), text: z.string().min(1) }),
]);
export type SimEvent = z.output<typeof SimEvent>;
export type SimEventType = SimEvent['type'];
```

`packages/core/src/state.ts`

```ts
import { Combatant, type InitiativeEntry } from '@cartyx-sim/rules';
import type { HandOffTarget, SimEvent } from './events';
import { countWords } from './text';

export interface NpcRecord {
  npcId: string;
  name: string;
  invented: boolean;
  loreEntityId?: string;
}

export interface CombatState {
  order: InitiativeEntry[];
  round: number;
  turnIndex: number;
  /** Whether the PC whose turn it is has already declared an action. */
  declared: boolean;
}

export interface GameState {
  session: number | null;
  lastSeq: number;
  ended: boolean;
  partyIds: string[];
  combatants: Record<string, Combatant>;
  npcs: Record<string, NpcRecord>;
  scene: { location: string; loreEntityId?: string } | null;
  combat: CombatState | null;
  /** PCs the DM handed off to who have not taken their turn yet (exploration only). */
  pendingResponders: string[];
  spokenWords: number;
  wordsBySpeaker: Record<string, number>;
  /** Consecutive completed turns with no spoken words. */
  silentTurns: number;
  /** Spoken words so far in the turn being recorded. */
  turnWords: number;
}

export const OPEN_FLOOR_RESPONDERS = 2;

export function initialState(): GameState {
  return {
    session: null,
    lastSeq: -1,
    ended: false,
    partyIds: [],
    combatants: {},
    npcs: {},
    scene: null,
    combat: null,
    pendingResponders: [],
    spokenWords: 0,
    wordsBySpeaker: {},
    silentTurns: 0,
    turnWords: 0,
  };
}

/** Pure reducer: returns a new state with the event applied. */
export function applyEvent(state: GameState, event: SimEvent): GameState {
  if (event.seq <= state.lastSeq) {
    throw new Error(`Event seq ${event.seq} is not after last seq ${state.lastSeq}`);
  }
  const next = structuredClone(state);
  next.lastSeq = event.seq;

  switch (event.type) {
    case 'session_start':
      next.session = event.session;
      next.ended = false;
      next.partyIds = event.party.map((pc) => pc.id);
      for (const pc of event.party) next.combatants[pc.id] = pc;
      next.combat = null;
      next.pendingResponders = [];
      break;
    case 'session_end':
      next.ended = true;
      break;
    case 'narration':
    case 'dialogue': {
      const words = countWords(event.text);
      next.spokenWords += words;
      next.turnWords += words;
      next.wordsBySpeaker[event.speaker] = (next.wordsBySpeaker[event.speaker] ?? 0) + words;
      break;
    }
    case 'state_change': {
      const combatant = next.combatants[event.entity];
      if (!combatant) throw new Error(`state_change for unknown combatant "${event.entity}"`);
      next.combatants[event.entity] = Combatant.parse({ ...combatant, [event.field]: event.after });
      break;
    }
    case 'combatant_added':
      next.combatants[event.combatant.id] = event.combatant;
      break;
    case 'npc_introduced':
      next.npcs[event.npcId] = {
        npcId: event.npcId,
        name: event.name,
        invented: event.invented,
        loreEntityId: event.loreEntityId,
      };
      break;
    case 'scene_change':
      next.scene = { location: event.location, loreEntityId: event.loreEntityId };
      break;
    case 'hand_off':
      if (!next.combat) next.pendingResponders = [...event.responders];
      break;
    case 'combat_start':
      next.combat = { order: event.order, round: 1, turnIndex: 0, declared: false };
      next.pendingResponders = [];
      break;
    case 'combat_turn':
      if (!next.combat) throw new Error('combat_turn without an active combat');
      next.combat.round = event.round;
      next.combat.turnIndex = event.turnIndex;
      next.combat.declared = false;
      break;
    case 'combat_end':
      next.combat = null;
      next.pendingResponders = [];
      break;
    case 'turn_end':
      next.silentTurns = next.turnWords > 0 ? 0 : next.silentTurns + 1;
      next.turnWords = 0;
      if (next.partyIds.includes(event.actor)) {
        if (next.combat) next.combat.declared = true;
        else next.pendingResponders = next.pendingResponders.filter((id) => id !== event.actor);
      }
      break;
    default:
      break;
  }
  return next;
}

export function foldEvents(events: readonly SimEvent[]): GameState {
  return events.reduce(applyEvent, initialState());
}

export function isUp(combatant: Combatant | undefined): combatant is Combatant {
  return combatant !== undefined && !combatant.dead && combatant.hp > 0;
}

export type NextActor =
  | { kind: 'ended' }
  | { kind: 'dm'; reason: 'beat' | 'resolve' | 'monster'; combatantId?: string }
  | { kind: 'pc'; pcId: string; reason: 'response' | 'combat_turn' };

export function nextActor(state: GameState): NextActor {
  if (state.ended) return { kind: 'ended' };
  if (state.combat) {
    const entry = state.combat.order[state.combat.turnIndex];
    const combatant = entry ? state.combatants[entry.combatantId] : undefined;
    if (combatant?.kind === 'pc') {
      return state.combat.declared
        ? { kind: 'dm', reason: 'resolve', combatantId: combatant.id }
        : { kind: 'pc', pcId: combatant.id, reason: 'combat_turn' };
    }
    return { kind: 'dm', reason: 'monster', combatantId: entry?.combatantId };
  }
  const responder = state.pendingResponders[0];
  return responder
    ? { kind: 'pc', pcId: responder, reason: 'response' }
    : { kind: 'dm', reason: 'beat' };
}

/** The next combatant in initiative order who can act, or null if nobody can. */
export function advanceCombat(
  state: GameState
): { round: number; turnIndex: number; combatantId: string } | null {
  const combat = state.combat;
  if (!combat) return null;
  const count = combat.order.length;
  for (let offset = 1; offset <= count; offset++) {
    const position = combat.turnIndex + offset;
    const entry = combat.order[position % count]!;
    if (isUp(state.combatants[entry.combatantId])) {
      return {
        round: combat.round + Math.floor(position / count),
        turnIndex: position % count,
        combatantId: entry.combatantId,
      };
    }
  }
  return null;
}

/** Who responds to a hand-off. Quietest players first, so no seat disappears. Empty in combat. */
export function selectResponders(target: HandOffTarget, state: GameState): string[] {
  if (state.combat) return [];
  const active = state.partyIds.filter((id) => isUp(state.combatants[id]));
  const quietestFirst = [...active].sort(
    (a, b) => (state.wordsBySpeaker[a] ?? 0) - (state.wordsBySpeaker[b] ?? 0)
  );
  switch (target.kind) {
    case 'pcs':
      return target.ids.filter((id) => active.includes(id));
    case 'party':
      return quietestFirst;
    case 'open':
      return quietestFirst.slice(0, OPEN_FLOOR_RESPONDERS);
  }
}
```

`packages/core/src/recorder.ts`

```ts
import { z } from 'zod';
import { SimEvent, type Visibility } from './events';
import { applyEvent, type GameState } from './state';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the recorder stamps seq, ts, and turnId. Visibility defaults to public. */
export type EventInput = DistributiveOmit<
  z.input<typeof SimEvent>,
  'seq' | 'ts' | 'turnId' | 'visibility'
> & { visibility?: Visibility };

/**
 * Buffers one turn's events. Each emitted event is validated and applied to a working state, so
 * tools later in the same turn see earlier results. Nothing is persisted until the director commits.
 */
export class TurnRecorder {
  private working: GameState;
  private readonly emitted: SimEvent[] = [];

  constructor(
    base: GameState,
    readonly turnId: string,
    private readonly now: () => Date
  ) {
    this.working = base;
  }

  get state(): GameState {
    return this.working;
  }

  get events(): readonly SimEvent[] {
    return this.emitted;
  }

  emit(input: EventInput): SimEvent {
    const event = SimEvent.parse({
      visibility: 'public',
      ...input,
      seq: this.working.lastSeq + 1,
      ts: this.now().toISOString(),
      turnId: this.turnId,
    });
    this.working = applyEvent(this.working, event);
    this.emitted.push(event);
    return event;
  }
}
```

`packages/core/src/sink.ts`

```ts
import type { SimEvent } from './events';

/** Durable event storage. `append` receives one whole turn and must write it atomically. */
export interface EventSink {
  readAll(): Promise<SimEvent[]>;
  append(events: readonly SimEvent[]): Promise<void>;
}

export class MemorySink implements EventSink {
  readonly events: SimEvent[] = [];

  async readAll(): Promise<SimEvent[]> {
    return [...this.events];
  }

  async append(events: readonly SimEvent[]): Promise<void> {
    this.events.push(...events);
  }
}
```

`packages/core/src/clock.ts`

```ts
import type { GameState } from './state';

export const WORDS_PER_MINUTE = 150;
export const WRAP_UP_RATIO = 0.8;
export const HARD_STOP_RATIO = 1.15;

export type ClockPhase = 'running' | 'wrap_up' | 'end_at_scene_break' | 'hard_stop';

export function spokenMinutes(state: Pick<GameState, 'spokenWords'>): number {
  return state.spokenWords / WORDS_PER_MINUTE;
}

export function clockPhase(
  state: Pick<GameState, 'spokenWords'>,
  targetMinutes: number
): ClockPhase {
  const ratio = spokenMinutes(state) / targetMinutes;
  if (ratio >= HARD_STOP_RATIO) return 'hard_stop';
  if (ratio >= 1) return 'end_at_scene_break';
  if (ratio >= WRAP_UP_RATIO) return 'wrap_up';
  return 'running';
}

export function clockInstruction(phase: ClockPhase): string {
  switch (phase) {
    case 'running':
      return '';
    case 'wrap_up':
      return 'The session is nearing its time limit: start steering toward a satisfying cliffhanger.';
    case 'end_at_scene_break':
    case 'hard_stop':
      return 'Time is up: close the current scene now and call scene_change to cut to the cliffhanger.';
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/text.test.ts packages/core/test/state.test.ts packages/core/test/clock.test.ts packages/core/test/recorder.test.ts`
Expected: PASS — 35 tests across 4 file(s).

- [ ] **Step 7: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: `tsc` reports no errors and every test passes.

- [ ] **Step 8: Commit** (only once the user has approved commits)

```bash
git add packages/core/package.json \
  packages/core/src/text.ts \
  packages/core/src/events.ts \
  packages/core/src/state.ts \
  packages/core/src/recorder.ts \
  packages/core/src/sink.ts \
  packages/core/src/clock.ts \
  packages/core/test/helpers.ts \
  packages/core/test/text.test.ts \
  packages/core/test/state.test.ts \
  packages/core/test/clock.test.ts \
  packages/core/test/recorder.test.ts \
  package.json \
  package-lock.json
git commit -m "feat(core): add event log schema, state reducer, recorder, and session clock"
```

### Task 6: Model and lore interfaces, transcripts, and validators

Define the seams real models and lore plug into later, render what each audience may see, and catch agents breaking table rules.

**Files:**

- Create: `packages/core/src/model.ts`
- Create: `packages/core/src/transcript.ts`
- Create: `packages/core/src/validators.ts`
- Test: `packages/core/test/transcript.test.ts`
- Test: `packages/core/test/validators.test.ts`

**Interfaces:**

- Consumes: `SimEvent`, `GameState`, `escapeRegExp` (Task 5).
- Produces:
  - `interface ModelClient { complete(request: ModelRequest): Promise<ModelResponse> }`; `ModelRequest` (`{ seat, messages, tools }`), `ChatMessage`, `ToolSchema`; Zod `ToolCall` and `ModelResponse` (`{ text, toolCalls }`)
  - `interface LoreIndex { search(query, limit): Promise<LoreHit[]> }`; Zod `LoreHit` (`{ chunkId, source, title, text, score }`)
  - `renderTranscript(events, state, audience: 'dm' | 'player', limit)`, `describeEvent(event, state)` — players never see `visibility: 'dm'` events
  - `validateDmText(text, { pcNames, mechanicsToolCalled })`, `validatePlayerText(text, { otherPcNames })` → `Violation | null` (`{ rule, message }`)

- [ ] **Step 1: Write the failing tests**

`packages/core/test/transcript.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { TurnRecorder } from '../src/recorder';
import { describeEvent, renderTranscript } from '../src/transcript';
import { now, startedState } from './helpers';

function sampleSession() {
  const { state, history } = startedState();
  const recorder = new TurnRecorder(state, 'turn', now);
  recorder.emit({
    type: 'npc_introduced',
    npcId: 'sella',
    name: 'Sella Vaunt',
    description: 'Crystal engine professor',
    invented: false,
  });
  recorder.emit({
    type: 'lore_lookup',
    visibility: 'dm',
    query: 'Sella Vaunt',
    hits: [],
    used: [],
  });
  recorder.emit({
    type: 'dialogue',
    speaker: 'sella',
    speakerKind: 'npc',
    text: 'Find out who.',
    emotion: 'angry',
  });
  recorder.emit({
    type: 'dialogue',
    speaker: 'kira',
    speakerKind: 'pc',
    text: 'On it!',
    emotion: 'excited',
    overlaps: 3,
  });
  recorder.emit({
    type: 'roll',
    actor: 'kira',
    kind: 'check',
    label: 'Kira Vale Investigation check (tool marks)',
    expr: '1d20+5',
    rolls: [15],
    modifier: 5,
    total: 20,
    target: 13,
    outcome: 'success',
  });
  recorder.emit({
    type: 'state_change',
    entity: 'tomas',
    field: 'hp',
    before: 12,
    after: 6,
    cause: 'test',
  });
  return { events: [...history, ...recorder.events], state: recorder.state };
}

describe('renderTranscript', () => {
  it('shows the DM everything', () => {
    const { events, state } = sampleSession();
    expect(renderTranscript(events, state, 'dm', 50)).toBe(
      [
        '[npc] Sella Vaunt (npcId: sella): Crystal engine professor',
        '[lore] "Sella Vaunt": 0 relevant result(s)',
        'Sella Vaunt: "Find out who."',
        'Kira Vale (interrupting): "On it!"',
        '[roll] Kira Vale Investigation check (tool marks): 20 vs 13 — success',
        '[state] Tomas Reed HP 12 → 6',
      ].join('\n')
    );
  });

  it('hides DM-only events from players', () => {
    const { events, state } = sampleSession();
    expect(renderTranscript(events, state, 'player', 50)).not.toContain('[lore]');
  });

  it('keeps only the last lines', () => {
    const { events, state } = sampleSession();
    expect(renderTranscript(events, state, 'player', 1)).toBe('[state] Tomas Reed HP 12 → 6');
  });
});

describe('describeEvent', () => {
  it('skips bookkeeping events', () => {
    const { history, state } = startedState();
    expect(describeEvent(history[0]!, state)).toBeNull();
  });
});
```

`packages/core/test/validators.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { validateDmText, validatePlayerText } from '../src/validators';

const pcNames = ['Kira Vale', 'Tomas Reed'];

describe('validateDmText', () => {
  it.each([
    'Kira decides to open the door.',
    'Tomas Reed draws his sword and charges.',
    'kira says she agrees.',
  ])('flags the DM controlling a PC: "%s"', (text) => {
    expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })?.rule).toBe(
      'dm_controls_pc'
    );
  });

  it.each([
    'The goblin deals 7 damage to you.',
    'You take 5 points of fire damage.',
    'Kira loses 3 hit points.',
    'The guard rolls a 17.',
  ])('flags invented mechanics: "%s"', (text) => {
    expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })?.rule).toBe(
      'mechanics_without_tool'
    );
  });

  it('allows numbers after a mechanics tool ran this beat', () => {
    expect(
      validateDmText('The blade bites deep for 7 damage.', { pcNames, mechanicsToolCalled: true })
    ).toBeNull();
  });

  it.each([
    'The sentry slams Tomas into the workbench.',
    'Kira, the lock clicks open under your fingers.',
    'Three crystal engines hum along the far wall.',
  ])('accepts ordinary narration: "%s"', (text) => {
    expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })).toBeNull();
  });
});

describe('validatePlayerText', () => {
  const otherPcNames = ['Kira Vale'];

  it('flags a player controlling another PC', () => {
    expect(
      validatePlayerText('Kira attacks the engine with her wrench.', { otherPcNames })?.rule
    ).toBe('player_controls_other');
  });

  it.each([
    'I successfully pick the lock.',
    'I convince the guard to let us pass.',
    'I roll a 20!',
  ])('flags a player narrating outcomes: "%s"', (text) => {
    expect(validatePlayerText(text, { otherPcNames })?.rule).toBe('player_narrates_outcome');
  });

  it.each([
    'I try to convince the guard to let us pass.',
    'Careful, Kira.',
    'I swing my longsword at the sentry.',
  ])('accepts declared attempts: "%s"', (text) => {
    expect(validatePlayerText(text, { otherPcNames })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/transcript.test.ts packages/core/test/validators.test.ts`
Expected: FAIL — Vitest cannot resolve `../src/transcript` because the implementation does not exist yet.

- [ ] **Step 3: Write the implementation**

`packages/core/src/model.ts`

```ts
import { z } from 'zod';

export const ToolCall = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ModelResponse = z.object({
  text: z.string().default(''),
  toolCalls: z.array(ToolCall).default([]),
});
export type ModelResponse = z.output<typeof ModelResponse>;

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string };

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  /** Seat id from the campaign config, e.g. "dm" or "player-kira". */
  seat: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export const LoreHit = z.object({
  chunkId: z.string().min(1),
  source: z.string().min(1),
  title: z.string().min(1),
  text: z.string(),
  score: z.number(),
});
export type LoreHit = z.infer<typeof LoreHit>;

export interface LoreIndex {
  search(query: string, limit: number): Promise<LoreHit[]>;
}
```

`packages/core/src/transcript.ts`

```ts
import type { SimEvent } from './events';
import type { GameState } from './state';

export type Audience = 'dm' | 'player';

function nameOf(id: string, state: GameState): string {
  return state.combatants[id]?.name ?? state.npcs[id]?.name ?? id;
}

/** One human-readable transcript line for an event, or null if the event is not shown. */
export function describeEvent(event: SimEvent, state: GameState): string | null {
  switch (event.type) {
    case 'narration':
      return `DM: ${event.text}`;
    case 'dialogue':
      return `${nameOf(event.speaker, state)}${event.overlaps === undefined ? '' : ' (interrupting)'}: "${event.text}"`;
    case 'action':
      return `${nameOf(event.actor, state)} attempts: ${event.intent}${event.target ? ` (target: ${nameOf(event.target, state)})` : ''}`;
    case 'pass':
      return `${nameOf(event.actor, state)} holds back.`;
    case 'roll': {
      const against = event.target === undefined ? '' : ` vs ${event.target}`;
      const outcome = event.outcome ? ` — ${event.outcome}` : '';
      return `[roll] ${event.label}: ${event.total}${against}${outcome}`;
    }
    case 'state_change':
      if (event.field === 'hp') {
        return `[state] ${nameOf(event.entity, state)} HP ${String(event.before)} → ${String(event.after)}`;
      }
      if (event.field === 'conditions') {
        const after = Array.isArray(event.after) ? event.after.join(', ') : '';
        return `[state] ${nameOf(event.entity, state)} conditions: ${after || 'none'}`;
      }
      if (event.field === 'dead' && event.after === true) {
        return `[state] ${nameOf(event.entity, state)} dies`;
      }
      return null;
    case 'scene_change':
      return `[scene] ${event.location}`;
    case 'npc_introduced':
      return `[npc] ${event.name} (npcId: ${event.npcId}): ${event.description}`;
    case 'combat_start':
      return `[combat] Initiative: ${event.order.map((e) => `${nameOf(e.combatantId, state)} ${e.total}`).join(', ')}`;
    case 'combat_turn':
      return `[combat] Round ${event.round}: ${nameOf(event.combatantId, state)}'s turn`;
    case 'combat_end':
      return '[combat] Combat ends';
    case 'lore_lookup':
      return `[lore] "${event.query}": ${event.used.length} relevant result(s)`;
    case 'lore_invention':
      return `[invented] ${event.fact}`;
    default:
      return null;
  }
}

/** The last `limit` transcript lines. Players only ever see public events. */
export function renderTranscript(
  events: readonly SimEvent[],
  state: GameState,
  audience: Audience,
  limit: number
): string {
  return events
    .filter((event) => audience === 'dm' || event.visibility === 'public')
    .map((event) => describeEvent(event, state))
    .filter((line): line is string => line !== null)
    .slice(-limit)
    .join('\n');
}
```

`packages/core/src/validators.ts`

```ts
import { escapeRegExp } from './text';

export type ViolationRule =
  'dm_controls_pc' | 'mechanics_without_tool' | 'player_controls_other' | 'player_narrates_outcome';

export interface Violation {
  rule: ViolationRule;
  message: string;
}

const CONTROL_VERBS =
  'decides?|chooses?|agrees?|attacks?|casts?|says?|shouts?|grabs?|runs?|draws?|shoots?|moves?|nods?|follows?|refuses?';

const MECHANICS =
  /\b\d+\s+(?:points?\s+of\s+)?(?:\w+\s+)?damage\b|\b(?:takes?|deals?|loses?|heals?|regains?)\s+\d+\b|\brolls?\s+(?:a\s+)?\d+\b|\b(?:hp|hit points)\b[^.]*\d/i;

const OUTCOME =
  /\b(?:successfully|succeeds?|it works|falls? dead|is (?:dead|defeated|convinced)|natural (?:20|1)|rolls? (?:a )?\d+|(?:i|we) (?:hit|kill|defeat|convince|persuade|succeed))\b/i;

/** Full names plus first names, so "Kira attacks" matches "Kira Vale". */
function nameVariants(names: readonly string[]): string[] {
  const variants = names.flatMap((name) => [name, name.split(/\s+/)[0] ?? name]);
  return [...new Set(variants)].filter((name) => name.length > 1);
}

function controlledCharacter(text: string, names: readonly string[]): string | null {
  for (const name of nameVariants(names)) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s+(?:${CONTROL_VERBS})\\b`, 'i');
    if (pattern.test(text)) return name;
  }
  return null;
}

export function validateDmText(
  text: string,
  context: { pcNames: readonly string[]; mechanicsToolCalled: boolean }
): Violation | null {
  const pc = controlledCharacter(text, context.pcNames);
  if (pc) {
    return {
      rule: 'dm_controls_pc',
      message: `Do not decide what ${pc} does or says; describe the world and let the player choose.`,
    };
  }
  if (!context.mechanicsToolCalled && MECHANICS.test(text)) {
    return {
      rule: 'mechanics_without_tool',
      message:
        'Damage, healing, HP, and roll numbers must come from a tool (attack, cast_spell, apply_damage, heal, request_check). Call the tool first, then narrate without inventing numbers.',
    };
  }
  return null;
}

export function validatePlayerText(
  text: string,
  context: { otherPcNames: readonly string[] }
): Violation | null {
  const other = controlledCharacter(text, context.otherPcNames);
  if (other) {
    return {
      rule: 'player_controls_other',
      message: `Only play your own character; do not decide what ${other} does.`,
    };
  }
  if (OUTCOME.test(text)) {
    return {
      rule: 'player_narrates_outcome',
      message: 'Declare what you attempt, not the result. The DM decides what happens.',
    };
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/transcript.test.ts packages/core/test/validators.test.ts`
Expected: PASS — 22 tests across 2 file(s).

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: `tsc` reports no errors and every test passes.

- [ ] **Step 6: Commit** (only once the user has approved commits)

```bash
git add packages/core/src/model.ts \
  packages/core/src/transcript.ts \
  packages/core/src/validators.ts \
  packages/core/test/transcript.test.ts \
  packages/core/test/validators.test.ts
git commit -m "feat(core): add model and lore interfaces, transcripts, and validators"
```

### Task 7: Tool framework and narrative DM tools

Build the typed tool layer every model action goes through, plus the DM storytelling tools and in-memory test doubles.

**Files:**

- Create: `packages/core/src/tools/types.ts`
- Create: `packages/core/src/tools/narrative.ts`
- Create: `packages/core/src/testing.ts`
- Create (test support): `packages/core/test/tool-harness.ts`
- Test: `packages/core/test/tools-narrative.test.ts`

**Interfaces:**

- Consumes: `TurnRecorder`, `GameState`, `selectResponders`, `slugify`, `Emotion`, `HandOffTarget` (Task 5); `LoreIndex`, `ToolCall`, `ToolSchema` (Task 6); `RulesError`, `Rng` (rules).
- Produces:
  - `defineTool({ name, description, parameters, narrativeText?, run })`, `type ToolDef`, `type AnyToolDef`, `type ToolContext` (`{ recorder, history, rng, lore, loreThreshold, actorId }`), `type ToolOutcome` (`{ result, endsBeat? }`)
  - `prepareToolCall(call, tools): PreparedCall`, `runPreparedCall(def, args, context)`, `toToolSchema(def)` (JSON Schema in input mode, so defaulted fields are optional), `getCombatant(state, id)`, `class ToolError`
  - Tools: `narrate`, `introduceNpc` (`introduce_npc`), `npcSay` (`npc_say`), `sceneChange` (`scene_change`), `lookupLore` (`lookup_lore`), `recordInvention` (`record_invention`), `handOff` (`hand_off`)
  - `@cartyx-sim/core/testing`: `ScriptedModelClient`, `ScriptedResponse`, `toolCall(name, args)`, `respond(...calls)`, `StaticLoreIndex`
  - Test support: `toolHarness(options)`, `SELLA_CHUNK` in `packages/core/test/tool-harness.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/tool-harness.ts`

```ts
import { scriptedRng, type Rng } from '@cartyx-sim/rules';
import type { SimEvent } from '../src/events';
import type { LoreHit, LoreIndex } from '../src/model';
import { TurnRecorder } from '../src/recorder';
import type { GameState } from '../src/state';
import { StaticLoreIndex } from '../src/testing';
import {
  prepareToolCall,
  runPreparedCall,
  type AnyToolDef,
  type ToolContext,
  type ToolOutcome,
} from '../src/tools/types';
import { now, startedState } from './helpers';

export const SELLA_CHUNK: LoreHit = {
  chunkId: 'avalon#sella-vaunt',
  source: 'kanka-export/markdown/characters/2418574-2418574.md',
  title: 'Professor Sella Vaunt',
  text: 'Professor Sella Vaunt teaches applied crystal engines at Avalon Artificers Academy.',
  score: 0,
};

export interface ToolHarness {
  recorder: TurnRecorder;
  context: ToolContext;
  run(
    tool: AnyToolDef,
    args?: Record<string, unknown>
  ): Promise<{ ok: true; outcome: ToolOutcome } | { ok: false; error: string }>;
}

/** Runs tools directly against a recorder, the way the director does, without any model. */
export function toolHarness(
  options: {
    state?: GameState;
    history?: SimEvent[];
    rng?: Rng;
    lore?: LoreIndex;
    actorId?: string;
  } = {}
): ToolHarness {
  const started = options.state
    ? { state: options.state, history: options.history ?? [] }
    : startedState();
  const recorder = new TurnRecorder(started.state, 'turn-1', now);
  const context: ToolContext = {
    recorder,
    history: started.history,
    rng: options.rng ?? scriptedRng([]),
    lore: options.lore ?? new StaticLoreIndex([SELLA_CHUNK]),
    loreThreshold: 0.35,
    actorId: options.actorId ?? 'dm',
  };
  return {
    recorder,
    context,
    async run(tool, args = {}) {
      const prepared = prepareToolCall({ id: 'test-call', name: tool.name, args }, [tool]);
      if (!prepared.ok) return prepared;
      return runPreparedCall(prepared.def, prepared.args, context);
    },
  };
}
```

`packages/core/test/tools-narrative.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  handOff,
  introduceNpc,
  lookupLore,
  narrate,
  npcSay,
  recordInvention,
  sceneChange,
} from '../src/tools/narrative';
import { toToolSchema } from '../src/tools/types';
import { toolHarness } from './tool-harness';

describe('narrate', () => {
  it('emits DM narration with a default emotion', async () => {
    const harness = toolHarness();
    expect(await harness.run(narrate, { text: 'The engines hum.' })).toEqual({
      ok: true,
      outcome: { result: 'Narrated.' },
    });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'narration',
      speaker: 'dm',
      text: 'The engines hum.',
      emotion: 'neutral',
    });
  });

  it('rejects empty text before running', async () => {
    const harness = toolHarness();
    const result = await harness.run(narrate, { text: '' });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('publishes a JSON schema where defaulted fields are optional', () => {
    expect(toToolSchema(narrate).parameters).toMatchObject({ required: ['text'] });
  });
});

describe('introduce_npc and npc_say', () => {
  it('introduces an NPC once and lets them speak', async () => {
    const harness = toolHarness();
    const intro = {
      name: 'Professor Sella Vaunt',
      description: 'Crystal engine professor',
      invented: false,
    };
    expect(await harness.run(introduceNpc, intro)).toMatchObject({
      ok: true,
      outcome: { result: 'Introduced Professor Sella Vaunt with npcId "professor-sella-vaunt".' },
    });
    expect(await harness.run(introduceNpc, intro)).toMatchObject({
      ok: true,
      outcome: { result: expect.stringContaining('already introduced') },
    });
    await harness.run(npcSay, { npcId: 'professor-sella-vaunt', text: 'Find out who.' });
    expect(harness.recorder.events.map((e) => e.type)).toEqual(['npc_introduced', 'dialogue']);
    expect(harness.recorder.events[1]).toMatchObject({
      speaker: 'professor-sella-vaunt',
      speakerKind: 'npc',
    });
  });

  it('refuses dialogue from an NPC who was never introduced', async () => {
    const harness = toolHarness();
    expect(await harness.run(npcSay, { npcId: 'ghost', text: 'Boo.' })).toEqual({
      ok: false,
      error: 'Unknown npcId "ghost". Call introduce_npc first. Known NPCs: none',
    });
  });
});

describe('scene_change', () => {
  it('moves the scene', async () => {
    const harness = toolHarness();
    await harness.run(sceneChange, { location: 'Dean’s Office', artPrompt: 'A polished office' });
    expect(harness.recorder.state.scene?.location).toBe('Dean’s Office');
  });
});

describe('lookup_lore', () => {
  it('returns relevant chunks and logs the lookup for the DM only', async () => {
    const harness = toolHarness();
    const result = await harness.run(lookupLore, { query: 'Sella Vaunt' });
    expect(result).toMatchObject({
      ok: true,
      outcome: { result: expect.stringContaining('[avalon#sella-vaunt]') },
    });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'lore_lookup',
      visibility: 'dm',
      query: 'Sella Vaunt',
      hits: [{ chunkId: 'avalon#sella-vaunt', score: 1 }],
      used: ['avalon#sella-vaunt'],
    });
  });

  it('logs a gap when nothing is relevant', async () => {
    const harness = toolHarness();
    const result = await harness.run(lookupLore, { query: 'Echor airship defenses' });
    expect(result).toMatchObject({
      ok: true,
      outcome: { result: expect.stringContaining('record_invention') },
    });
    expect(harness.recorder.events[0]).toMatchObject({ type: 'lore_lookup', used: [] });
  });
});

describe('record_invention', () => {
  it('records an invented fact for the audit', async () => {
    const harness = toolHarness();
    await harness.run(recordInvention, {
      fact: 'Engine three is named Marigold.',
      reason: 'not in lore',
    });
    expect(harness.recorder.events[0]).toMatchObject({ type: 'lore_invention', visibility: 'dm' });
  });
});

describe('hand_off', () => {
  it('ends the beat and queues the party quietest first', async () => {
    const harness = toolHarness();
    const result = await harness.run(handOff, { target: { kind: 'party' } });
    expect(result).toEqual({
      ok: true,
      outcome: { result: 'Handed off to kira, tomas.', endsBeat: true },
    });
    expect(harness.recorder.state.pendingResponders).toEqual(['kira', 'tomas']);
  });

  it('rejects unknown PC ids', async () => {
    const harness = toolHarness();
    expect(await harness.run(handOff, { target: { kind: 'pcs', ids: ['oona'] } })).toEqual({
      ok: false,
      error: 'Unknown player character ids: oona. Party ids: kira, tomas',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/tools-narrative.test.ts`
Expected: FAIL — Vitest cannot resolve `../src/tools/narrative` because the implementation does not exist yet.

- [ ] **Step 3: Write the implementation**

`packages/core/src/tools/types.ts`

```ts
import { RulesError, type Combatant, type Rng } from '@cartyx-sim/rules';
import { z } from 'zod';
import type { SimEvent } from '../events';
import type { LoreIndex, ToolCall, ToolSchema } from '../model';
import type { TurnRecorder } from '../recorder';
import type { GameState } from '../state';

/** A tool misuse the model can correct, e.g. an unknown id. Returned to the model as an error result. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ToolContext {
  recorder: TurnRecorder;
  /** Committed events before this turn. */
  history: readonly SimEvent[];
  rng: Rng;
  lore: LoreIndex;
  loreThreshold: number;
  /** "dm" or the acting PC's id. */
  actorId: string;
}

export interface ToolOutcome {
  /** Text returned to the model as the tool result. */
  result: string;
  /** True when the tool ends the DM's beat (hand_off). */
  endsBeat?: boolean;
}

/**
 * Tools must finish every check that can fail before their first `recorder.emit`, so a rejected call
 * never leaves half its events behind.
 */
export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: S;
  /** Spoken or narrated text in the arguments, checked by validators before the tool runs. */
  narrativeText?: (args: z.output<S>) => string | undefined;
  run(args: z.output<S>, context: ToolContext): ToolOutcome | Promise<ToolOutcome>;
}

// Tool lists mix parameter schemas, so they are stored with an erased schema type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any>;

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export function toToolSchema(def: AnyToolDef): ToolSchema {
  return {
    name: def.name,
    description: def.description,
    parameters: z.toJSONSchema(def.parameters, { io: 'input' }) as Record<string, unknown>,
  };
}

export type PreparedCall =
  { ok: true; def: AnyToolDef; args: unknown } | { ok: false; error: string };

export function prepareToolCall(call: ToolCall, tools: readonly AnyToolDef[]): PreparedCall {
  const def = tools.find((tool) => tool.name === call.name);
  if (!def) {
    const names = tools.map((tool) => tool.name).join(', ');
    return { ok: false, error: `Unknown tool "${call.name}". Available tools: ${names}` };
  }
  const parsed = def.parameters.safeParse(call.args);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid arguments for ${call.name}: ${z.prettifyError(parsed.error)}`,
    };
  }
  return { ok: true, def, args: parsed.data };
}

export async function runPreparedCall(
  def: AnyToolDef,
  args: unknown,
  context: ToolContext
): Promise<{ ok: true; outcome: ToolOutcome } | { ok: false; error: string }> {
  try {
    return { ok: true, outcome: await def.run(args, context) };
  } catch (error) {
    if (error instanceof ToolError || error instanceof RulesError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export function getCombatant(state: GameState, id: string): Combatant {
  const combatant = state.combatants[id];
  if (!combatant) {
    const known = Object.keys(state.combatants).join(', ') || 'none';
    throw new ToolError(`Unknown combatant id "${id}". Known ids: ${known}`);
  }
  return combatant;
}
```

`packages/core/src/tools/narrative.ts`

```ts
import { z } from 'zod';
import { Emotion, HandOffTarget } from '../events';
import { selectResponders } from '../state';
import { slugify } from '../text';
import { defineTool, ToolError } from './types';

export const LORE_RESULT_LIMIT = 8;

export const narrate = defineTool({
  name: 'narrate',
  description:
    'Speak as the Dungeon Master: describe scenes, events, and outcomes. Never decide what player characters do, say, or feel.',
  parameters: z.object({ text: z.string().min(1), emotion: Emotion.default('neutral') }),
  narrativeText: (args) => args.text,
  run(args, { recorder }) {
    recorder.emit({ type: 'narration', speaker: 'dm', text: args.text, emotion: args.emotion });
    return { result: 'Narrated.' };
  },
});

export const introduceNpc = defineTool({
  name: 'introduce_npc',
  description:
    'Introduce a non-player character before they speak. Set loreEntityId when the NPC comes from the lore; set invented to true if you made them up.',
  parameters: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    invented: z.boolean(),
    loreEntityId: z.string().min(1).optional(),
  }),
  run(args, { recorder }) {
    const npcId = slugify(args.name);
    if (!npcId) throw new ToolError(`Cannot build an id from NPC name "${args.name}"`);
    if (recorder.state.npcs[npcId]) {
      return { result: `${args.name} is already introduced; use npcId "${npcId}".` };
    }
    recorder.emit({
      type: 'npc_introduced',
      npcId,
      name: args.name,
      description: args.description,
      invented: args.invented,
      loreEntityId: args.loreEntityId,
    });
    return { result: `Introduced ${args.name} with npcId "${npcId}".` };
  },
});

export const npcSay = defineTool({
  name: 'npc_say',
  description: 'Speak a line of dialogue as an introduced NPC, using their npcId.',
  parameters: z.object({
    npcId: z.string().min(1),
    text: z.string().min(1),
    emotion: Emotion.default('neutral'),
  }),
  narrativeText: (args) => args.text,
  run(args, { recorder }) {
    const npc = recorder.state.npcs[args.npcId];
    if (!npc) {
      const known = Object.keys(recorder.state.npcs).join(', ') || 'none';
      throw new ToolError(
        `Unknown npcId "${args.npcId}". Call introduce_npc first. Known NPCs: ${known}`
      );
    }
    recorder.emit({
      type: 'dialogue',
      speaker: npc.npcId,
      speakerKind: 'npc',
      text: args.text,
      emotion: args.emotion,
    });
    return { result: `${npc.name} spoke.` };
  },
});

export const sceneChange = defineTool({
  name: 'scene_change',
  description:
    'Move the story to a new location or scene. artPrompt describes the scene for an illustrator.',
  parameters: z.object({
    location: z.string().min(1),
    artPrompt: z.string().min(1),
    loreEntityId: z.string().min(1).optional(),
  }),
  run(args, { recorder }) {
    recorder.emit({ type: 'scene_change', ...args });
    return { result: `The scene is now ${args.location}.` };
  },
});

export const lookupLore = defineTool({
  name: 'lookup_lore',
  description:
    'Search the Cartyx world lore (people, places, factions, history). Look details up before inventing them.',
  parameters: z.object({ query: z.string().min(3) }),
  async run(args, { recorder, lore, loreThreshold }) {
    const hits = await lore.search(args.query, LORE_RESULT_LIMIT);
    const used = hits.filter((hit) => hit.score >= loreThreshold);
    recorder.emit({
      type: 'lore_lookup',
      visibility: 'dm',
      query: args.query,
      hits: hits.map(({ chunkId, source, score }) => ({ chunkId, source, score })),
      used: used.map((hit) => hit.chunkId),
    });
    if (used.length === 0) {
      return {
        result:
          'No lore found. If the story needs this detail, invent something consistent with the setting and call record_invention.',
      };
    }
    return {
      result: used
        .map((hit) => `[${hit.chunkId}] ${hit.title} (${hit.source})\n${hit.text}`)
        .join('\n\n'),
    };
  },
});

export const recordInvention = defineTool({
  name: 'record_invention',
  description:
    'Record a fact you invented because the lore did not cover it, so the author can review it later.',
  parameters: z.object({
    fact: z.string().min(1),
    reason: z.string().min(1),
    query: z.string().min(1).optional(),
  }),
  run(args, { recorder }) {
    recorder.emit({ type: 'lore_invention', visibility: 'dm', ...args });
    return { result: 'Recorded.' };
  },
});

export const handOff = defineTool({
  name: 'hand_off',
  description:
    'End your turn and pass the spotlight: to specific player characters (kind "pcs" with ids), the whole party ("party"), or whoever wants to act ("open"). In combat, initiative decides who acts next.',
  parameters: z.object({ target: HandOffTarget }),
  run(args, { recorder }) {
    const { state } = recorder;
    if (args.target.kind === 'pcs') {
      const unknown = args.target.ids.filter((id) => !state.partyIds.includes(id));
      if (unknown.length > 0) {
        throw new ToolError(
          `Unknown player character ids: ${unknown.join(', ')}. Party ids: ${state.partyIds.join(', ')}`
        );
      }
    }
    const responders = selectResponders(args.target, state);
    recorder.emit({ type: 'hand_off', target: args.target, responders });
    return {
      result: responders.length > 0 ? `Handed off to ${responders.join(', ')}.` : 'Handed off.',
      endsBeat: true,
    };
  },
});
```

`packages/core/src/testing.ts`

```ts
import type {
  LoreHit,
  LoreIndex,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from './model';

export type ScriptedResponse = ModelResponse | { throw: string };

/** Replays canned responses per seat, in order. Records every request it receives. */
export class ScriptedModelClient implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private readonly queues: Map<string, ScriptedResponse[]>;

  constructor(script: Record<string, readonly ScriptedResponse[]>) {
    this.queues = new Map(
      Object.entries(script).map(([seat, responses]) => [seat, [...responses]])
    );
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const next = this.queues.get(request.seat)?.shift();
    if (!next) throw new Error(`ScriptedModelClient: no response left for seat "${request.seat}"`);
    if ('throw' in next) throw new Error(next.throw);
    return next;
  }

  remaining(seat: string): number {
    return this.queues.get(seat)?.length ?? 0;
  }
}

let callCounter = 0;

export function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  callCounter++;
  return { id: `call-${callCounter}`, name, args };
}

export function respond(...calls: ToolCall[]): ModelResponse {
  return { text: '', toolCalls: calls };
}

/** Keyword-overlap lore search over a fixed list of chunks, for tests and fixtures. */
export class StaticLoreIndex implements LoreIndex {
  constructor(private readonly chunks: readonly LoreHit[]) {}

  async search(query: string, limit: number): Promise<LoreHit[]> {
    const words = query
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 2);
    if (words.length === 0) return [];
    return this.chunks
      .map((chunk) => {
        const haystack = `${chunk.title} ${chunk.text}`.toLowerCase();
        const matches = words.filter((word) => haystack.includes(word)).length;
        return { ...chunk, score: matches / words.length };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/tools-narrative.test.ts`
Expected: PASS — 11 tests across 1 file(s).

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: `tsc` reports no errors and every test passes.

- [ ] **Step 6: Commit** (only once the user has approved commits)

```bash
git add packages/core/src/tools/types.ts \
  packages/core/src/tools/narrative.ts \
  packages/core/src/testing.ts \
  packages/core/test/tool-harness.ts \
  packages/core/test/tools-narrative.test.ts
git commit -m "feat(core): add tool framework and narrative DM tools"
```

### Task 8: Mechanics, state, and combat DM tools

Route every number through the rules package: checks, attacks, spells, damage, healing, conditions, items, and combat start/end.

**Files:**

- Create: `packages/core/src/tools/mechanics.ts`
- Create: `packages/core/src/tools/state-tools.ts`
- Create: `packages/core/src/tools/combat.ts`
- Test: `packages/core/test/tools-mechanics.test.ts`

**Interfaces:**

- Consumes: `defineTool`, `getCombatant`, `ToolError` (Task 7); `EventInput`, `TurnRecorder`, `isUp`, `StateField`, `slugify` (Task 5); rules functions from Tasks 1–4.
- Produces:
  - Tools: `requestCheck` (`request_check`), `attack`, `castSpell` (`cast_spell`), `applyDamageTool` (`apply_damage`), `healTool` (`heal`), `addConditionTool` (`add_condition`), `removeConditionTool` (`remove_condition`), `giveItem` (`give_item`), `removeItemTool` (`remove_item`), `startCombat` (`start_combat`), `endCombat` (`end_combat`)
  - `emitCombatantChanges(recorder, before, after, cause)` — one `state_change` per changed field; `formatHp(c)`; `RollModeArg`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/tools-mechanics.test.ts`

```ts
import { scriptedRng } from '@cartyx-sim/rules';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import { describe, expect, it } from 'vitest';
import { endCombat, startCombat } from '../src/tools/combat';
import { attack, castSpell, requestCheck } from '../src/tools/mechanics';
import {
  addConditionTool,
  applyDamageTool,
  giveItem,
  healTool,
  removeConditionTool,
  removeItemTool,
} from '../src/tools/state-tools';
import { kira, startedState, tomas } from './helpers';
import { toolHarness } from './tool-harness';

const goblin = makeCombatant({
  id: 'goblin-1',
  name: 'Goblin',
  kind: 'monster',
  ac: 13,
  hp: 7,
  maxHp: 7,
  abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
  attacks: [{ name: 'Scimitar', bonus: 4, damage: '1d6+2', damageType: 'slashing' }],
});

function withGoblin(rolls: number[]) {
  const { state, history } = startedState([kira, tomas]);
  return toolHarness({
    state: { ...state, combatants: { ...state.combatants, [goblin.id]: goblin } },
    history,
    rng: scriptedRng(rolls),
  });
}

describe('request_check', () => {
  it('rolls a skill check and logs the roll', async () => {
    const harness = toolHarness({ rng: scriptedRng([8]) });
    const result = await harness.run(requestCheck, {
      combatantId: 'kira',
      checkType: 'skill',
      skill: 'investigation',
      dc: 13,
      reason: 'tool marks',
    });
    expect(result).toEqual({
      ok: true,
      outcome: { result: 'Kira Vale rolled 13 (natural 8+5) against DC 13: SUCCESS.' },
    });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'roll',
      kind: 'check',
      label: 'Kira Vale Investigation check (tool marks)',
      expr: '1d20+5',
      total: 13,
      target: 13,
      outcome: 'success',
    });
  });

  it('logs saves as saves', async () => {
    const harness = toolHarness({ rng: scriptedRng([3]) });
    await harness.run(requestCheck, {
      combatantId: 'tomas',
      checkType: 'save',
      ability: 'con',
      dc: 12,
      reason: 'poison',
    });
    expect(harness.recorder.events[0]).toMatchObject({
      kind: 'save',
      total: 7,
      outcome: 'failure',
    });
  });

  it('requires the matching skill or ability', async () => {
    const harness = toolHarness();
    expect(
      await harness.run(requestCheck, {
        combatantId: 'kira',
        checkType: 'skill',
        dc: 10,
        reason: 'x',
      })
    ).toEqual({ ok: false, error: 'checkType "skill" requires skill.' });
    expect(harness.recorder.events).toHaveLength(0);
  });
});

describe('attack', () => {
  it('rolls, applies damage, and reports HP', async () => {
    const harness = withGoblin([12, 3]);
    const result = await harness.run(attack, {
      attackerId: 'tomas',
      targetId: 'goblin-1',
      attackName: 'Longsword',
    });
    expect(result).toEqual({
      ok: true,
      outcome: {
        result:
          "Tomas Reed's Longsword hits Goblin (17 vs AC 13) for 6 slashing damage. Goblin: 1/7 HP.",
      },
    });
    expect(harness.recorder.events.map((e) => e.type)).toEqual(['roll', 'roll', 'state_change']);
    expect(harness.recorder.events[2]).toMatchObject({
      entity: 'goblin-1',
      field: 'hp',
      before: 7,
      after: 1,
      cause: 'attack:tomas',
    });
  });

  it('marks a monster dead at 0 HP', async () => {
    const harness = withGoblin([15, 8]);
    await harness.run(attack, {
      attackerId: 'tomas',
      targetId: 'goblin-1',
      attackName: 'Longsword',
    });
    expect(harness.recorder.events.slice(-2)).toMatchObject([
      { field: 'hp', after: 0 },
      { field: 'dead', before: false, after: true },
    ]);
  });

  it('refuses attacks from a downed attacker', async () => {
    const { state, history } = startedState([
      { ...kira, hp: 0, conditions: ['unconscious'] },
      tomas,
    ]);
    const harness = toolHarness({ state, history });
    expect(
      await harness.run(attack, {
        attackerId: 'kira',
        targetId: 'tomas',
        attackName: 'Light Hammer',
      })
    ).toEqual({
      ok: false,
      error: 'Kira Vale cannot attack at 0 HP or while dead.',
    });
  });
});

describe('cast_spell', () => {
  it('spends a slot and resolves a spell attack', async () => {
    const ready = withGoblin([14, 6, 1, 1]);
    const cast = await ready.run(castSpell, {
      casterId: 'kira',
      spell: 'Chromatic Orb',
      slotLevel: 1,
      targetIds: ['goblin-1'],
      attack: { bonus: 5, damage: '3d8', damageType: 'fire' },
    });
    expect(cast).toEqual({
      ok: true,
      outcome: {
        result: 'Kira Vale casts Chromatic Orb using a level 1 slot: hits Goblin for 8 fire.',
      },
    });
    expect(ready.recorder.events.map((e) => [e.type, 'field' in e ? e.field : undefined])).toEqual([
      ['state_change', 'spellSlots'],
      ['roll', undefined],
      ['roll', undefined],
      ['state_change', 'hp'],
      ['state_change', 'dead'],
    ]);
  });

  it('halves damage on a successful save when asked', async () => {
    const harness = withGoblin([6, 6, 18]);
    await harness.run(castSpell, {
      casterId: 'kira',
      spell: 'Thunderwave',
      slotLevel: 1,
      targetIds: ['goblin-1'],
      save: { ability: 'con', dc: 13, damage: '2d8', damageType: 'thunder', halfOnSuccess: true },
    });
    expect(harness.recorder.state.combatants['goblin-1']?.hp).toBe(1);
  });

  it('heals targets', async () => {
    const { state, history } = startedState([kira, { ...tomas, hp: 2 }]);
    const harness = toolHarness({ state, history, rng: scriptedRng([5]) });
    await harness.run(castSpell, {
      casterId: 'kira',
      spell: 'Cure Wounds',
      slotLevel: 1,
      targetIds: ['tomas'],
      healing: '1d8+3',
    });
    expect(harness.recorder.state.combatants.tomas?.hp).toBe(10);
  });

  it('refuses a cast with no slot left, emitting nothing', async () => {
    const { state, history } = startedState([
      { ...kira, spellSlots: [{ level: 1, max: 2, used: 2 }] },
      tomas,
    ]);
    const harness = toolHarness({ state, history });
    const result = await harness.run(castSpell, {
      casterId: 'kira',
      spell: 'Shield',
      slotLevel: 1,
    });
    expect(result).toEqual({
      ok: false,
      error: 'Kira Vale has no level 1 spell slots left (slots: L1 0/2)',
    });
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('allows only one effect per cast', async () => {
    const harness = withGoblin([]);
    const result = await harness.run(castSpell, {
      casterId: 'kira',
      spell: 'Confused Spell',
      slotLevel: 0,
      targetIds: ['goblin-1'],
      healing: '1d4',
      attack: { bonus: 5, damage: '1d4', damageType: 'fire' },
    });
    expect(result).toEqual({
      ok: false,
      error: 'Use only one of attack, save, or healing in a single cast_spell call.',
    });
  });
});

describe('damage, healing, conditions, and items', () => {
  it('applies flat or rolled damage, but not both', async () => {
    const harness = toolHarness({ rng: scriptedRng([4]) });
    await harness.run(applyDamageTool, {
      targetId: 'tomas',
      dice: '1d6',
      damageType: 'fire',
      reason: 'trap',
    });
    await harness.run(applyDamageTool, {
      targetId: 'tomas',
      amount: 2,
      damageType: 'fire',
      reason: 'trap',
    });
    expect(harness.recorder.state.combatants.tomas?.hp).toBe(6);
    expect(
      await harness.run(applyDamageTool, {
        targetId: 'tomas',
        amount: 1,
        dice: '1d4',
        damageType: 'fire',
        reason: 'x',
      })
    ).toEqual({ ok: false, error: 'Provide exactly one of amount or dice for damage.' });
  });

  it('heals up to max HP', async () => {
    const { state, history } = startedState([kira, { ...tomas, hp: 9 }]);
    const harness = toolHarness({ state, history });
    expect(
      await harness.run(healTool, { targetId: 'tomas', amount: 10, reason: 'potion' })
    ).toEqual({
      ok: true,
      outcome: { result: 'Tomas Reed regains 3 HP. Tomas Reed: 12/12 HP.' },
    });
  });

  it('adds and removes conditions', async () => {
    const harness = toolHarness();
    await harness.run(addConditionTool, {
      targetId: 'kira',
      condition: 'poisoned',
      reason: 'bad stew',
    });
    expect(harness.recorder.state.combatants.kira?.conditions).toEqual(['poisoned']);
    await harness.run(removeConditionTool, {
      targetId: 'kira',
      condition: 'poisoned',
      reason: 'antidote',
    });
    expect(harness.recorder.state.combatants.kira?.conditions).toEqual([]);
    expect(
      await harness.run(removeConditionTool, { targetId: 'kira', condition: 'prone', reason: 'x' })
    ).toEqual({
      ok: false,
      error: 'Kira Vale is not prone.',
    });
  });

  it('gives and removes items', async () => {
    const harness = toolHarness();
    await harness.run(giveItem, { targetId: 'tomas', item: 'Brass Key' });
    await harness.run(removeItemTool, { targetId: 'kira', item: 'Healing Potion' });
    expect(harness.recorder.state.combatants.tomas?.inventory).toEqual([
      { name: 'Brass Key', quantity: 1 },
    ]);
    expect(harness.recorder.state.combatants.kira?.inventory).toEqual([]);
  });
});

describe('start_combat and end_combat', () => {
  const sentries = {
    monsters: [
      {
        name: 'Clockwork Sentry',
        count: 2,
        ac: 13,
        maxHp: 11,
        abilities: { dex: 12 },
        attacks: [{ name: 'Slam', bonus: 4, damage: '1d6+2', damageType: 'bludgeoning' }],
      },
    ],
  };

  it('adds monsters, rolls initiative, and fixes the order', async () => {
    const harness = toolHarness({ rng: scriptedRng([10, 5, 17, 3]) });
    const result = await harness.run(startCombat, sentries);
    expect(result).toEqual({
      ok: true,
      outcome: {
        result:
          'Combat begins. Initiative order: Clockwork Sentry 1 (clockwork-sentry-1) 18, Kira Vale (kira) 12, Tomas Reed (tomas) 6, Clockwork Sentry 2 (clockwork-sentry-2) 4.',
      },
    });
    expect(harness.recorder.events.map((e) => e.type)).toEqual([
      'combatant_added',
      'combatant_added',
      'roll',
      'roll',
      'roll',
      'roll',
      'combat_start',
    ]);
    expect(harness.recorder.state.combatants['clockwork-sentry-2']).toMatchObject({
      kind: 'monster',
      hp: 11,
    });
    expect(harness.recorder.state.combat?.order[0]?.combatantId).toBe('clockwork-sentry-1');
  });

  it('refuses to start a second combat and ends the current one', async () => {
    const harness = toolHarness({ rng: scriptedRng([10, 5, 17, 3]) });
    await harness.run(startCombat, sentries);
    expect(await harness.run(startCombat, sentries)).toEqual({
      ok: false,
      error: 'Combat is already running. Call end_combat first.',
    });
    expect(await harness.run(endCombat)).toEqual({
      ok: true,
      outcome: { result: 'Combat ended.' },
    });
    expect(await harness.run(endCombat)).toEqual({
      ok: false,
      error: 'There is no combat to end.',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/tools-mechanics.test.ts`
Expected: FAIL — Vitest cannot resolve `../src/tools/combat` because the implementation does not exist yet.

- [ ] **Step 3: Write the implementation**

`packages/core/src/tools/mechanics.ts`

```ts
import {
  Ability,
  Skill,
  applyDamage,
  applyHealing,
  formatModifier,
  resolveAttack,
  resolveCheck,
  rollAttack,
  rollDice,
  spendSlot,
  type Attack,
  type AttackResult,
  type CheckResult,
  type CheckSpec,
  type Combatant,
} from '@cartyx-sim/rules';
import { z } from 'zod';
import type { StateField } from '../events';
import type { EventInput, TurnRecorder } from '../recorder';
import { defineTool, getCombatant, ToolError } from './types';

export const RollModeArg = z.enum(['normal', 'advantage', 'disadvantage']).default('normal');

const DIFF_FIELDS = [
  'hp',
  'tempHp',
  'maxHp',
  'conditions',
  'dead',
  'spellSlots',
  'inventory',
  'level',
] as const satisfies readonly StateField[];

/** Emits one state_change per field that differs between two versions of a combatant. */
export function emitCombatantChanges(
  recorder: TurnRecorder,
  before: Combatant,
  after: Combatant,
  cause: string
): void {
  for (const field of DIFF_FIELDS) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      recorder.emit({
        type: 'state_change',
        entity: before.id,
        field,
        before: before[field],
        after: after[field],
        cause,
      });
    }
  }
}

export function formatHp(combatant: Combatant): string {
  if (combatant.dead) return 'dead';
  const conditions = combatant.conditions.length > 0 ? ` (${combatant.conditions.join(', ')})` : '';
  return `${combatant.hp}/${combatant.maxHp} HP${conditions}`;
}

function attackRollEvents(actor: string, label: string, result: AttackResult): EventInput[] {
  const events: EventInput[] = [
    {
      type: 'roll',
      actor,
      kind: 'attack',
      label,
      expr: `1d20${formatModifier(result.attack.bonus)}`,
      rolls: result.d20.rolls,
      modifier: result.attack.bonus,
      total: result.total,
      target: result.targetAc,
      outcome: result.critical ? 'critical' : result.hit ? 'hit' : 'miss',
    },
  ];
  if (result.damage) {
    events.push({
      type: 'roll',
      actor,
      kind: 'damage',
      label: `${label} damage (${result.attack.damageType})`,
      expr: result.damage.expr,
      rolls: result.damage.rolls,
      modifier: result.damage.modifier,
      total: result.damage.total,
    });
  }
  return events;
}

function checkRollEvent(combatant: Combatant, result: CheckResult, reason: string): EventInput {
  return {
    type: 'roll',
    actor: combatant.id,
    kind: result.spec.type === 'save' ? 'save' : 'check',
    label: `${combatant.name} ${result.label} (${reason})`,
    expr: `1d20${formatModifier(result.modifier)}`,
    rolls: result.d20.rolls,
    modifier: result.modifier,
    total: result.total,
    target: result.dc,
    outcome: result.success ? 'success' : 'failure',
  };
}

export const requestCheck = defineTool({
  name: 'request_check',
  description:
    'Roll an ability check, skill check, or saving throw for a combatant against a DC. The engine rolls; narrate the result afterwards.',
  parameters: z.object({
    combatantId: z.string().min(1),
    checkType: z.enum(['skill', 'ability', 'save']),
    skill: Skill.optional(),
    ability: Ability.optional(),
    dc: z.number().int().min(1).max(40),
    reason: z.string().min(1),
    mode: RollModeArg,
  }),
  run(args, { recorder, rng }) {
    const combatant = getCombatant(recorder.state, args.combatantId);
    let spec: CheckSpec;
    if (args.checkType === 'skill') {
      if (!args.skill) throw new ToolError('checkType "skill" requires skill.');
      spec = { type: 'skill', skill: args.skill };
    } else {
      if (!args.ability) throw new ToolError(`checkType "${args.checkType}" requires ability.`);
      spec =
        args.checkType === 'save'
          ? { type: 'save', ability: args.ability }
          : { type: 'ability', ability: args.ability };
    }
    const result = resolveCheck(combatant, spec, args.dc, rng, args.mode);
    recorder.emit(checkRollEvent(combatant, result, args.reason));
    return {
      result: `${combatant.name} rolled ${result.total} (natural ${result.d20.natural}${formatModifier(result.modifier)}) against DC ${args.dc}: ${result.success ? 'SUCCESS' : 'FAILURE'}.`,
    };
  },
});

export const attack = defineTool({
  name: 'attack',
  description:
    "Make a weapon or natural attack using one of the attacker's listed attacks. Rolls to hit and applies damage.",
  parameters: z.object({
    attackerId: z.string().min(1),
    targetId: z.string().min(1),
    attackName: z.string().min(1),
    mode: RollModeArg,
  }),
  run(args, { recorder, rng }) {
    const attacker = getCombatant(recorder.state, args.attackerId);
    const target = getCombatant(recorder.state, args.targetId);
    if (attacker.dead || attacker.hp === 0) {
      throw new ToolError(`${attacker.name} cannot attack at 0 HP or while dead.`);
    }
    const result = resolveAttack(attacker, target, args.attackName, rng, args.mode);
    const label = `${attacker.name} ${result.attack.name} → ${target.name}`;
    for (const event of attackRollEvents(attacker.id, label, result)) recorder.emit(event);
    emitCombatantChanges(recorder, target, result.target, `attack:${attacker.id}`);
    const verb = result.critical ? 'CRITICALLY HITS' : result.hit ? 'hits' : 'misses';
    const damage = result.damage
      ? ` for ${result.damage.total} ${result.attack.damageType} damage`
      : '';
    return {
      result: `${attacker.name}'s ${result.attack.name} ${verb} ${target.name} (${result.total} vs AC ${result.targetAc})${damage}. ${target.name}: ${formatHp(result.target)}.`,
    };
  },
});

export const castSpell = defineTool({
  name: 'cast_spell',
  description:
    'Resolve a spell. Spends a slot (slotLevel 0 for cantrips) and applies at most one effect: a spell attack, a saving throw, or healing.',
  parameters: z.object({
    casterId: z.string().min(1),
    spell: z.string().min(1),
    slotLevel: z.number().int().min(0).max(9),
    targetIds: z.array(z.string().min(1)).default([]),
    attack: z
      .object({ bonus: z.number().int(), damage: z.string().min(1), damageType: z.string().min(1) })
      .optional(),
    save: z
      .object({
        ability: Ability,
        dc: z.number().int().min(1),
        damage: z.string().min(1).optional(),
        damageType: z.string().min(1).default('force'),
        halfOnSuccess: z.boolean().default(false),
      })
      .optional(),
    healing: z.string().min(1).optional(),
    mode: RollModeArg,
  }),
  run(args, { recorder, rng }) {
    const { state } = recorder;
    const caster = getCombatant(state, args.casterId);
    const targets = args.targetIds.map((id) => getCombatant(state, id));
    const effects = [args.attack, args.save, args.healing].filter((effect) => effect !== undefined);
    if (effects.length > 1) {
      throw new ToolError('Use only one of attack, save, or healing in a single cast_spell call.');
    }
    if (effects.length === 1 && targets.length === 0) {
      throw new ToolError(`${args.spell} needs at least one targetId.`);
    }
    const deadTarget = targets.find((target) => target.dead);
    if (deadTarget) throw new ToolError(`${deadTarget.name} is dead.`);
    const casterAfterSlot = args.slotLevel > 0 ? spendSlot(caster, args.slotLevel) : caster;

    // Resolve everything before emitting, so a rules error leaves no partial events.
    const label = `${caster.name} casts ${args.spell}`;
    const rolls: EventInput[] = [];
    const updated = new Map<string, Combatant>();
    const summaries: string[] = [];
    const current = (target: Combatant) => updated.get(target.id) ?? target;

    if (args.attack) {
      const spellAttack: Attack = { name: args.spell, ...args.attack };
      for (const target of targets) {
        const result = rollAttack(spellAttack, current(target), rng, args.mode);
        rolls.push(...attackRollEvents(caster.id, `${label} → ${target.name}`, result));
        updated.set(target.id, result.target);
        const verb = result.critical ? 'critically hits' : result.hit ? 'hits' : 'misses';
        const damage = result.damage ? ` for ${result.damage.total} ${spellAttack.damageType}` : '';
        summaries.push(`${verb} ${target.name}${damage}`);
      }
    }
    if (args.save) {
      const save = args.save;
      const damage = save.damage ? rollDice(save.damage, rng) : null;
      if (damage) {
        rolls.push({
          type: 'roll',
          actor: caster.id,
          kind: 'damage',
          label: `${label} damage (${save.damageType})`,
          expr: damage.expr,
          rolls: damage.rolls,
          modifier: damage.modifier,
          total: damage.total,
        });
      }
      for (const target of targets) {
        const check = resolveCheck(
          current(target),
          { type: 'save', ability: save.ability },
          save.dc,
          rng
        );
        rolls.push(checkRollEvent(target, check, `against ${args.spell}`));
        let amount = 0;
        if (damage) {
          amount = check.success
            ? save.halfOnSuccess
              ? Math.floor(damage.total / 2)
              : 0
            : damage.total;
        }
        if (amount > 0) updated.set(target.id, applyDamage(current(target), amount));
        const taken = amount > 0 ? ` and takes ${amount} ${save.damageType}` : '';
        summaries.push(`${target.name} ${check.success ? 'saves' : 'fails'}${taken}`);
      }
    }
    if (args.healing) {
      const healing = rollDice(args.healing, rng);
      rolls.push({
        type: 'roll',
        actor: caster.id,
        kind: 'healing',
        label: `${label} healing`,
        expr: healing.expr,
        rolls: healing.rolls,
        modifier: healing.modifier,
        total: healing.total,
      });
      for (const target of targets) {
        updated.set(target.id, applyHealing(current(target), healing.total));
        summaries.push(`${target.name} regains ${healing.total} HP`);
      }
    }

    emitCombatantChanges(recorder, caster, casterAfterSlot, `spell:${args.spell}`);
    for (const roll of rolls) recorder.emit(roll);
    for (const [id, after] of updated) {
      emitCombatantChanges(recorder, recorder.state.combatants[id]!, after, `spell:${args.spell}`);
    }
    const slot = args.slotLevel > 0 ? ` using a level ${args.slotLevel} slot` : '';
    const outcome = summaries.length > 0 ? `: ${summaries.join('; ')}` : '';
    return { result: `${label}${slot}${outcome}.` };
  },
});
```

`packages/core/src/tools/state-tools.ts`

```ts
import {
  Condition,
  addCondition,
  addItem,
  applyDamage,
  applyHealing,
  removeCondition,
  removeItem,
  rollDice,
  type DiceResult,
  type Rng,
} from '@cartyx-sim/rules';
import { z } from 'zod';
import type { TurnRecorder } from '../recorder';
import { emitCombatantChanges, formatHp } from './mechanics';
import { defineTool, getCombatant, ToolError } from './types';

const AmountArgs = {
  amount: z.number().int().min(0).optional(),
  dice: z.string().min(1).optional(),
};

/** Resolves exactly one of a flat amount or a dice expression. Rolls but does not emit. */
function resolveAmount(
  args: { amount?: number; dice?: string },
  kind: 'damage' | 'healing',
  rng: Rng
): { total: number; roll: DiceResult | null } {
  if ((args.amount === undefined) === (args.dice === undefined)) {
    throw new ToolError(`Provide exactly one of amount or dice for ${kind}.`);
  }
  if (args.dice !== undefined) {
    const roll = rollDice(args.dice, rng);
    return { total: roll.total, roll };
  }
  return { total: args.amount!, roll: null };
}

function emitAmountRoll(
  recorder: TurnRecorder,
  targetId: string,
  kind: 'damage' | 'healing',
  label: string,
  roll: DiceResult | null
): void {
  if (!roll) return;
  recorder.emit({
    type: 'roll',
    actor: targetId,
    kind,
    label,
    expr: roll.expr,
    rolls: roll.rolls,
    modifier: roll.modifier,
    total: roll.total,
  });
}

export const applyDamageTool = defineTool({
  name: 'apply_damage',
  description:
    'Apply damage that did not come from attack or cast_spell (traps, falls, hazards). Give a flat amount or dice.',
  parameters: z.object({
    targetId: z.string().min(1),
    ...AmountArgs,
    damageType: z.string().min(1),
    reason: z.string().min(1),
  }),
  run(args, { recorder, rng }) {
    const target = getCombatant(recorder.state, args.targetId);
    const { total, roll } = resolveAmount(args, 'damage', rng);
    const after = applyDamage(target, total);
    emitAmountRoll(recorder, target.id, 'damage', `${args.reason} (${args.damageType})`, roll);
    emitCombatantChanges(recorder, target, after, `damage:${args.reason}`);
    return {
      result: `${target.name} takes ${total} ${args.damageType} damage. ${target.name}: ${formatHp(after)}.`,
    };
  },
});

export const healTool = defineTool({
  name: 'heal',
  description:
    'Restore hit points that did not come from cast_spell (potions, rests). Give a flat amount or dice.',
  parameters: z.object({
    targetId: z.string().min(1),
    ...AmountArgs,
    reason: z.string().min(1),
  }),
  run(args, { recorder, rng }) {
    const target = getCombatant(recorder.state, args.targetId);
    const { total, roll } = resolveAmount(args, 'healing', rng);
    const after = applyHealing(target, total);
    emitAmountRoll(recorder, target.id, 'healing', args.reason, roll);
    emitCombatantChanges(recorder, target, after, `healing:${args.reason}`);
    return {
      result: `${target.name} regains ${after.hp - target.hp} HP. ${target.name}: ${formatHp(after)}.`,
    };
  },
});

export const addConditionTool = defineTool({
  name: 'add_condition',
  description: 'Give a combatant a 5e condition such as poisoned, prone, or frightened.',
  parameters: z.object({
    targetId: z.string().min(1),
    condition: Condition,
    reason: z.string().min(1),
  }),
  run(args, { recorder }) {
    const target = getCombatant(recorder.state, args.targetId);
    emitCombatantChanges(recorder, target, addCondition(target, args.condition), args.reason);
    return { result: `${target.name} is ${args.condition}.` };
  },
});

export const removeConditionTool = defineTool({
  name: 'remove_condition',
  description: 'Remove a condition from a combatant.',
  parameters: z.object({
    targetId: z.string().min(1),
    condition: Condition,
    reason: z.string().min(1),
  }),
  run(args, { recorder }) {
    const target = getCombatant(recorder.state, args.targetId);
    if (!target.conditions.includes(args.condition)) {
      throw new ToolError(`${target.name} is not ${args.condition}.`);
    }
    emitCombatantChanges(recorder, target, removeCondition(target, args.condition), args.reason);
    return { result: `${target.name} is no longer ${args.condition}.` };
  },
});

export const giveItem = defineTool({
  name: 'give_item',
  description: "Add an item to a combatant's inventory.",
  parameters: z.object({
    targetId: z.string().min(1),
    item: z.string().min(1),
    quantity: z.number().int().min(1).default(1),
  }),
  run(args, { recorder }) {
    const target = getCombatant(recorder.state, args.targetId);
    emitCombatantChanges(recorder, target, addItem(target, args.item, args.quantity), 'give_item');
    return { result: `${target.name} receives ${args.quantity} × ${args.item}.` };
  },
});

export const removeItemTool = defineTool({
  name: 'remove_item',
  description: "Remove an item from a combatant's inventory (used, lost, or handed over).",
  parameters: z.object({
    targetId: z.string().min(1),
    item: z.string().min(1),
    quantity: z.number().int().min(1).default(1),
  }),
  run(args, { recorder }) {
    const target = getCombatant(recorder.state, args.targetId);
    const after = removeItem(target, args.item, args.quantity);
    emitCombatantChanges(recorder, target, after, 'remove_item');
    return { result: `${target.name} loses ${args.quantity} × ${args.item}.` };
  },
});
```

`packages/core/src/tools/combat.ts`

```ts
import {
  AbilityScores,
  Attack,
  Combatant,
  formatModifier,
  rollInitiative,
} from '@cartyx-sim/rules';
import { z } from 'zod';
import { isUp } from '../state';
import { slugify } from '../text';
import { defineTool, ToolError } from './types';

const MonsterSpec = z.object({
  name: z.string().min(1),
  count: z.number().int().min(1).max(12).default(1),
  ac: z.number().int().min(1),
  maxHp: z.number().int().min(1),
  abilities: AbilityScores.partial().default({}),
  attacks: z.array(Attack).min(1),
});

export const startCombat = defineTool({
  name: 'start_combat',
  description:
    'Start combat with the given monsters. The engine adds them, rolls initiative for everyone who can act, and fixes turn order.',
  parameters: z.object({ monsters: z.array(MonsterSpec).min(1) }),
  run(args, { recorder, rng }) {
    const { state } = recorder;
    if (state.combat) throw new ToolError('Combat is already running. Call end_combat first.');

    const monsters: Combatant[] = [];
    const taken = (id: string) =>
      state.combatants[id] !== undefined || monsters.some((m) => m.id === id);
    for (const spec of args.monsters) {
      const base = slugify(spec.name);
      if (!base) throw new ToolError(`Cannot build an id from monster name "${spec.name}"`);
      let suffix = 0;
      for (let n = 1; n <= spec.count; n++) {
        let id: string;
        do {
          suffix++;
          id = `${base}-${suffix}`;
        } while (taken(id));
        monsters.push(
          Combatant.parse({
            id,
            name: spec.count > 1 ? `${spec.name} ${n}` : spec.name,
            kind: 'monster',
            level: 1,
            abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, ...spec.abilities },
            proficiencyBonus: 2,
            ac: spec.ac,
            maxHp: spec.maxHp,
            hp: spec.maxHp,
            attacks: spec.attacks,
          })
        );
      }
    }

    const party = state.partyIds.map((id) => state.combatants[id]).filter(isUp);
    const participants = [...party, ...monsters];
    const order = rollInitiative(participants, rng);

    for (const monster of monsters) recorder.emit({ type: 'combatant_added', combatant: monster });
    for (const combatant of participants) {
      const entry = order.find((e) => e.combatantId === combatant.id)!;
      recorder.emit({
        type: 'roll',
        actor: combatant.id,
        kind: 'initiative',
        label: `${combatant.name} initiative`,
        expr: `1d20${formatModifier(entry.dexMod)}`,
        rolls: [entry.roll],
        modifier: entry.dexMod,
        total: entry.total,
      });
    }
    recorder.emit({ type: 'combat_start', order });

    const names = new Map(participants.map((c) => [c.id, c.name]));
    const summary = order.map((e) => `${names.get(e.combatantId)} (${e.combatantId}) ${e.total}`);
    return { result: `Combat begins. Initiative order: ${summary.join(', ')}.` };
  },
});

export const endCombat = defineTool({
  name: 'end_combat',
  description: 'End combat once the fight is over (enemies defeated, fled, or surrendered).',
  parameters: z.object({}),
  run(_args, { recorder }) {
    if (!recorder.state.combat) throw new ToolError('There is no combat to end.');
    recorder.emit({ type: 'combat_end' });
    return { result: 'Combat ended.' };
  },
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/tools-mechanics.test.ts`
Expected: PASS — 17 tests across 1 file(s).

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: `tsc` reports no errors and every test passes.

- [ ] **Step 6: Commit** (only once the user has approved commits)

```bash
git add packages/core/src/tools/mechanics.ts \
  packages/core/src/tools/state-tools.ts \
  packages/core/src/tools/combat.ts \
  packages/core/test/tools-mechanics.test.ts
git commit -m "feat(core): add mechanics, state, and combat DM tools"
```

### Task 9: Player tools, tool registry, and basic prompts

Give players their constrained tool set, assemble the tool lists the director offers each seat, and add replaceable default prompts.

**Files:**

- Create: `packages/core/src/tools/player.ts`
- Create: `packages/core/src/tools/registry.ts`
- Create: `packages/core/src/prompts.ts`
- Test: `packages/core/test/tools-player.test.ts`

**Interfaces:**

- Consumes: All tools from Tasks 7–8; `Emotion`, `countWords` (Task 5); `ChatMessage` (Task 6); `slotsRemaining`, `describeSlots` (rules).
- Produces:
  - Tools: `speak`, `act`, `interject` (≤ 12 words, sets `overlaps` to the latest spoken line by someone else), `declareSpell` (`declare_spell`), `pass`; `INTERJECTION_MAX_WORDS`
  - `DM_TOOLS`, `PLAYER_TOOLS`, `MECHANICS_TOOL_NAMES`, `TURN_ACTION_TOOL_NAMES`
  - `interface PromptBuilder { dm(input); player(input & { pc }) }`, `PromptInput`, `basicPrompts` (Plan 2 replaces it with lore- and persona-rich prompts)

- [ ] **Step 1: Write the failing tests**

`packages/core/test/tools-player.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { TurnRecorder } from '../src/recorder';
import { act, declareSpell, interject, pass, speak } from '../src/tools/player';
import { kira, now, startedState, tomas } from './helpers';
import { toolHarness } from './tool-harness';

function kiraHarness(options: { spoken?: boolean; slotsUsed?: number } = {}) {
  const started = startedState([
    { ...kira, spellSlots: [{ level: 1, max: 2, used: options.slotsUsed ?? 0 }] },
    tomas,
  ]);
  let { state, history } = started;
  if (options.spoken) {
    const recorder = new TurnRecorder(state, 'dm-turn', now);
    recorder.emit({
      type: 'narration',
      speaker: 'dm',
      text: 'The door bursts open.',
      emotion: 'excited',
    });
    state = recorder.state;
    history = [...history, ...recorder.events];
  }
  return toolHarness({ state, history, actorId: 'kira' });
}

describe('player tools', () => {
  it('speak emits PC dialogue', async () => {
    const harness = kiraHarness();
    await harness.run(speak, { text: 'Who is there?', emotion: 'afraid' });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'dialogue',
      speaker: 'kira',
      speakerKind: 'pc',
      emotion: 'afraid',
    });
  });

  it('act declares an attempt', async () => {
    const harness = kiraHarness();
    await harness.run(act, { intent: 'check the door for traps', targetId: 'door' });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'action',
      actor: 'kira',
      target: 'door',
    });
  });

  it('interject overlaps the most recent line from someone else', async () => {
    const harness = kiraHarness({ spoken: true });
    await harness.run(interject, { text: 'Wait—!' });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'dialogue',
      overlaps: 1,
      emotion: 'surprised',
    });
  });

  it('interject needs a line to overlap and stays short', async () => {
    expect(await kiraHarness().run(interject, { text: 'Wait!' })).toEqual({
      ok: false,
      error: 'There is no line to interject over yet.',
    });
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen';
    expect(await kiraHarness({ spoken: true }).run(interject, { text: long })).toEqual({
      ok: false,
      error: 'Interjections must be 12 words or fewer.',
    });
  });

  it('declare_spell checks slots but leaves resolution to the DM', async () => {
    const harness = kiraHarness();
    await harness.run(declareSpell, {
      spell: 'Magic Missile',
      slotLevel: 1,
      targetIds: ['sentry-1'],
    });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'action',
      intent: 'casts Magic Missile at level 1 targeting sentry-1',
    });
    expect(harness.recorder.state.combatants.kira?.spellSlots[0]?.used).toBe(0);
    expect(
      await kiraHarness({ slotsUsed: 2 }).run(declareSpell, { spell: 'Shield', slotLevel: 1 })
    ).toEqual({
      ok: false,
      error: 'You have no level 1 spell slots left (slots: L1 0/2).',
    });
  });

  it('pass emits a pass', async () => {
    const harness = kiraHarness();
    await harness.run(pass);
    expect(harness.recorder.events[0]).toMatchObject({ type: 'pass', actor: 'kira' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/tools-player.test.ts`
Expected: FAIL — Vitest cannot resolve `../src/tools/player` because the implementation does not exist yet.

- [ ] **Step 3: Write the implementation**

`packages/core/src/tools/player.ts`

```ts
import { describeSlots, slotsRemaining } from '@cartyx-sim/rules';
import { z } from 'zod';
import { Emotion } from '../events';
import { countWords } from '../text';
import { defineTool, getCombatant, ToolError } from './types';

export const INTERJECTION_MAX_WORDS = 12;

export const speak = defineTool({
  name: 'speak',
  description: 'Say something out loud, in character, as your own character.',
  parameters: z.object({ text: z.string().min(1), emotion: Emotion.default('neutral') }),
  narrativeText: (args) => args.text,
  run(args, { recorder, actorId }) {
    recorder.emit({
      type: 'dialogue',
      speaker: actorId,
      speakerKind: 'pc',
      text: args.text,
      emotion: args.emotion,
    });
    return { result: 'Said.' };
  },
});

export const act = defineTool({
  name: 'act',
  description:
    'Declare what your character attempts. Describe the attempt only; the DM decides what happens.',
  parameters: z.object({ intent: z.string().min(1), targetId: z.string().min(1).optional() }),
  narrativeText: (args) => args.intent,
  run(args, { recorder, actorId }) {
    recorder.emit({ type: 'action', actor: actorId, intent: args.intent, target: args.targetId });
    return { result: 'Declared.' };
  },
});

export const interject = defineTool({
  name: 'interject',
  description: `A short reaction (at most ${INTERJECTION_MAX_WORDS} words) that overlaps the most recent line, like "Wait—!" or a laugh. Does not use up your turn.`,
  parameters: z.object({ text: z.string().min(1), emotion: Emotion.default('surprised') }),
  narrativeText: (args) => args.text,
  run(args, { recorder, history, actorId }) {
    if (countWords(args.text) > INTERJECTION_MAX_WORDS) {
      throw new ToolError(`Interjections must be ${INTERJECTION_MAX_WORDS} words or fewer.`);
    }
    const spoken = [...history, ...recorder.events]
      .reverse()
      .find(
        (event) =>
          (event.type === 'narration' || event.type === 'dialogue') && event.speaker !== actorId
      );
    if (!spoken) throw new ToolError('There is no line to interject over yet.');
    recorder.emit({
      type: 'dialogue',
      speaker: actorId,
      speakerKind: 'pc',
      text: args.text,
      emotion: args.emotion,
      overlaps: spoken.seq,
    });
    return { result: 'Interjected.' };
  },
});

export const declareSpell = defineTool({
  name: 'declare_spell',
  description:
    'Declare that you cast a spell (slotLevel 0 for cantrips) at optional targets. The DM resolves the effect.',
  parameters: z.object({
    spell: z.string().min(1),
    slotLevel: z.number().int().min(0).max(9),
    targetIds: z.array(z.string().min(1)).default([]),
  }),
  run(args, { recorder, actorId }) {
    const caster = getCombatant(recorder.state, actorId);
    if (args.slotLevel > 0 && slotsRemaining(caster, args.slotLevel) < 1) {
      throw new ToolError(
        `You have no level ${args.slotLevel} spell slots left (slots: ${describeSlots(caster) || 'none'}).`
      );
    }
    const level = args.slotLevel > 0 ? ` at level ${args.slotLevel}` : '';
    const targets = args.targetIds.length > 0 ? ` targeting ${args.targetIds.join(', ')}` : '';
    recorder.emit({
      type: 'action',
      actor: actorId,
      intent: `casts ${args.spell}${level}${targets}`,
      target: args.targetIds[0],
    });
    return { result: 'Spell declared; the DM will resolve it.' };
  },
});

export const pass = defineTool({
  name: 'pass',
  description: 'Do nothing this turn.',
  parameters: z.object({}),
  run(_args, { recorder, actorId }) {
    recorder.emit({ type: 'pass', actor: actorId });
    return { result: 'Passed.' };
  },
});
```

`packages/core/src/tools/registry.ts`

```ts
import { endCombat, startCombat } from './combat';
import { attack, castSpell, requestCheck } from './mechanics';
import {
  handOff,
  introduceNpc,
  lookupLore,
  narrate,
  npcSay,
  recordInvention,
  sceneChange,
} from './narrative';
import { act, declareSpell, interject, pass, speak } from './player';
import {
  addConditionTool,
  applyDamageTool,
  giveItem,
  healTool,
  removeConditionTool,
  removeItemTool,
} from './state-tools';
import type { AnyToolDef } from './types';

export const DM_TOOLS: readonly AnyToolDef[] = [
  narrate,
  introduceNpc,
  npcSay,
  sceneChange,
  lookupLore,
  recordInvention,
  requestCheck,
  attack,
  castSpell,
  applyDamageTool,
  healTool,
  addConditionTool,
  removeConditionTool,
  giveItem,
  removeItemTool,
  startCombat,
  endCombat,
  handOff,
];

export const PLAYER_TOOLS: readonly AnyToolDef[] = [speak, act, interject, declareSpell, pass];

/** Tools whose results may legitimately include numbers in the DM's following narration. */
export const MECHANICS_TOOL_NAMES: ReadonlySet<string> = new Set([
  'request_check',
  'attack',
  'cast_spell',
  'apply_damage',
  'heal',
]);

/** A player's turn counts only if it includes at least one of these. */
export const TURN_ACTION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'speak',
  'act',
  'declare_spell',
  'pass',
]);
```

`packages/core/src/prompts.ts`

```ts
import type { Combatant } from '@cartyx-sim/rules';
import type { ChatMessage } from './model';
import type { GameState } from './state';

export interface PromptInput {
  state: GameState;
  transcript: string;
  instruction: string;
}

/** Builds the messages for each seat. Plan 2 replaces `basicPrompts` with lore- and persona-rich prompts. */
export interface PromptBuilder {
  dm(input: PromptInput): ChatMessage[];
  player(input: PromptInput & { pc: Combatant }): ChatMessage[];
}

const DM_SYSTEM = [
  'You are the Dungeon Master for a Dungeons & Dragons 5e session.',
  'Act only through tools. Narrate with narrate, voice NPCs with npc_say after introduce_npc, and end every turn with hand_off.',
  'All dice, damage, healing, HP, conditions, and spell slots go through tools. Never invent numbers in narration.',
  'Never decide what a player character does, says, thinks, or feels.',
  'Look up lore with lookup_lore before inventing details, and record anything you invent with record_invention.',
].join('\n');

function describeCombatant(combatant: Combatant): string {
  const health = combatant.dead ? 'DEAD' : `HP ${combatant.hp}/${combatant.maxHp}`;
  const conditions = combatant.conditions.length > 0 ? `, ${combatant.conditions.join(', ')}` : '';
  return `- ${combatant.name} (id: ${combatant.id}) ${health}, AC ${combatant.ac}${conditions}`;
}

export const basicPrompts: PromptBuilder = {
  dm({ state, transcript, instruction }) {
    const party = state.partyIds
      .map((id) => state.combatants[id])
      .filter((combatant) => combatant !== undefined)
      .map(describeCombatant);
    const others = Object.values(state.combatants)
      .filter((combatant) => combatant.kind !== 'pc')
      .map(describeCombatant);
    const npcs = Object.values(state.npcs).map((npc) => `- ${npc.name} (npcId: ${npc.npcId})`);
    return [
      { role: 'system', content: DM_SYSTEM },
      {
        role: 'user',
        content: [
          `Party:\n${party.join('\n')}`,
          `Other combatants:\n${others.join('\n') || '- none'}`,
          `NPCs:\n${npcs.join('\n') || '- none'}`,
          `Scene: ${state.scene?.location ?? 'not set'}`,
          `Recent events:\n${transcript || '(the session is just starting)'}`,
          instruction,
        ].join('\n\n'),
      },
    ];
  },
  player({ pc, transcript, instruction }) {
    return [
      {
        role: 'system',
        content: [
          `You are playing ${pc.name} (id: ${pc.id}) in a Dungeons & Dragons 5e session.`,
          'Stay in character. Use speak for dialogue and act to declare what you attempt; use pass if your character does nothing.',
          'Only ever control your own character, and never describe the outcome of your actions: the DM decides what happens.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Your character:\n${describeCombatant(pc)}`,
          `Recent events:\n${transcript || '(nothing yet)'}`,
          instruction,
        ].join('\n\n'),
      },
    ];
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/tools-player.test.ts`
Expected: PASS — 6 tests across 1 file(s).

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: `tsc` reports no errors and every test passes.
The registry and prompts have no direct tests here; the director tests in Task 10 exercise both end to end.

- [ ] **Step 6: Commit** (only once the user has approved commits)

```bash
git add packages/core/src/tools/player.ts \
  packages/core/src/tools/registry.ts \
  packages/core/src/prompts.ts \
  packages/core/test/tools-player.test.ts
git commit -m "feat(core): add player tools, tool registry, and basic prompts"
```

### Task 10: Director turn loop with validators, clock, and resume

Run whole sessions: turn scheduling, DM beats and player turns over tool calls, validator retries, combat advancement, clock-driven endings, model retry and pause, and resume from the log.

**Files:**

- Create: `packages/core/src/director.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/test/director.test.ts`

**Interfaces:**

- Consumes: Everything in `core` from Tasks 5–9.
- Produces:
  - `Director.create(config: DirectorConfig, deps: DirectorDeps): Promise<Director>` — reads the sink and resumes if events exist; throws if the session already ended or belongs to another session number
  - `director.run(maxTurns?): Promise<RunResult>` where `RunResult` is `{ status: 'ended' | 'turn_limit'; state }` or `{ status: 'paused'; state; seat; error }`; `director.step()`, `director.currentState`, `director.events`
  - `DirectorConfig`: `session`, `targetMinutes`, `loreCommit`, `party`, `seats: { dm, players: Record<pcId, seatId> }`, optional `loreThreshold` (0.35), `maxDmStepsPerBeat` (12), `maxValidatorRetries` (2), `transcriptWindow` (30), `silentTurnLimit` (6), `retryDelaysMs` ([1000, 4000, 15000])
  - `DirectorDeps`: `model`, `lore`, `rng`, `sink`, `prompts`, optional `now`, `newTurnId`, `sleep`, `onCommit(events, state)`
  - `@cartyx-sim/core` now exports the public API from `src/index.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/director.test.ts`

```ts
import { scriptedRng } from '@cartyx-sim/rules';
import { describe, expect, it } from 'vitest';
import { Director, type DirectorConfig, type DirectorDeps } from '../src/director';
import type { SimEvent } from '../src/events';
import { basicPrompts } from '../src/prompts';
import { MemorySink } from '../src/sink';
import { foldEvents } from '../src/state';
import {
  respond,
  ScriptedModelClient,
  StaticLoreIndex,
  toolCall,
  type ScriptedResponse,
} from '../src/testing';
import { kira, now, tomas } from './helpers';
import { SELLA_CHUNK } from './tool-harness';

function config(overrides: Partial<DirectorConfig> = {}): DirectorConfig {
  return {
    session: 1,
    targetMinutes: 60,
    loreCommit: 'abc123',
    party: [kira, tomas],
    seats: { dm: 'dm', players: { kira: 'player-kira', tomas: 'player-tomas' } },
    retryDelaysMs: [],
    ...overrides,
  };
}

function deps(
  script: Record<string, ScriptedResponse[]>,
  options: {
    sink?: MemorySink;
    rolls?: number[];
    turnPrefix?: string;
    sleep?: DirectorDeps['sleep'];
  } = {}
) {
  let turn = 0;
  const model = new ScriptedModelClient(script);
  const sink = options.sink ?? new MemorySink();
  const built: DirectorDeps = {
    model,
    lore: new StaticLoreIndex([SELLA_CHUNK]),
    rng: scriptedRng(options.rolls ?? []),
    sink,
    prompts: basicPrompts,
    now,
    newTurnId: () => `${options.turnPrefix ?? 'turn'}-${++turn}`,
    sleep: options.sleep ?? (async () => {}),
  };
  return { deps: built, model, sink };
}

function lastUserMessage(request: { messages: { role: string; content: string }[] }): string {
  return request.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
}

/** Every turn's events must be contiguous and seqs must count up from 0 without gaps. */
function expectWellFormedLog(events: readonly SimEvent[]) {
  expect(events.map((e) => e.seq)).toEqual(events.map((_, index) => index));
  const finished = new Set<string>();
  let current: string | undefined;
  for (const event of events) {
    if (event.turnId !== current) {
      expect(finished.has(event.turnId)).toBe(false);
      if (current) finished.add(current);
      current = event.turnId;
    }
  }
}

describe('Director', () => {
  it('plays a scripted session from start to cliffhanger', async () => {
    const script = {
      dm: [
        respond(
          toolCall('scene_change', {
            location: 'Avalon Artificers Academy — Crystal Engine Lab',
            artPrompt: 'A brass-and-crystal workshop lit by humming engines',
          }),
          toolCall('lookup_lore', { query: 'Sella Vaunt' })
        ),
        respond(
          toolCall('introduce_npc', {
            name: 'Professor Sella Vaunt',
            description: 'Avalon instructor of applied crystal engines',
            invented: false,
            loreEntityId: '2418574',
          }),
          toolCall('npc_say', {
            npcId: 'professor-sella-vaunt',
            text: 'Someone has tampered with engine three. Find out who.',
            emotion: 'angry',
          }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
        respond(
          toolCall('request_check', {
            combatantId: 'kira',
            checkType: 'skill',
            skill: 'investigation',
            dc: 13,
            reason: 'spot tool marks',
          })
        ),
        respond(
          toolCall('narrate', { text: 'You find fresh scratches from an Avalon-issue spanner.' }),
          toolCall('start_combat', {
            monsters: [
              {
                name: 'Clockwork Sentry',
                ac: 13,
                maxHp: 11,
                attacks: [{ name: 'Slam', bonus: 4, damage: '1d6+2', damageType: 'bludgeoning' }],
              },
            ],
          })
        ),
        respond(toolCall('hand_off', { target: { kind: 'party' } })),
        respond(
          toolCall('attack', {
            attackerId: 'clockwork-sentry-1',
            targetId: 'tomas',
            attackName: 'Slam',
          })
        ),
        respond(
          toolCall('narrate', { text: 'The sentry slams Tomas into the workbench.' }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
        respond(
          toolCall('attack', {
            attackerId: 'kira',
            targetId: 'clockwork-sentry-1',
            attackName: 'Light Hammer',
          })
        ),
        respond(
          toolCall('narrate', { text: 'The sentry collapses in a shower of sparks.' }),
          toolCall('end_combat'),
          toolCall('scene_change', {
            location: "Avalon Artificers Academy — Dean's Office",
            artPrompt: 'A polished office overlooking the artificer barns',
          }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
      ],
      'player-kira': [
        respond(
          toolCall('speak', {
            text: 'Engine three? I calibrated it this morning.',
            emotion: 'surprised',
          }),
          toolCall('act', { intent: 'inspect the engine housing for tool marks' })
        ),
        respond(
          toolCall('act', {
            intent: 'strike the sentry with my light hammer',
            targetId: 'clockwork-sentry-1',
          })
        ),
      ],
      'player-tomas': [
        respond(toolCall('speak', { text: 'Kira attacks the engine with her wrench.' })),
        respond(toolCall('speak', { text: 'Careful, Kira.' }), toolCall('pass')),
      ],
    };
    // d20 check 15; initiative kira 12, tomas 5, sentry 18; sentry hits (16) for 4+2; kira crits (20) for 4+4+3.
    const { deps: built, model, sink } = deps(script, { rolls: [15, 12, 5, 18, 16, 4, 20, 4, 4] });
    const director = await Director.create(config({ targetMinutes: 0.25 }), built);

    const result = await director.run();

    expect(result.status).toBe('ended');
    expect(sink.events.map((e) => e.type)).toEqual([
      'session_start',
      'scene_change',
      'lore_lookup',
      'npc_introduced',
      'dialogue',
      'hand_off',
      'turn_end',
      'dialogue',
      'action',
      'turn_end',
      'dialogue',
      'pass',
      'turn_end',
      'roll',
      'narration',
      'combatant_added',
      'roll',
      'roll',
      'roll',
      'combat_start',
      'hand_off',
      'turn_end',
      'roll',
      'roll',
      'state_change',
      'narration',
      'hand_off',
      'combat_turn',
      'turn_end',
      'action',
      'turn_end',
      'roll',
      'roll',
      'state_change',
      'state_change',
      'narration',
      'combat_end',
      'scene_change',
      'hand_off',
      'turn_end',
      'session_end',
    ]);
    expect(sink.events.at(-1)).toMatchObject({ type: 'session_end', reason: 'target_reached' });
    expectWellFormedLog(sink.events);

    const state = director.currentState;
    expect(state.combatants.tomas?.hp).toBe(6);
    expect(state.combatants['clockwork-sentry-1']).toMatchObject({ hp: 0, dead: true });
    expect(state.combat).toBeNull();
    expect(state.scene?.location).toBe("Avalon Artificers Academy — Dean's Office");
    expect(foldEvents(sink.events)).toEqual(state);
    for (const seat of ['dm', 'player-kira', 'player-tomas']) expect(model.remaining(seat)).toBe(0);

    const kiraFirst = model.requests.find((r) => r.seat === 'player-kira')!;
    expect(lastUserMessage(kiraFirst)).toContain(
      'Professor Sella Vaunt: "Someone has tampered with engine three. Find out who."'
    );
    expect(lastUserMessage(kiraFirst)).not.toContain('[lore]');

    const tomasRetry = model.requests.filter((r) => r.seat === 'player-tomas')[1]!;
    expect(tomasRetry.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('Not executed. player_controls_other'),
    });

    const dmRequests = model.requests.filter((r) => r.seat === 'dm');
    expect(lastUserMessage(dmRequests[5]!)).not.toContain('nearing its time limit');
    expect(lastUserMessage(dmRequests[7]!)).toContain('nearing its time limit');
  });

  it('re-prompts the DM after a rejection and forces hand_off at the step limit', async () => {
    const {
      deps: built,
      model,
      sink,
    } = deps({
      dm: [
        respond(toolCall('narrate', { text: 'Kira decides to open the door.' })),
        respond(toolCall('narrate', { text: 'The door creaks.' })),
      ],
    });
    const director = await Director.create(config({ maxDmStepsPerBeat: 2 }), built);
    await director.step();
    await director.step();

    expect(sink.events.slice(1).map((e) => e.type)).toEqual([
      'narration',
      'validator_flag',
      'hand_off',
      'turn_end',
    ]);
    expect(sink.events[1]).toMatchObject({ text: 'The door creaks.' });
    expect(sink.events[2]).toMatchObject({ rule: 'dm_step_limit', resolution: 'forced_hand_off' });
    expect(model.requests[1]!.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('Rejected (dm_controls_pc)'),
    });
  });

  it('treats a text-only DM reply as narration', async () => {
    const { deps: built, sink } = deps({
      dm: [
        { text: 'The engines roar to life.', toolCalls: [] },
        respond(toolCall('hand_off', { target: { kind: 'pcs', ids: ['tomas'] } })),
      ],
    });
    const director = await Director.create(config(), built);
    await director.step();
    await director.step();
    expect(sink.events.slice(1, 3)).toMatchObject([
      { type: 'narration', text: 'The engines roar to life.' },
      { type: 'hand_off', responders: ['tomas'] },
    ]);
  });

  it('forces a pass after a player keeps breaking the rules', async () => {
    const outcome = respond(toolCall('speak', { text: 'I successfully pick the lock.' }));
    const { deps: built, sink } = deps({
      dm: [respond(toolCall('hand_off', { target: { kind: 'pcs', ids: ['tomas'] } }))],
      'player-tomas': [outcome, outcome, outcome],
    });
    const director = await Director.create(config(), built);
    await director.run(3);
    expect(sink.events.slice(-3)).toMatchObject([
      {
        type: 'validator_flag',
        rule: 'player_narrates_outcome',
        retries: 2,
        resolution: 'forced_pass',
      },
      { type: 'pass', actor: 'tomas' },
      { type: 'turn_end', actor: 'tomas' },
    ]);
  });

  it('ends at the hard stop even without a scene break', async () => {
    const { deps: built, sink } = deps({
      dm: [
        respond(
          toolCall('narrate', { text: 'The engines roar to life all around you.' }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
      ],
    });
    const director = await Director.create(config({ targetMinutes: 0.02 }), built);
    expect((await director.run()).status).toBe('ended');
    expect(sink.events.at(-1)).toMatchObject({ type: 'session_end', reason: 'hard_stop' });
  });

  it('pauses when a seat keeps failing and resumes from the log', async () => {
    const sink = new MemorySink();
    const sleeps: number[] = [];
    const first = deps(
      {
        dm: [
          respond(
            toolCall('narrate', { text: 'The lab hums.' }),
            toolCall('hand_off', { target: { kind: 'pcs', ids: ['kira'] } })
          ),
        ],
        'player-kira': [{ throw: 'connection refused' }, { throw: 'connection refused' }],
      },
      { sink, sleep: async (ms) => void sleeps.push(ms) }
    );
    const paused = await (await Director.create(config({ retryDelaysMs: [5] }), first.deps)).run();

    expect(paused).toMatchObject({
      status: 'paused',
      seat: 'player-kira',
      error: 'connection refused',
    });
    expect(sleeps).toEqual([5]);
    expect(sink.events.map((e) => e.type)).toEqual([
      'session_start',
      'narration',
      'hand_off',
      'turn_end',
      'ooc_note',
    ]);

    const second = deps(
      {
        'player-kira': [respond(toolCall('speak', { text: 'Sorry, I was daydreaming.' }))],
        dm: [
          respond(
            toolCall('narrate', { text: 'Sella clears her throat.' }),
            toolCall('hand_off', { target: { kind: 'pcs', ids: ['kira'] } })
          ),
        ],
      },
      { sink, turnPrefix: 'resumed' }
    );
    const resumed = await Director.create(config(), second.deps);
    expect((await resumed.run(2)).status).toBe('turn_limit');

    expect(sink.events.slice(5).map((e) => e.type)).toEqual([
      'ooc_note',
      'dialogue',
      'turn_end',
      'narration',
      'hand_off',
      'turn_end',
    ]);
    expectWellFormedLog(sink.events);
    expect(foldEvents(sink.events)).toEqual(resumed.currentState);
  });

  it('refuses to resume a finished session or a different session number', async () => {
    const { deps: built, sink } = deps({
      dm: [
        respond(
          toolCall('narrate', { text: 'The engines roar to life all around you.' }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
      ],
    });
    await (await Director.create(config({ targetMinutes: 0.02 }), built)).run();
    await expect(Director.create(config(), { ...built, sink })).rejects.toThrow(
      'Session 1 has already ended'
    );

    const other = new MemorySink();
    await other.append(sink.events.slice(0, 1));
    await expect(
      Director.create(config({ session: 2 }), { ...built, sink: other })
    ).rejects.toThrow('Event log belongs to session 1, not session 2');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/director.test.ts`
Expected: FAIL — Vitest cannot resolve `../src/director` because the implementation does not exist yet.

- [ ] **Step 3: Write the implementation**

`packages/core/src/director.ts`

```ts
import type { Combatant, Rng } from '@cartyx-sim/rules';
import { clockInstruction, clockPhase } from './clock';
import type { SimEvent } from './events';
import type {
  ChatMessage,
  LoreIndex,
  ModelClient,
  ModelResponse,
  ToolCall,
  ToolSchema,
} from './model';
import type { PromptBuilder } from './prompts';
import { TurnRecorder } from './recorder';
import type { EventSink } from './sink';
import { advanceCombat, foldEvents, nextActor, type GameState } from './state';
import {
  DM_TOOLS,
  MECHANICS_TOOL_NAMES,
  PLAYER_TOOLS,
  TURN_ACTION_TOOL_NAMES,
} from './tools/registry';
import {
  prepareToolCall,
  runPreparedCall,
  toToolSchema,
  type AnyToolDef,
  type ToolContext,
} from './tools/types';
import { renderTranscript, type Audience } from './transcript';
import { validateDmText, validatePlayerText } from './validators';

export interface DirectorConfig {
  session: number;
  targetMinutes: number;
  loreCommit: string;
  party: Combatant[];
  /** Seat ids for the DM and for each PC id. */
  seats: { dm: string; players: Record<string, string> };
  /** Minimum lore search score treated as relevant. Default 0.35. */
  loreThreshold?: number;
  /** Model calls allowed in one DM beat before hand_off is forced. Default 12. */
  maxDmStepsPerBeat?: number;
  /** Re-prompts after a validator rejection before accepting with a flag. Default 2. */
  maxValidatorRetries?: number;
  /** Transcript lines included in prompts. Default 30. */
  transcriptWindow?: number;
  /** Consecutive silent turns before the DM is nudged to narrate. Default 6. */
  silentTurnLimit?: number;
  /** Waits between retries of a failing model call; the session pauses after the last. */
  retryDelaysMs?: number[];
}

export interface DirectorDeps {
  model: ModelClient;
  lore: LoreIndex;
  rng: Rng;
  sink: EventSink;
  prompts: PromptBuilder;
  now?: () => Date;
  newTurnId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  onCommit?: (events: readonly SimEvent[], state: GameState) => void;
}

export type RunResult =
  | { status: 'ended' | 'turn_limit'; state: GameState }
  | { status: 'paused'; state: GameState; seat: string; error: string };

export class SessionPausedError extends Error {
  constructor(
    readonly seat: string,
    readonly reason: string
  ) {
    super(`Seat "${seat}" failed: ${reason}`);
    this.name = 'SessionPausedError';
  }
}

const DM_TOOL_SCHEMAS: ToolSchema[] = DM_TOOLS.map(toToolSchema);
const PLAYER_TOOL_SCHEMAS: ToolSchema[] = PLAYER_TOOLS.map(toToolSchema);

function toolMessage(call: ToolCall, content: string): ChatMessage {
  return { role: 'tool', toolCallId: call.id, toolName: call.name, content };
}

/** A text-only response is treated as a call to the seat's main speaking tool. */
function callsFromResponse(response: ModelResponse, fallbackTool: string, id: string): ToolCall[] {
  if (response.toolCalls.length > 0) return response.toolCalls;
  const text = response.text.trim();
  return text ? [{ id, name: fallbackTool, args: { text } }] : [];
}

export class Director {
  private state: GameState;
  private readonly history: SimEvent[];
  private readonly loreThreshold: number;
  private readonly maxDmStepsPerBeat: number;
  private readonly maxValidatorRetries: number;
  private readonly transcriptWindow: number;
  private readonly silentTurnLimit: number;
  private readonly retryDelaysMs: number[];
  private readonly now: () => Date;
  private readonly newTurnId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;

  private constructor(
    private readonly config: DirectorConfig,
    private readonly deps: DirectorDeps,
    prior: readonly SimEvent[]
  ) {
    this.history = [...prior];
    this.state = foldEvents(prior);
    this.loreThreshold = config.loreThreshold ?? 0.35;
    this.maxDmStepsPerBeat = config.maxDmStepsPerBeat ?? 12;
    this.maxValidatorRetries = config.maxValidatorRetries ?? 2;
    this.transcriptWindow = config.transcriptWindow ?? 30;
    this.silentTurnLimit = config.silentTurnLimit ?? 6;
    this.retryDelaysMs = config.retryDelaysMs ?? [1000, 4000, 15000];
    this.now = deps.now ?? (() => new Date());
    this.newTurnId = deps.newTurnId ?? (() => crypto.randomUUID());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Loads any existing events from the sink and resumes from them. */
  static async create(config: DirectorConfig, deps: DirectorDeps): Promise<Director> {
    const prior = await deps.sink.readAll();
    const director = new Director(config, deps, prior);
    const { state } = director;
    if (state.ended) throw new Error(`Session ${state.session} has already ended`);
    if (state.session !== null && state.session !== config.session) {
      throw new Error(
        `Event log belongs to session ${state.session}, not session ${config.session}`
      );
    }
    if (prior.length > 0) {
      const recorder = director.newRecorder();
      recorder.emit({ type: 'ooc_note', visibility: 'dm', text: 'Session resumed.' });
      await director.commit(recorder);
    }
    return director;
  }

  get currentState(): GameState {
    return this.state;
  }

  get events(): readonly SimEvent[] {
    return this.history;
  }

  async run(maxTurns = Number.POSITIVE_INFINITY): Promise<RunResult> {
    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if ((await this.step()) === 'ended') return { status: 'ended', state: this.state };
      }
      return { status: 'turn_limit', state: this.state };
    } catch (error) {
      if (!(error instanceof SessionPausedError)) throw error;
      const recorder = this.newRecorder();
      recorder.emit({
        type: 'ooc_note',
        visibility: 'dm',
        text: `Session paused. ${error.message}`,
      });
      await this.commit(recorder);
      return { status: 'paused', state: this.state, seat: error.seat, error: error.reason };
    }
  }

  /** Runs exactly one turn and commits it. */
  async step(): Promise<'continue' | 'ended'> {
    if (this.state.session === null) {
      await this.startSession();
      return 'continue';
    }
    const next = nextActor(this.state);
    if (next.kind === 'ended') return 'ended';

    if (next.kind === 'pc') {
      if (!this.state.combat && this.state.silentTurns >= this.silentTurnLimit) {
        await this.dmBeat(
          'beat',
          undefined,
          'The table has gone quiet. Move the story forward with narration.'
        );
      } else {
        await this.playerTurn(next.pcId, next.reason);
      }
    } else {
      await this.dmBeat(next.reason, next.combatantId);
    }

    if (!this.state.ended && clockPhase(this.state, this.config.targetMinutes) === 'hard_stop') {
      const recorder = this.newRecorder();
      recorder.emit({ type: 'session_end', reason: 'hard_stop' });
      await this.commit(recorder);
    }
    return this.state.ended ? 'ended' : 'continue';
  }

  private async startSession(): Promise<void> {
    const recorder = this.newRecorder();
    recorder.emit({
      type: 'session_start',
      session: this.config.session,
      loreCommit: this.config.loreCommit,
      targetMinutes: this.config.targetMinutes,
      party: this.config.party,
    });
    await this.commit(recorder);
  }

  private async dmBeat(
    reason: 'beat' | 'resolve' | 'monster',
    combatantId: string | undefined,
    nudge?: string
  ): Promise<void> {
    const recorder = this.newRecorder();
    const seat = this.config.seats.dm;
    const combatAtStart = this.state.combat !== null;
    if (nudge) recorder.emit({ type: 'ooc_note', visibility: 'dm', text: `Watchdog: ${nudge}` });

    const messages = this.deps.prompts.dm({
      state: this.state,
      transcript: this.transcript('dm'),
      instruction: this.dmInstruction(reason, combatantId, nudge),
    });
    const context = this.toolContext(recorder, 'dm');
    const pcNames = this.state.partyIds.map((id) => this.state.combatants[id]?.name ?? id);
    let mechanicsCalled = false;
    let rejections = 0;
    let ended = false;

    for (let step = 0; step < this.maxDmStepsPerBeat && !ended; step++) {
      const response = await this.callModel(seat, messages, DM_TOOL_SCHEMAS);
      const calls = callsFromResponse(response, 'narrate', `auto-narrate-${step}`);
      messages.push({
        role: 'assistant',
        content: response.toolCalls.length > 0 ? response.text : '',
        toolCalls: calls,
      });
      if (calls.length === 0) {
        messages.push({
          role: 'user',
          content: 'Use your tools. Call hand_off when the players should respond.',
        });
        continue;
      }

      let skipRest = false;
      for (const call of calls) {
        if (ended || skipRest) {
          const why = ended
            ? 'your turn already ended with hand_off'
            : 'an earlier call was rejected';
          messages.push(toolMessage(call, `Not executed: ${why}.`));
          continue;
        }
        const prepared = prepareToolCall(call, DM_TOOLS);
        if (!prepared.ok) {
          messages.push(toolMessage(call, prepared.error));
          skipRest = true;
          continue;
        }
        const text = prepared.def.narrativeText?.(prepared.args);
        const violation = text
          ? validateDmText(text, { pcNames, mechanicsToolCalled: mechanicsCalled })
          : null;
        if (violation) {
          if (rejections < this.maxValidatorRetries) {
            rejections++;
            messages.push(
              toolMessage(
                call,
                `Rejected (${violation.rule}): ${violation.message} Call the tool again with corrected text.`
              )
            );
            skipRest = true;
            continue;
          }
          recorder.emit({
            type: 'validator_flag',
            visibility: 'dm',
            seat,
            rule: violation.rule,
            retries: rejections,
            resolution: 'accepted_with_flag',
          });
        }
        const execution = await runPreparedCall(prepared.def, prepared.args, context);
        if (!execution.ok) {
          messages.push(toolMessage(call, `Error: ${execution.error}`));
          skipRest = true;
          continue;
        }
        if (MECHANICS_TOOL_NAMES.has(call.name)) mechanicsCalled = true;
        if (execution.outcome.endsBeat) ended = true;
        messages.push(toolMessage(call, execution.outcome.result));
      }
    }

    if (!ended) {
      recorder.emit({
        type: 'validator_flag',
        visibility: 'dm',
        seat,
        rule: 'dm_step_limit',
        retries: rejections,
        resolution: 'forced_hand_off',
      });
      const forced = prepareToolCall(
        { id: 'forced-hand-off', name: 'hand_off', args: { target: { kind: 'party' } } },
        DM_TOOLS
      );
      if (forced.ok) await runPreparedCall(forced.def, forced.args, context);
    }

    if (combatAtStart && recorder.state.combat) {
      const advance = advanceCombat(recorder.state);
      if (advance) recorder.emit({ type: 'combat_turn', ...advance });
      else recorder.emit({ type: 'combat_end' });
    }
    recorder.emit({ type: 'turn_end', actor: 'dm' });

    const phase = clockPhase(recorder.state, this.config.targetMinutes);
    const sceneBreak = recorder.events.some((event) => event.type === 'scene_change');
    if (sceneBreak && (phase === 'end_at_scene_break' || phase === 'hard_stop')) {
      recorder.emit({ type: 'session_end', reason: 'target_reached' });
    }
    await this.commit(recorder);
  }

  private async playerTurn(pcId: string, reason: 'response' | 'combat_turn'): Promise<void> {
    const recorder = this.newRecorder();
    const pc = this.state.combatants[pcId];
    const seat = this.config.seats.players[pcId];
    if (!pc || !seat) throw new Error(`No player seat configured for "${pcId}"`);

    const instruction =
      reason === 'combat_turn'
        ? 'It is your turn in combat. Declare your action with act or declare_spell, and optionally speak.'
        : 'The DM has turned to you. Respond in character: speak, act, or pass.';
    const messages = this.deps.prompts.player({
      pc,
      state: this.state,
      transcript: this.transcript('player'),
      instruction,
    });
    const otherPcNames = this.state.partyIds
      .filter((id) => id !== pcId)
      .map((id) => this.state.combatants[id]?.name ?? id);
    const context = this.toolContext(recorder, pcId);

    for (let attempt = 0; ; attempt++) {
      const response = await this.callModel(seat, messages, PLAYER_TOOL_SCHEMAS);
      const calls = callsFromResponse(response, 'speak', `auto-speak-${attempt}`);
      messages.push({
        role: 'assistant',
        content: response.toolCalls.length > 0 ? response.text : '',
        toolCalls: calls,
      });

      const accepted: { call: ToolCall; def: AnyToolDef; args: unknown }[] = [];
      const problems: { rule: string; message: string }[] = [];
      for (const call of calls) {
        const prepared = prepareToolCall(call, PLAYER_TOOLS);
        if (!prepared.ok) {
          problems.push({ rule: 'invalid_tool_call', message: prepared.error });
          continue;
        }
        const text = prepared.def.narrativeText?.(prepared.args);
        const violation = text ? validatePlayerText(text, { otherPcNames }) : null;
        if (violation) {
          problems.push(violation);
          continue;
        }
        accepted.push({ call, def: prepared.def, args: prepared.args });
      }
      if (
        problems.length === 0 &&
        !accepted.some((item) => TURN_ACTION_TOOL_NAMES.has(item.def.name))
      ) {
        problems.push({
          rule: 'no_turn_action',
          message: 'Your turn needs speak, act, declare_spell, or pass.',
        });
      }

      if (problems.length > 0 && attempt < this.maxValidatorRetries) {
        const summary = problems.map((problem) => `${problem.rule}: ${problem.message}`).join(' ');
        for (const call of calls) messages.push(toolMessage(call, `Not executed. ${summary}`));
        if (calls.length === 0)
          messages.push({ role: 'user', content: `Your response was rejected. ${summary}` });
        continue;
      }

      let tookTurn = false;
      for (const item of accepted) {
        const execution = await runPreparedCall(item.def, item.args, context);
        if (!execution.ok) {
          problems.push({ rule: 'tool_error', message: execution.error });
          continue;
        }
        if (TURN_ACTION_TOOL_NAMES.has(item.def.name)) tookTurn = true;
      }
      if (problems.length > 0) {
        recorder.emit({
          type: 'validator_flag',
          visibility: 'dm',
          seat,
          rule: problems.map((problem) => problem.rule).join(','),
          retries: attempt,
          resolution: tookTurn ? 'accepted_with_flag' : 'forced_pass',
        });
      }
      if (!tookTurn) recorder.emit({ type: 'pass', actor: pcId });
      break;
    }

    recorder.emit({ type: 'turn_end', actor: pcId });
    await this.commit(recorder);
  }

  private dmInstruction(
    reason: 'beat' | 'resolve' | 'monster',
    combatantId: string | undefined,
    nudge: string | undefined
  ): string {
    const name = combatantId ? (this.state.combatants[combatantId]?.name ?? combatantId) : '';
    const base =
      reason === 'resolve'
        ? `${name} has declared their combat action (see recent events). Resolve it with tools, narrate the result, then call hand_off.`
        : reason === 'monster'
          ? `It is ${name}'s turn (id: ${combatantId}). Act for it with tools, narrate, then call hand_off.`
          : 'Continue the story: narrate what happens next, resolve any declared actions with tools, then call hand_off.';
    const clock = clockInstruction(clockPhase(this.state, this.config.targetMinutes));
    return [nudge, base, clock].filter(Boolean).join(' ');
  }

  private async callModel(
    seat: string,
    messages: ChatMessage[],
    tools: ToolSchema[]
  ): Promise<ModelResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.deps.model.complete({ seat, messages, tools });
      } catch (error) {
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined) {
          throw new SessionPausedError(
            seat,
            error instanceof Error ? error.message : String(error)
          );
        }
        await this.sleep(delay);
      }
    }
  }

  private transcript(audience: Audience): string {
    return renderTranscript(this.history, this.state, audience, this.transcriptWindow);
  }

  private toolContext(recorder: TurnRecorder, actorId: string): ToolContext {
    return {
      recorder,
      history: this.history,
      rng: this.deps.rng,
      lore: this.deps.lore,
      loreThreshold: this.loreThreshold,
      actorId,
    };
  }

  private newRecorder(): TurnRecorder {
    return new TurnRecorder(this.state, this.newTurnId(), this.now);
  }

  private async commit(recorder: TurnRecorder): Promise<void> {
    if (recorder.events.length === 0) return;
    await this.deps.sink.append(recorder.events);
    this.history.push(...recorder.events);
    this.state = recorder.state;
    this.deps.onCommit?.(recorder.events, this.state);
  }
}
```

`packages/core/src/index.ts`

```ts
export * from './clock';
export * from './director';
export * from './events';
export * from './model';
export * from './prompts';
export * from './recorder';
export * from './sink';
export * from './state';
export * from './text';
export * from './transcript';
export * from './validators';
export { DM_TOOLS, PLAYER_TOOLS } from './tools/registry';
export { ToolError, toToolSchema, type ToolContext, type ToolDef } from './tools/types';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/director.test.ts`
Expected: PASS — 7 tests across 1 file(s).

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: `tsc` reports no errors and every test passes.

- [ ] **Step 6: Commit** (only once the user has approved commits)

```bash
git add packages/core/src/director.ts \
  packages/core/src/index.ts \
  packages/core/test/director.test.ts
git commit -m "feat(core): add director turn loop with validators, clock, and resume"
```

### Task 11: `sim run` CLI with a JSONL event log and scripted fixtures

Play a scripted fixture from the command line and write `campaigns/<id>/sessions/<NNN>/events.jsonl`, with safe resume behavior.

**Files:**

- Create: `apps/cli/package.json`
- Create: `apps/cli/src/jsonl-sink.ts`
- Create: `apps/cli/src/paths.ts`
- Create: `apps/cli/src/fixture.ts`
- Create: `apps/cli/src/run.ts`
- Create: `apps/cli/src/main.ts`
- Create: `apps/cli/fixtures/demo-session.json`
- Test: `apps/cli/test/jsonl-sink.test.ts`
- Test: `apps/cli/test/run.test.ts`

**Interfaces:**

- Consumes: `Director`, `SimEvent`, `EventSink`, `LoreHit`, `ModelResponse`, `basicPrompts`, `describeEvent`, `RunResult` from `@cartyx-sim/core`; `ScriptedModelClient`, `StaticLoreIndex` from `@cartyx-sim/core/testing`; `Combatant`, RNG factories from `@cartyx-sim/rules`.
- Produces:
  - `class JsonlFileSink(path)` implementing `EventSink` plus `exists()`; each turn is one append followed by `fsync`
  - `sessionDir(campaignsDir, campaign, session)`, `sessionEventsPath(...)` — campaign ids must be kebab-case
  - `Fixture` schema and `loadFixture(path)`
  - `runSession(options: RunOptions): Promise<RunResult & { eventsPath }>`
  - `npm run sim -- run --campaign <id> --fixture <path> [--session N] [--target-minutes N] [--seed N] [--campaigns-dir DIR] [--resume]`

- [ ] **Step 1: Create the package configuration**

`apps/cli/package.json`

```json
{
  "name": "@cartyx-sim/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@cartyx-sim/core": "*",
    "@cartyx-sim/rules": "*",
    "commander": "^15.0.0",
    "zod": "^4.6.4"
  }
}
```

- [ ] **Step 2: Install `commander` and link the CLI workspace**

Run: `npm install commander@15.0.0 -w @cartyx-sim/cli`
Expected: install completes with no errors.

- [ ] **Step 3: Write the failing tests**

`apps/cli/test/jsonl-sink.test.ts`

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimEvent } from '@cartyx-sim/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFileSink } from '../src/jsonl-sink';

const event = (seq: number): SimEvent =>
  SimEvent.parse({
    seq,
    ts: '2026-09-13T12:00:00.000Z',
    turnId: 'turn-1',
    visibility: 'public',
    type: 'ooc_note',
    text: `note ${seq}`,
  });

describe('JsonlFileSink', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cartyx-sim-sink-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns no events for a missing file', async () => {
    const sink = new JsonlFileSink(join(dir, 'missing', 'events.jsonl'));
    expect(await sink.exists()).toBe(false);
    expect(await sink.readAll()).toEqual([]);
  });

  it('creates directories and round-trips appended turns', async () => {
    const sink = new JsonlFileSink(join(dir, 'a', 'b', 'events.jsonl'));
    await sink.append([event(0), event(1)]);
    await sink.append([event(2)]);
    expect(await sink.exists()).toBe(true);
    expect(await sink.readAll()).toEqual([event(0), event(1), event(2)]);
  });

  it('reports the line number of a corrupt event', async () => {
    const path = join(dir, 'events.jsonl');
    await writeFile(path, `${JSON.stringify(event(0))}\n{"seq": "oops"}\n`);
    await expect(new JsonlFileSink(path).readAll()).rejects.toThrow(`${path}:2: invalid event`);
  });
});
```

`apps/cli/test/run.test.ts`

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFileSink } from '../src/jsonl-sink';
import { runSession, type RunOptions } from '../src/run';

const FIXTURE = fileURLToPath(new URL('../fixtures/demo-session.json', import.meta.url));

describe('runSession', () => {
  let dir: string;
  let options: RunOptions;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cartyx-sim-run-'));
    options = {
      campaignsDir: dir,
      campaign: 'demo',
      session: 1,
      fixturePath: FIXTURE,
      resume: false,
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('plays the fixture to the end and writes a valid event log', async () => {
    const lines: string[] = [];
    const result = await runSession({ ...options, log: (line) => lines.push(line) });

    expect(result.status).toBe('ended');
    expect(result.eventsPath).toBe(join(dir, 'demo', 'sessions', '001', 'events.jsonl'));
    const events = await new JsonlFileSink(result.eventsPath).readAll();
    expect(events.map((e) => e.type)).toEqual([
      'session_start',
      'scene_change',
      'narration',
      'hand_off',
      'turn_end',
      'dialogue',
      'turn_end',
      'narration',
      'scene_change',
      'hand_off',
      'turn_end',
      'session_end',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'session_end', reason: 'target_reached' });
    expect(lines).toEqual([
      '[scene] Avalon Artificers Academy — Crystal Engine Lab',
      'DM: The lab lights flicker as you arrive.',
      'Kira Vale: "Who turned off the wards?"',
      'DM: A shadow slips out the east door, leaving frost behind.',
      '[scene] Avalon Artificers Academy — East Corridor',
    ]);
  });

  it('refuses to overwrite an existing session without resume', async () => {
    await runSession(options);
    await expect(runSession(options)).rejects.toThrow('already exists. Pass --resume');
  });

  it('refuses to resume a session that already ended', async () => {
    await runSession(options);
    await expect(runSession({ ...options, resume: true })).rejects.toThrow(
      'Session 1 has already ended'
    );
  });

  it('rejects unsafe campaign ids', async () => {
    await expect(runSession({ ...options, campaign: '../escape' })).rejects.toThrow(
      'must be lowercase letters, digits, and dashes'
    );
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/test/jsonl-sink.test.ts apps/cli/test/run.test.ts`
Expected: FAIL — Vitest cannot resolve `../src/jsonl-sink` because the implementation does not exist yet.

- [ ] **Step 5: Write the implementation**

`apps/cli/src/jsonl-sink.ts`

```ts
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SimEvent, type EventSink } from '@cartyx-sim/core';

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Append-only JSON Lines event log. Each turn is written with one append and an fsync. */
export class JsonlFileSink implements EventSink {
  constructor(readonly path: string) {}

  async exists(): Promise<boolean> {
    try {
      await stat(this.path);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async readAll(): Promise<SimEvent[]> {
    let content: string;
    try {
      content = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    return content
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.trim() !== '')
      .map(({ line, number }) => {
        try {
          return SimEvent.parse(JSON.parse(line));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`${this.path}:${number}: invalid event (${reason})`);
        }
      });
  }

  async append(events: readonly SimEvent[]): Promise<void> {
    if (events.length === 0) return;
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, 'a');
    try {
      await handle.appendFile(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
```

`apps/cli/src/paths.ts`

```ts
import { join } from 'node:path';

const CAMPAIGN_ID = /^[a-z0-9][a-z0-9-]*$/;

export function sessionDir(campaignsDir: string, campaign: string, session: number): string {
  if (!CAMPAIGN_ID.test(campaign)) {
    throw new Error(`Campaign id "${campaign}" must be lowercase letters, digits, and dashes`);
  }
  if (!Number.isInteger(session) || session < 1) {
    throw new Error(`Session number must be a positive integer, got ${session}`);
  }
  return join(campaignsDir, campaign, 'sessions', String(session).padStart(3, '0'));
}

export function sessionEventsPath(campaignsDir: string, campaign: string, session: number): string {
  return join(sessionDir(campaignsDir, campaign, session), 'events.jsonl');
}
```

`apps/cli/src/fixture.ts`

```ts
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
```

`apps/cli/src/run.ts`

```ts
import { basicPrompts, describeEvent, Director, type RunResult } from '@cartyx-sim/core';
import { ScriptedModelClient, StaticLoreIndex } from '@cartyx-sim/core/testing';
import { scriptedRng, secureRng, seededRng, type Rng } from '@cartyx-sim/rules';
import { loadFixture, type Fixture } from './fixture';
import { JsonlFileSink } from './jsonl-sink';
import { sessionEventsPath } from './paths';

export interface RunOptions {
  campaignsDir: string;
  campaign: string;
  session: number;
  fixturePath: string;
  targetMinutes?: number;
  seed?: number;
  resume: boolean;
  log?: (line: string) => void;
}

export type RunSessionResult = RunResult & { eventsPath: string };

function pickRng(fixture: Fixture, seed: number | undefined): Rng {
  if (fixture.dice) return scriptedRng(fixture.dice);
  return seed === undefined ? secureRng() : seededRng(seed);
}

export async function runSession(options: RunOptions): Promise<RunSessionResult> {
  const fixture = await loadFixture(options.fixturePath);
  const eventsPath = sessionEventsPath(options.campaignsDir, options.campaign, options.session);
  const sink = new JsonlFileSink(eventsPath);
  if (!options.resume && (await sink.exists())) {
    throw new Error(`${eventsPath} already exists. Pass --resume to continue that session.`);
  }
  const log = options.log ?? (() => {});

  const director = await Director.create(
    {
      session: options.session,
      targetMinutes: options.targetMinutes ?? fixture.targetMinutes,
      loreCommit: fixture.loreCommit,
      party: fixture.party,
      seats: fixture.seats,
    },
    {
      model: new ScriptedModelClient(fixture.script),
      lore: new StaticLoreIndex(fixture.lore),
      rng: pickRng(fixture, options.seed),
      sink,
      prompts: basicPrompts,
      onCommit: (events, state) => {
        for (const event of events) {
          if (event.visibility !== 'public') continue;
          const line = describeEvent(event, state);
          if (line) log(line);
        }
      },
    }
  );
  const result = await director.run();
  return { ...result, eventsPath };
}
```

`apps/cli/src/main.ts`

```ts
import { Command, InvalidArgumentError } from 'commander';
import { runSession } from './run';

function parseNumber(kind: 'integer' | 'positive'): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (kind === 'integer' ? !Number.isInteger(parsed) : !(parsed > 0)) {
      throw new InvalidArgumentError(`Expected a ${kind} number, got "${value}".`);
    }
    return parsed;
  };
}

interface RunCommandOptions {
  campaign: string;
  fixture: string;
  session: number;
  targetMinutes?: number;
  seed?: number;
  campaignsDir: string;
  resume: boolean;
}

const program = new Command().name('sim').description('Cartyx AI D&D session simulator');

program
  .command('run')
  .description('Simulate a session and write its event log')
  .requiredOption('--campaign <id>', 'campaign id (a folder under the campaigns directory)')
  .requiredOption('--fixture <path>', 'scripted fixture to play; real models arrive in Plan 2')
  .option('--session <n>', 'session number', parseNumber('integer'), 1)
  .option(
    '--target-minutes <n>',
    'target spoken minutes (overrides the fixture)',
    parseNumber('positive')
  )
  .option('--seed <n>', 'seed for reproducible dice', parseNumber('integer'))
  .option('--campaigns-dir <path>', 'campaigns directory', 'campaigns')
  .option('--resume', 'continue an existing session log', false)
  .action(async (options: RunCommandOptions) => {
    const result = await runSession({
      campaignsDir: options.campaignsDir,
      campaign: options.campaign,
      session: options.session,
      fixturePath: options.fixture,
      targetMinutes: options.targetMinutes,
      seed: options.seed,
      resume: options.resume,
      log: (line) => console.log(line),
    });
    console.log(`\nSession ${result.status}. Event log: ${result.eventsPath}`);
    if (result.status === 'paused') {
      console.error(
        `Paused on seat ${result.seat}: ${result.error}. Fix it and rerun with --resume.`
      );
      process.exitCode = 2;
    }
  });

await program.parseAsync(process.argv);
```

`apps/cli/fixtures/demo-session.json`

```json
{
  "loreCommit": "fixture",
  "targetMinutes": 0.12,
  "party": [
    {
      "id": "kira",
      "name": "Kira Vale",
      "kind": "pc",
      "level": 3,
      "abilities": { "str": 10, "dex": 14, "con": 12, "int": 16, "wis": 12, "cha": 10 },
      "proficiencyBonus": 2,
      "skillProficiencies": ["investigation", "arcana"],
      "ac": 15,
      "maxHp": 24,
      "hp": 24,
      "spellSlots": [{ "level": 1, "max": 3, "used": 0 }],
      "attacks": [
        { "name": "Light Hammer", "bonus": 5, "damage": "1d4+3", "damageType": "bludgeoning" }
      ]
    }
  ],
  "seats": { "dm": "dm", "players": { "kira": "player-kira" } },
  "lore": [
    {
      "chunkId": "avalon#sella-vaunt",
      "source": "kanka-export/markdown/characters/2418574-2418574.md",
      "title": "Professor Sella Vaunt",
      "text": "Professor Sella Vaunt teaches applied crystal engines at Avalon Artificers Academy.",
      "score": 0
    }
  ],
  "script": {
    "dm": [
      {
        "toolCalls": [
          {
            "id": "dm-1",
            "name": "scene_change",
            "args": {
              "location": "Avalon Artificers Academy — Crystal Engine Lab",
              "artPrompt": "A brass-and-crystal workshop lit by humming engines"
            }
          },
          {
            "id": "dm-2",
            "name": "narrate",
            "args": { "text": "The lab lights flicker as you arrive." }
          },
          { "id": "dm-3", "name": "hand_off", "args": { "target": { "kind": "open" } } }
        ]
      },
      {
        "toolCalls": [
          {
            "id": "dm-4",
            "name": "narrate",
            "args": {
              "text": "A shadow slips out the east door, leaving frost behind.",
              "emotion": "whisper"
            }
          },
          {
            "id": "dm-5",
            "name": "scene_change",
            "args": {
              "location": "Avalon Artificers Academy — East Corridor",
              "artPrompt": "A frosted corridor at night"
            }
          },
          { "id": "dm-6", "name": "hand_off", "args": { "target": { "kind": "party" } } }
        ]
      }
    ],
    "player-kira": [
      {
        "toolCalls": [
          {
            "id": "kira-1",
            "name": "speak",
            "args": { "text": "Who turned off the wards?", "emotion": "afraid" }
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/test/jsonl-sink.test.ts apps/cli/test/run.test.ts`
Expected: PASS — 7 tests across 2 file(s).

- [ ] **Step 7: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: `tsc` reports no errors and every test passes.

- [ ] **Step 8: Run the demo fixture end to end from the CLI**

Run: `npm run sim -- run --campaign demo --fixture apps/cli/fixtures/demo-session.json --campaigns-dir /tmp/cartyx-sim-demo && rm -rf /tmp/cartyx-sim-demo`
Expected output:

```
[scene] Avalon Artificers Academy — Crystal Engine Lab
DM: The lab lights flicker as you arrive.
Kira Vale: "Who turned off the wards?"
DM: A shadow slips out the east door, leaving frost behind.
[scene] Avalon Artificers Academy — East Corridor

Session ended. Event log: /tmp/cartyx-sim-demo/demo/sessions/001/events.jsonl
```

- [ ] **Step 9: Commit** (only once the user has approved commits)

```bash
git add apps/cli/package.json \
  apps/cli/src/jsonl-sink.ts \
  apps/cli/src/paths.ts \
  apps/cli/src/fixture.ts \
  apps/cli/src/run.ts \
  apps/cli/src/main.ts \
  apps/cli/fixtures/demo-session.json \
  apps/cli/test/jsonl-sink.test.ts \
  apps/cli/test/run.test.ts \
  package.json \
  package-lock.json
git commit -m "feat(cli): add sim run with JSONL event log and scripted fixtures"
```

---

## Completion Check

- [ ] `npm run typecheck` reports no errors.
- [ ] `npm test` passes all 178 tests across 20 files.
- [ ] `npm run sim -- run --campaign demo --fixture apps/cli/fixtures/demo-session.json --campaigns-dir /tmp/cartyx-sim-demo` ends with `Session ended.` and writes a 12-event `events.jsonl`.

## What Plan 2 Builds On

- Implement `ModelClient` over OpenAI-compatible endpoints (Vercel AI SDK) and pass it to `Director.create` in place of `ScriptedModelClient`.
- Implement `LoreIndex` over LanceDB and the `cartyx-lore` repository in place of `StaticLoreIndex`.
- Replace `basicPrompts` with a `PromptBuilder` that adds personas, class primers, recaps, and journals.
- Add SRD data to `rules` for spell and monster validation, and add `award_milestone`.
