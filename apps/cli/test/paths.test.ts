import { describe, expect, it } from 'vitest';
import { sessionDir } from '../src/paths';

describe('sessionDir', () => {
  it('rejects an unsafe integer session number', () => {
    expect(() => sessionDir('campaigns', 'demo', 1e21)).toThrow(
      'Session number must be a positive integer'
    );
  });

  it('rejects a fractional session number', () => {
    expect(() => sessionDir('campaigns', 'demo', 1.5)).toThrow(
      'Session number must be a positive integer'
    );
  });
});
