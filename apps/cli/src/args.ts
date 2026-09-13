import { InvalidArgumentError } from 'commander';

/** A commander argument parser: "integer" requires a safe integer, "positive" a finite number > 0. */
export function parseNumber(kind: 'integer' | 'positive'): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    const valid =
      kind === 'integer' ? Number.isSafeInteger(parsed) : Number.isFinite(parsed) && parsed > 0;
    if (!valid) {
      throw new InvalidArgumentError(`Expected a ${kind} number, got "${value}".`);
    }
    return parsed;
  };
}
