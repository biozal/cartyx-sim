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
