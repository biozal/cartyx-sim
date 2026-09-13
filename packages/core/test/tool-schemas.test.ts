import { describe, expect, it } from 'vitest';
import { DM_TOOLS, PLAYER_TOOLS } from '../src/tools/registry';
import { toToolSchema } from '../src/tools/types';

const FORBIDDEN_KEYS = ['$schema', '$defs', '$ref'];

/** Recursively asserts none of `FORBIDDEN_KEYS` appears anywhere in a JSON Schema value. */
function assertNoForbiddenKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new Error(`Found forbidden key "${key}" at ${path}.${key}`);
    }
    assertNoForbiddenKeys(nested, `${path}.${key}`);
  }
}

describe('toToolSchema', () => {
  it('produces a schema for every DM and player tool with no $schema, $defs, or $ref at any depth', () => {
    for (const tool of [...DM_TOOLS, ...PLAYER_TOOLS]) {
      const schema = toToolSchema(tool);
      assertNoForbiddenKeys(schema.parameters, tool.name);
    }
  });
});
