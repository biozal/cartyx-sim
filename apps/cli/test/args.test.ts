import { InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';
import { parseNumber } from '../src/args';

describe('parseNumber("integer")', () => {
  const parse = parseNumber('integer');

  it('accepts a plain integer', () => {
    expect(parse('3')).toBe(3);
  });

  it.each(['1e21', '1.5'])('rejects "%s" as not a safe integer', (value) => {
    expect(() => parse(value)).toThrow(InvalidArgumentError);
  });
});

describe('parseNumber("positive")', () => {
  const parse = parseNumber('positive');

  it.each(['3', '0.5'])('accepts "%s"', (value) => {
    expect(parse(value)).toBe(Number(value));
  });

  it.each(['Infinity', '0', '-2'])('rejects "%s" as not a positive finite number', (value) => {
    expect(() => parse(value)).toThrow(InvalidArgumentError);
  });
});
