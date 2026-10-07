# Prep, Personas, and Ambient Lore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the game master a world to run in — a standing campaign premise, player-character personas, lore the engine retrieves on its own, and a per-session outline seeded in a real place — so that `sim audit`'s coverage section stops reading "No lore was used."

**Architecture:** Three injections plus one command, threaded through seams that already exist. The premise and personas ride `campaign.json` → `Campaign` → `DirectorConfig` → the prompt builders. Ambient lore is retrieved by the **director** (which already owns the turn loop and the `lore` seat's retries) and passed to the prompt builder as a new `PromptInput` field, emitting a normal `lore_lookup` event so `sim audit` needs no changes. `sim prep` is a CLI command beside `script` and `audit`. `packages/core` gains no I/O and no new dependency.

**Tech Stack:** TypeScript (ESM, `strict`, `noUncheckedIndexedAccess`), vitest, zod 4. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-prep-and-personas-design.md`

## Global Constraints

- **Branch:** create `feat/prep-and-personas` from `main`. One commit per task. **Do not push** — the user pushes.
- **Every task ends green:** `npm test`, `npm run typecheck`, `npm run format:check` all pass. The repo is at **1333 passing, 1 expected fail, 6 skipped**. The expected failure (`packages/script/test/speech.test.ts`) and the 6 skips (gated lore tests needing `CARTYX_LORE_PATH`) are correct — do not chase them.
- **Prettier is not optional.** `npx prettier --write` on every file you touch.
- **`packages/core` must not depend on `packages/lore`.** Core stays free of filesystem, network and native addons. It already declares the `LoreIndex` interface; ambient retrieval goes through that, not through the lore package.
- **`EVENT_SCHEMA_VERSION` stays 1.** Every event field added here is **optional**, so sessions 001–014 (real logs in this repo) still parse and still audit.
- **No test may make a network call.** Use stub `ModelClient`s, stub `LoreIndex`s, and `FakeEmbedder`.
- **A narration event requires `speaker` and `emotion`**, not just `text`. A fixture omitting them will not parse.
- **Never read a config-supplied key with plain bracket access** — use `ownEntry` from `@cartyx-sim/core` (see `apps/cli/src/campaign.ts`).
- Tests live at `packages/<pkg>/test/*.test.ts` and `apps/cli/test/*.test.ts`, importing by relative path.

## Verified interfaces you will build on

These were read from the code at `351d0da`; they are correct as written.

```ts
// packages/core/src/prompts.ts
export interface PromptInput { state: GameState; transcript: string; instruction: string }
export interface PlayerPromptInput { view: PlayerView; transcript: string; instruction: string }
export interface PromptBuilder {
  dm(input: PromptInput): ChatMessage[];
  player(input: PlayerPromptInput): ChatMessage[];
  pcControlCheck(input: PcControlCheckInput): ChatMessage[];
}

// packages/core/src/events.ts — the session_start variant
{ type: 'session_start', schemaVersion, session, loreCommit, targetMinutes, party }

// packages/core/src/director.ts
this.transcriptWindow = config.transcriptWindow ?? 30;   // line ~379
private async startSession()                              // line ~559, emits session_start
const messages = this.deps.prompts.dm({ ... });           // line ~582
const sceneBreak = recorder.events.some((e) => e.type === 'scene_change');  // line ~966
const messages = this.deps.prompts.player({ ... });       // line ~984
```

---

### Task 1: The `Persona` and `Premise` types, and their rendering

**Files:**

- Create: `packages/core/src/persona.ts`
- Create test: `packages/core/test/persona.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './persona';`)

**Interfaces:**

- Consumes: nothing.
- Produces:

  ```ts
  export const Premise: z.ZodObject<...>;
  export type Premise = { world?: string; region?: string; party?: string; tone?: string };
  export const Persona: z.ZodObject<...>;
  export type Persona = {
    backstory?: string; motivation?: string; personality?: string; ties?: string;
    loreEntityIds?: string[];
  };
  export function renderPremise(premise: Premise | undefined): string;      // '' when absent
  export function renderPersona(persona: Persona | undefined): string;      // full block, '' when absent
  export function renderPersonaLine(name: string, persona: Persona | undefined): string;
  ```

- [ ] **Step 1: Write the failing test**

`packages/core/test/persona.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/test/persona.test.ts`
Expected: FAIL — `Failed to resolve import "../src/persona"`.

- [ ] **Step 3: Implement**

`packages/core/src/persona.ts`:

```ts
import { z } from 'zod';

/**
 * What world a campaign is set in. Every field is optional and a campaign may have no premise at
 * all, so a campaign written before this existed behaves exactly as it did. v1 design §6.1 listed
 * a bare `tone` field that was never built; this is that field, widened — a single adjective
 * cannot anchor a world.
 */
export const Premise = z.object({
  world: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  party: z.string().min(1).optional(),
  tone: z.string().min(1).optional(),
});
export type Premise = z.infer<typeof Premise>;

/**
 * Who a player character is, as opposed to what they can do. Deliberately kept out of `Combatant`,
 * which is purely mechanical and shared with monsters and NPCs.
 */
export const Persona = z.object({
  backstory: z.string().min(1).optional(),
  motivation: z.string().min(1).optional(),
  personality: z.string().min(1).optional(),
  ties: z.string().min(1).optional(),
  /** Wiki entity ids that seed ambient retrieval at session start. */
  loreEntityIds: z.array(z.string().min(1)).optional(),
});
export type Persona = z.infer<typeof Persona>;

function labelled(pairs: [string, string | undefined][]): string {
  return pairs
    .filter((pair): pair is [string, string] => pair[1] !== undefined && pair[1] !== '')
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

export function renderPremise(premise: Premise | undefined): string {
  if (!premise) return '';
  return labelled([
    ['World', premise.world],
    ['Region', premise.region],
    ['Party', premise.party],
    ['Tone', premise.tone],
  ]);
}

/**
 * A player's own persona, in full. The lore ids are not printed: they exist to seed retrieval, and
 * a model reading "kanka-2418574" learns nothing from it.
 */
export function renderPersona(persona: Persona | undefined): string {
  if (!persona) return '';
  return labelled([
    ['Backstory', persona.backstory],
    ['Motivation', persona.motivation],
    ['Personality', persona.personality],
    ['Ties', persona.ties],
  ]);
}

/** One line for the DM's party list: a DM that does not know a PC's motive cannot hook it. */
export function renderPersonaLine(name: string, persona: Persona | undefined): string {
  const parts = [persona?.motivation, persona?.ties].filter(
    (part): part is string => part !== undefined && part !== ''
  );
  return parts.length === 0 ? `- ${name}` : `- ${name} — ${parts.join(' ')}`;
}
```

Add to `packages/core/src/index.ts`, keeping the file's alphabetical ordering:

```ts
export * from './persona';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/test/persona.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Verify the repo is green and commit**

```bash
npm run typecheck && npm test && npm run format:check
npx prettier --write packages/core
git add packages/core
git commit -m "feat(core): add Premise and Persona types with their rendering"
```

---

### Task 2: The premise in the DM system prompt

**Files:**

- Modify: `packages/core/src/prompts.ts` (`PromptInput`, `DM_SYSTEM`, `basicPrompts.dm`)
- Modify test: `packages/core/test/prompts.test.ts` (create if absent)

**Interfaces:**

- Consumes: `Premise`, `renderPremise` (Task 1).
- Produces: `PromptInput` gains `premise?: Premise`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/prompts.test.ts` (read the file first and follow its existing helpers; if it does not exist, create it with this content):

```ts
import { describe, expect, it } from 'vitest';
import { basicPrompts } from '../src/prompts';
import { startedState } from './helpers';

describe('dm prompt premise', () => {
  it('puts the world before the mechanical rules, because a model needs to know where it is first', () => {
    const { state } = startedState();
    const [system] = basicPrompts.dm({
      state,
      transcript: '',
      instruction: 'Open the scene.',
      premise: { world: 'Cartyx, a fantasy Earth.', region: 'Atlanta metro.' },
    });
    const content = system!.content;
    expect(content).toContain('World: Cartyx, a fantasy Earth.');
    expect(content).toContain('Region: Atlanta metro.');
    // The premise must precede the dice rules, not trail them.
    expect(content.indexOf('World: Cartyx')).toBeLessThan(content.indexOf('All dice'));
  });

  it('is unchanged when a campaign has no premise', () => {
    const { state } = startedState();
    const without = basicPrompts.dm({ state, transcript: '', instruction: 'Go.' })[0]!.content;
    expect(without).not.toContain('World:');
    expect(without).toContain('You are the Dungeon Master');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/test/prompts.test.ts`
Expected: FAIL — `premise` is not a known property of `PromptInput`, or the assertion on ordering fails.

- [ ] **Step 3: Implement**

In `packages/core/src/prompts.ts`:

```ts
import { renderPremise, type Premise } from './persona';

export interface PromptInput {
  state: GameState;
  transcript: string;
  instruction: string;
  /** The campaign's standing premise, if it has one. */
  premise?: Premise;
}
```

Then in `basicPrompts.dm`, build the system message from the premise plus the existing constant:

```ts
  dm({ state, transcript, instruction, premise }) {
    // ...existing party/others/npcs code unchanged...
    const world = renderPremise(premise);
    return [
      // The premise leads: the model has to know what world it is in before it is told how dice
      // work. Session 014 ran with no premise at all and invented a setting from nothing.
      { role: 'system', content: world === '' ? DM_SYSTEM : `${world}\n\n${DM_SYSTEM}` },
      // ...existing user message unchanged...
    ];
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core`
Expected: PASS. Every existing prompt test must still pass — `premise` is optional, so a call without it is unchanged.

- [ ] **Step 5: Verify the repo is green and commit**

```bash
npm run typecheck && npm test && npm run format:check
npx prettier --write packages/core
git add packages/core
git commit -m "feat(core): put the campaign premise at the top of the DM system prompt"
```

---

### Task 3: Personas in the DM and player prompts

**Files:**

- Modify: `packages/core/src/prompts.ts` (`PromptInput`, `PlayerPromptInput`, both builders)
- Modify test: `packages/core/test/prompts.test.ts`

**Interfaces:**

- Consumes: `Persona`, `renderPersona`, `renderPersonaLine` (Task 1).
- Produces: `PromptInput` gains `personas?: Record<string, Persona>` (keyed by PC id); `PlayerPromptInput` gains `persona?: Persona`.

**The isolation rule this task must hold:** a player sees **only their own** persona. The DM sees **one line per PC**, never the full blocks. This mirrors what `PlayerView` already does for monster stats, and a test pins it.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/prompts.test.ts`:

```ts
describe('personas in prompts', () => {
  const personas = {
    kira: {
      motivation: 'Clear the shop’s name.',
      ties: 'Owes Professor Vaunt.',
      backstory: 'Alpharetta born.',
    },
    tomas: { motivation: 'Find his brother.', backstory: 'A long secret.' },
  };

  it('gives the DM one line per PC, not the full blocks', () => {
    const { state } = startedState();
    const user = basicPrompts.dm({ state, transcript: '', instruction: 'Go.', personas })[1]!
      .content;
    expect(user).toContain('Clear the shop’s name.');
    expect(user).toContain('Owes Professor Vaunt.');
    // The DM gets motives and ties, never the backstory prose.
    expect(user).not.toContain('Alpharetta born.');
    expect(user).not.toContain('A long secret.');
  });

  it('gives a player their own persona in full', () => {
    const { state } = startedState();
    const [system] = basicPrompts.player({
      view: playerView(state, 'kira'),
      transcript: '',
      instruction: 'Say something.',
      persona: personas.kira,
    });
    expect(system!.content).toContain('Alpharetta born.');
    expect(system!.content).toContain('Clear the shop’s name.');
  });

  it('never shows one player another player’s persona', () => {
    const { state } = startedState();
    const messages = basicPrompts.player({
      view: playerView(state, 'kira'),
      transcript: '',
      instruction: 'Go.',
      persona: personas.kira,
    });
    const all = messages.map((message) => message.content).join('\n');
    expect(all).not.toContain('Find his brother.');
    expect(all).not.toContain('A long secret.');
  });

  it('is unchanged when no personas are given', () => {
    const { state } = startedState();
    const user = basicPrompts.dm({ state, transcript: '', instruction: 'Go.' })[1]!.content;
    expect(user).toContain('Party:');
  });
});
```

`playerView` and `startedState` are already imported by `prompts.test.ts` (lines 5 and 7). Use them — never a cast literal: `basicPrompts.player` calls `describeCombatant(view.pc)`, so `view.pc` must be a real `Combatant`. The helper party is `[kira, tomas]` with exactly those ids, which is why the persona map above is keyed `kira`/`tomas`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/test/prompts.test.ts`
Expected: FAIL — `personas`/`persona` are not known properties.

- [ ] **Step 3: Implement**

In `packages/core/src/prompts.ts`:

```ts
import {
  renderPersona,
  renderPersonaLine,
  renderPremise,
  type Persona,
  type Premise,
} from './persona';

export interface PromptInput {
  state: GameState;
  transcript: string;
  instruction: string;
  premise?: Premise;
  /** One persona per party member id. The DM sees a one-line summary of each, never the prose. */
  personas?: Record<string, Persona>;
}

export interface PlayerPromptInput {
  view: PlayerView;
  transcript: string;
  instruction: string;
  /** This player's own persona. A player never receives another player's. */
  persona?: Persona;
}
```

In `basicPrompts.dm`, replace the party line so each member carries its persona summary:

```ts
const party = state.partyIds
  .map((id) => state.combatants[id])
  .filter((combatant) => combatant !== undefined)
  .map((combatant) => {
    const line = describeCombatant(combatant);
    // `ownEntry`, not bracket access: ids come from config and must never reach a plain read.
    const persona = personas ? ownEntry(personas, combatant.id) : undefined;
    const motive = renderPersonaLine(combatant.name, persona);
    // renderPersonaLine returns "- <name>" when there is nothing to add; skip that case.
    return motive === `- ${combatant.name}` ? line : `${line}\n  ${motive.slice(2)}`;
  });
```

In `basicPrompts.player`, append the persona to the system message:

```ts
  player({ view, transcript, instruction, persona }) {
    // ...existing allies/others code unchanged...
    const who = renderPersona(persona);
    return [
      {
        role: 'system',
        content: [
          `You are playing ${view.pc.name} (id: ${view.pc.id}) in a Dungeons & Dragons 5e session.`,
          ...(who === '' ? [] : [who]),
          'Stay in character. Use speak for dialogue and act to declare what you attempt; use pass if your character does nothing.',
          // ...rest of the existing lines unchanged...
        ].join('\n'),
      },
      // ...existing user message unchanged...
    ];
  },
```

Import `ownEntry` from `./state` if `prompts.ts` does not already import it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core`
Expected: PASS, including every pre-existing prompt test.

- [ ] **Step 5: Verify the repo is green and commit**

```bash
npm run typecheck && npm test && npm run format:check
npx prettier --write packages/core
git add packages/core
git commit -m "feat(core): give each player their persona and the DM one line per PC"
```

---

### Task 4: The two optional event fields

**Files:**

- Modify: `packages/core/src/events.ts` (the `session_start` and `lore_lookup` variants)
- Modify test: `packages/core/test/contract.test.ts` — the existing `describe('event log contract')`, which already asserts `EVENT_SCHEMA_VERSION` is stamped on `session_start`. There is no `events.test.ts`; do not create one.

**Interfaces:**

- Consumes: `Persona` (Task 1).
- Produces: `session_start.personas?: Record<string, Persona>`; `lore_lookup.trigger?: 'scene' | 'party' | 'tool'`.

**Both are optional and `EVENT_SCHEMA_VERSION` stays 1.** Sessions 001–014 are real logs in this repo and must still parse.

- [ ] **Step 1: Write the failing test**

`contract.test.ts` already imports `EVENT_SCHEMA_VERSION`, `SimEvent` and `kira`. Append these describes to it:

```ts
const base = { seq: 1, ts: '2026-10-07T00:00:00.000Z', turnId: 't1' };
// The real party helper, not a literal: Combatant has required fields a literal would miss.
const party = [kira];

describe('session_start.personas', () => {
  it('is optional, so a log written before personas existed still parses', () => {
    const parsed = SimEvent.safeParse({
      ...base,
      visibility: 'public',
      type: 'session_start',
      session: 1,
      loreCommit: 'abc',
      targetMinutes: 60,
      party,
    });
    expect(parsed.success).toBe(true);
  });

  it('round-trips a persona map keyed by pc id', () => {
    const parsed = SimEvent.parse({
      ...base,
      visibility: 'public',
      type: 'session_start',
      session: 1,
      loreCommit: 'abc',
      targetMinutes: 60,
      party,
      personas: { kira: { motivation: 'Clear her name.', loreEntityIds: ['kanka-1'] } },
    });
    expect(parsed).toMatchObject({ personas: { kira: { motivation: 'Clear her name.' } } });
  });
});

describe('lore_lookup.trigger', () => {
  it('is optional, so sessions 001-014 still parse', () => {
    const parsed = SimEvent.safeParse({
      ...base,
      visibility: 'dm',
      type: 'lore_lookup',
      query: 'q',
      hits: [{ chunkId: 'c1', source: 'dm/a.md', score: 0.8 }],
      used: ['c1'],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts the three triggers and rejects anything else', () => {
    for (const trigger of ['scene', 'party', 'tool']) {
      const parsed = SimEvent.safeParse({
        ...base,
        visibility: 'dm',
        type: 'lore_lookup',
        query: 'q',
        hits: [],
        used: [],
        trigger,
      });
      expect(parsed.success).toBe(true);
    }
    const bad = SimEvent.safeParse({
      ...base,
      visibility: 'dm',
      type: 'lore_lookup',
      query: 'q',
      hits: [],
      used: [],
      trigger: 'guess',
    });
    expect(bad.success).toBe(false);
  });
});

describe('the schema version', () => {
  it('stays 1: both additions are optional, so no log format broke', () => {
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/test/contract.test.ts`
Expected: FAIL — the persona round-trip is stripped and `trigger: 'guess'` is accepted, because neither field exists yet.

- [ ] **Step 3: Implement**

In `packages/core/src/events.ts`, import the persona schema and add both fields:

```ts
import { Persona } from './persona';
```

In the `session_start` variant, after `party`:

```ts
    /**
     * Who the party are, as opposed to what they can do. Copied in at session start so the log is
     * self-contained: an audit of session 14 must read the personas session 14 was played with,
     * not whatever the character files say months later. Optional, so older logs still parse.
     */
    personas: z.record(z.string(), Persona).optional(),
```

In the `lore_lookup` variant, after `used`:

```ts
    /**
     * What caused the lookup: a `scene_change`, the party's own lore ties at session start, or the
     * DM calling `lookup_lore`. Optional, so sessions 001-014 still parse. Ambient retrieval emits
     * the same event as a tool call so `sim audit` needs no changes and there is one definition of
     * "lore was used".
     */
    trigger: z.enum(['scene', 'party', 'tool']).optional(),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core`
Expected: PASS.

- [ ] **Step 5: Confirm the real logs still parse**

Run:

```bash
node -e "
const fs=require('fs');
let bad=0, n=0;
for (const d of fs.readdirSync('campaigns/avalon/sessions')) {
  const f='campaigns/avalon/sessions/'+d+'/events.jsonl';
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f,'utf8').trim().split('\n')) { n++; try { JSON.parse(line) } catch { bad++ } }
}
console.log('lines:', n, 'unparseable:', bad);
"
```

That checks the JSON is intact; the zod check is the unit test above. Then confirm the logs still **audit**, which is the spec's actual requirement:

```bash
npm run sim -- audit --campaign avalon --session 14
```

It must still produce a report. Record both results in your report.

- [ ] **Step 6: Verify the repo is green and commit**

```bash
npm run typecheck && npm test && npm run format:check
npx prettier --write packages/core
git add packages/core
git commit -m "feat(core): record personas on session_start and what triggered a lore lookup"
```

---

### Task 5: Ambient lore in the director

**Files:**

- Modify: `packages/core/src/tools/narrative.ts` (extract the ranking from `lookupLore`)
- Modify: `packages/core/src/director.ts` (`DirectorConfig`, `startSession`, `dmBeat`)
- Modify: `packages/core/src/prompts.ts` (`PromptInput.ambientLore`, `prepOutline`)
- Create test: `packages/core/test/ambient-lore.test.ts`

**Interfaces:**

- Consumes: `Premise`, `Persona` (Task 1); the prompt fields (Tasks 2–3); the `trigger` field (Task 4).
- Produces: `DirectorConfig` gains `premise?: Premise`, `personas?: Record<string, Persona>`, `prepOutline?: string`; `PromptInput` gains `ambientLore?: string`.

**What this task must get right:**

1. **Retrieval happens at session start** (from the party's personas) **and after a `scene_change`** commits.
2. **Each retrieval emits a `lore_lookup`** with `trigger: 'party'` or `'scene'`, so `sim audit` counts it with no changes.
3. **A retrieval failure degrades to no ambient lore, never fails the turn.** A lore outage must not end a session.
4. The retrieved text reaches the next DM prompt via `ambientLore`.

**Deviation from spec §5, recorded here because it changes what gets queried.** The spec says session-start retrieval queries "the union of the party's `persona.loreEntityIds`". Against a semantic index that retrieves nothing: `LoreIndex.search` embeds its query, and `"kanka-2418574"` has no meaning to embed — `StaticLoreIndex` scores it 0 for the same reason. So:

- The **query** is the party's persona prose (`backstory`, `motivation`, `ties`), which is semantically rich and actually retrieves.
- `loreEntityIds` **promote**: a hit whose `entityId` is in the set is kept even if its score is below the threshold, because an authored tie is stated intent and outranks a similarity cutoff.

Promotion only reaches entities the search already surfaced — there is no by-id accessor on `LoreIndex`, and adding one is out of scope. Record this in the task report so the spec can be amended.

- [ ] **Step 1: Write the failing test**

First, `deps()` in `director.test.ts` hard-codes `lore: new StaticLoreIndex([SELLA_CHUNK])`. Add a `lore?: LoreIndex` option to it so a test can inject a failing index:

```ts
    lore: options.lore ?? new StaticLoreIndex([SELLA_CHUNK]),
```

Then create `packages/core/test/ambient-lore.test.ts`. It mirrors `director.test.ts`'s own helpers — copy `config()` and `deps()` into it, or export them from `director.test.ts` and import; either is fine, but **do not invent a new harness**.

```ts
import { scriptedRng } from '@cartyx-sim/rules';
import { describe, expect, it } from 'vitest';
import { Director, type DirectorConfig, type DirectorDeps } from '../src/director';
import type { LoreIndex } from '../src/model';
import { basicPrompts } from '../src/prompts';
import { MemorySink } from '../src/sink';
import { respond, ScriptedModelClient, StaticLoreIndex, toolCall } from '../src/testing';
import { kira, now, tomas } from './helpers';
import { SELLA_CHUNK } from './tool-harness';

/** Prose that genuinely matches SELLA_CHUNK, so StaticLoreIndex scores it above the threshold. */
const KIRA_PERSONA = {
  backstory: 'Professor Sella Vaunt teaches Kira applied crystal engines at Avalon.',
  loreEntityIds: ['kanka-2418574'],
};

function setup(
  overrides: Partial<DirectorConfig> = {},
  lore?: LoreIndex
): { config: DirectorConfig; deps: DirectorDeps; sink: MemorySink; model: ScriptedModelClient } {
  const model = new ScriptedModelClient({
    dm: [
      respond(
        toolCall('scene_change', {
          location: 'Avalon Artificers Academy',
          artPrompt: 'A brass-and-crystal workshop',
        }),
        toolCall('hand_off', { target: { kind: 'pcs', ids: ['tomas'] } })
      ),
      respond(toolCall('hand_off', { target: { kind: 'pcs', ids: ['tomas'] } })),
    ],
    'player-tomas': [
      respond(toolCall('speak', { text: 'Then we start with engine three.', emotion: 'neutral' })),
      respond(toolCall('speak', { text: 'Still nothing here.', emotion: 'neutral' })),
    ],
  });
  const sink = new MemorySink();
  let turn = 0;
  return {
    config: {
      session: 1,
      targetMinutes: 60,
      loreCommit: 'abc123',
      party: [kira, tomas],
      seats: { dm: 'dm', players: { kira: 'player-kira', tomas: 'player-tomas' } },
      retryDelaysMs: [],
      ...overrides,
    },
    deps: {
      model,
      lore: lore ?? new StaticLoreIndex([SELLA_CHUNK]),
      rng: scriptedRng([]),
      sink,
      prompts: basicPrompts,
      now,
      newTurnId: () => `turn-${++turn}`,
      sleep: async () => {},
    },
    sink,
    model,
  };
}

describe('ambient lore', () => {
  it('retrieves from the party’s personas at session start, logged as trigger "party"', async () => {
    const { config, deps, sink } = setup({ personas: { kira: KIRA_PERSONA } });
    const director = await Director.create(config, deps);
    await director.step();
    const lookup = sink.events.find((event) => event.type === 'lore_lookup');
    expect(lookup).toMatchObject({ trigger: 'party', used: ['avalon#sella-vaunt'] });
    // It is a normal lore_lookup, so the audit counts it with no changes.
    expect(lookup).toMatchObject({ visibility: 'dm' });
  });

  it('does not retrieve at session start when no persona has prose to retrieve on', async () => {
    const { config, deps, sink } = setup();
    const director = await Director.create(config, deps);
    await director.step();
    const partyLookups = sink.events.filter(
      (event) => event.type === 'lore_lookup' && event.trigger === 'party'
    );
    expect(partyLookups).toEqual([]);
  });

  it('retrieves for the new location after scene_change, logged as trigger "scene"', async () => {
    const { config, deps, sink } = setup();
    const director = await Director.create(config, deps);
    await director.step();
    const lookup = sink.events.find(
      (event) => event.type === 'lore_lookup' && event.trigger === 'scene'
    );
    expect(lookup).toMatchObject({
      query: 'Avalon Artificers Academy',
      used: ['avalon#sella-vaunt'],
    });
  });

  it('puts the retrieved text in the next DM prompt', async () => {
    const { config, deps, model } = setup();
    const director = await Director.create(config, deps);
    await director.step(); // DM changes the scene; ambient lore is retrieved for it.
    await director.step(); // Tomas answers.
    await director.step(); // The DM's next beat must carry the lore.
    const dmRequests = model.requests.filter((request) => request.seat === 'dm');
    const latest = dmRequests
      .at(-1)!
      .messages.filter((m) => m.role === 'user')
      .at(-1)!.content;
    expect(latest).toContain('Lore for this scene:');
    expect(latest).toContain('teaches applied crystal engines');
  });

  it('degrades to no ambient lore when retrieval throws, instead of failing the turn', async () => {
    const failing: LoreIndex = {
      async search() {
        throw new Error('lore is down');
      },
    };
    const { config, deps, sink, model } = setup({ personas: { kira: KIRA_PERSONA } }, failing);
    const director = await Director.create(config, deps);
    await director.step();
    await director.step();
    // No lookup was recorded, and the session kept playing: a lore outage must not end a session.
    expect(sink.events.some((event) => event.type === 'lore_lookup')).toBe(false);
    expect(sink.events.some((event) => event.type === 'session_end')).toBe(false);
    const dmRequests = model.requests.filter((request) => request.seat === 'dm');
    const latest = dmRequests
      .at(-1)!
      .messages.filter((m) => m.role === 'user')
      .at(-1)!.content;
    expect(latest).not.toContain('Lore for this scene:');
  });
});
```

Run the file as you go: the step counts above are the shape the director's beat loop has in `director.test.ts`, but if a step boundary falls differently, adjust the number of `step()` calls — never the assertion — and note it in your report.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/test/ambient-lore.test.ts`
Expected: FAIL — no ambient retrieval exists, so no `lore_lookup` with a `trigger` is emitted.

- [ ] **Step 3: Implement**

Add to `DirectorConfig`:

```ts
  /** The campaign's standing premise, passed to the DM prompt. */
  premise?: Premise;
  /** Personas by party member id, recorded on session_start and passed to the prompts. */
  personas?: Record<string, Persona>;
  /** The session outline from `sim prep`, injected into the DM system prompt for the session. */
  prepOutline?: string;
```

**First, extract the ranking so there is one copy of it.** `lookupLore` already ranks, collapses by entity, filters by threshold and renders the DM-facing text; the ambient path needs exactly the same behaviour, and a second copy would drift. In `packages/core/src/tools/narrative.ts`, pull those lines out of `lookupLore` into an exported helper and have `lookupLore` call it:

```ts
/**
 * The one ranking used by both `lookup_lore` and the director's ambient retrieval: sort, collapse
 * duplicates of one entity (the Kanka stub and the dm writeup), keep what clears the threshold.
 * Shared rather than copied so "lore was used" means the same thing however the lookup started.
 */
export function rankLoreHits(
  hits: readonly LoreHit[],
  loreThreshold: number,
  /**
   * Entity ids an author tied a character to. A hit on one of these is kept whatever it scored:
   * a stated tie is intent, and intent outranks a similarity cutoff. Empty for `lookup_lore`,
   * which has no authored ties to honour.
   */
  promote: ReadonlySet<string> = new Set()
): { ranked: LoreHit[]; used: LoreHit[] } {
  const ranked = [...hits].sort((a, b) => b.score - a.score);
  const bestByEntity = new Map<string, LoreHit>();
  for (const hit of ranked) {
    if (!bestByEntity.has(hit.entityId)) bestByEntity.set(hit.entityId, hit);
  }
  const used = [...bestByEntity.values()]
    .filter((hit) => hit.score >= loreThreshold || promote.has(hit.entityId))
    .slice(0, LORE_RESULT_LIMIT);
  return { ranked, used };
}

/** The DM-facing rendering of lore hits, identical whoever asked for them. */
export function renderLoreHits(used: readonly LoreHit[]): string {
  return used
    .map((hit) => `[${hit.chunkId}] ${hit.title} (${hit.source})\n${hit.text}`)
    .join('\n\n');
}

/** Every candidate, logged so the audit can see what was suppressed. */
export function loreHitPayload(ranked: readonly LoreHit[]) {
  return ranked.map(({ chunkId, source, score, entityId, entityName, entityType }) => ({
    chunkId,
    source,
    score,
    entityId,
    entityName,
    entityType,
  }));
}
```

`lookupLore`'s body becomes those three calls plus its own emit and return. Its existing tests in `packages/core/test/tools-narrative.test.ts` must pass unchanged — that is the proof the extraction was behaviour-preserving.

Then add a private field and a helper to `Director`:

```ts
  /** Lore the engine fetched on the DM's behalf, carried into the next DM prompt. */
  private ambientLore = '';

  /**
   * Retrieves lore the DM did not ask for and records it as a lookup. Emits the same `lore_lookup`
   * a tool call does, with a `trigger`, so `sim audit` needs no changes. A failure degrades to no
   * ambient lore: a lore outage must not end a session.
   */
  private async retrieveAmbient(
    recorder: TurnRecorder,
    query: string,
    trigger: 'scene' | 'party',
    /** Authored ties: a hit on one of these is kept even below the threshold. */
    promote: ReadonlySet<string> = new Set()
  ): Promise<void> {
    let hits: LoreHit[];
    try {
      // The same over-fetch lookup_lore uses: duplicates of one entity collapse below, and the
      // remaining slots should still be filled with other entities.
      hits = await this.deps.lore.search(query, LORE_RESULT_LIMIT * 4);
    } catch {
      this.ambientLore = '';
      return;
    }
    const { ranked, used } = rankLoreHits(hits, this.loreThreshold, promote);
    recorder.emit({
      type: 'lore_lookup',
      visibility: 'dm',
      query,
      trigger,
      hits: loreHitPayload(ranked),
      used: used.map((hit) => hit.chunkId),
    });
    this.ambientLore = renderLoreHits(used);
  }
```

Import `LORE_RESULT_LIMIT`, `rankLoreHits`, `renderLoreHits` and `loreHitPayload` from `./tools/narrative`, and `LoreHit` from `./model`, if not already imported.

In `startSession`, after emitting `session_start`, seed from the party's ties:

```ts
recorder.emit({
  type: 'session_start',
  schemaVersion: EVENT_SCHEMA_VERSION,
  session: this.config.session,
  loreCommit: this.config.loreCommit,
  targetMinutes: this.config.targetMinutes,
  party: this.config.party,
  ...(this.config.personas ? { personas: this.config.personas } : {}),
});
const people = Object.values(this.config.personas ?? {});
// The query is the party's own prose, not their entity ids: an id has nothing to embed.
const query = people
  .flatMap((person) => [person.backstory, person.motivation, person.ties])
  .filter((part): part is string => part !== undefined && part !== '')
  .join(' ');
if (query !== '') {
  const promote = new Set(people.flatMap((person) => person.loreEntityIds ?? []));
  await this.retrieveAmbient(recorder, query, 'party', promote);
}
await this.commit(recorder);
```

In `dmBeat`, pass the new fields to the prompt builder:

```ts
const messages = this.deps.prompts.dm({
  state: this.state,
  transcript: this.transcript('dm'),
  instruction: this.dmInstruction(reason, combatantId, nudge),
  premise: this.config.premise,
  personas: this.config.personas,
  prepOutline: this.config.prepOutline,
  ambientLore: this.ambientLore,
});
```

And at the end of `dmBeat`, where `sceneBreak` is already computed (line ~966), retrieve for the new location before committing:

```ts
const sceneBreak = recorder.events.some((event) => event.type === 'scene_change');
if (sceneBreak && (phase === 'end_at_scene_break' || phase === 'hard_stop')) {
  this.closeCombatIfRunning(recorder);
  recorder.emit({ type: 'session_end', reason: 'target_reached' });
} else if (sceneBreak) {
  // Only when the session continues: fetching lore for a scene nobody will play is waste.
  const location = recorder.state.scene?.location;
  if (location) await this.retrieveAmbient(recorder, location, 'scene');
}
await this.commit(recorder);
```

In `basicPrompts.dm` (`packages/core/src/prompts.ts`), add `prepOutline?: string` and `ambientLore?: string` to `PromptInput` and render them. `prepOutline` joins the system message after the premise — **this supersedes Task 2's two-branch ternary**, which was correct for two parts and becomes a filtered join for three:

```ts
    const world = renderPremise(premise);
    const outline = prepOutline ?? '';
    return [
      {
        role: 'system',
        // Premise first (what world this is), then the rules, then this session's outline.
        content: [world, DM_SYSTEM, outline].filter((part) => part !== '').join('\n\n'),
      },
```

Task 2's assertion that the premise precedes `All dice` still holds, so its tests stay green.

`ambientLore` goes in the user message where the model will read it beside the scene:

and in the user content array, after the `Scene:` line:

```ts
          ambientLore ? `Lore for this scene:\n${ambientLore}` : '',
```

filtering empty strings out of that array before joining.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core`
Expected: PASS, including all existing director tests.

- [ ] **Step 5: Verify the repo is green and commit**

```bash
npm run typecheck && npm test && npm run format:check
npx prettier --write packages/core
git add packages/core
git commit -m "feat(core): retrieve lore for the scene and the party without being asked"
```

---

### Task 6: Load the premise and personas from campaign config

**Files:**

- Modify: `apps/cli/src/campaign.ts` (`CampaignFile`, `Campaign`, `loadCampaign`, `loadParty`)
- Modify test: `apps/cli/test/campaign.test.ts`

**Interfaces:**

- Consumes: `Premise`, `Persona` from `@cartyx-sim/core` (Task 1).
- Produces: `Campaign` gains `premise?: Premise` and `personas?: Record<string, Persona>`.

**The constraint that matters:** `persona` must be stripped from the character JSON before `Combatant.parse`, so the mechanical schema is untouched and `session_start.party` does not bloat.

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/test/campaign.test.ts`, using the file's existing `writeCampaign(campaign, characters)` / `config()` / `KIRA` helpers:

```ts
it('loads a premise and exposes it on the campaign', async () => {
  const file = config();
  (file as Record<string, unknown>).premise = { world: 'Cartyx', region: 'Atlanta metro' };
  await writeCampaign(file, { 'kira.json': KIRA });
  const campaign = await loadCampaign(campaignsDir, 'test');
  expect(campaign.premise).toEqual({ world: 'Cartyx', region: 'Atlanta metro' });
});

it('loads a persona and keeps it out of the mechanical combatant', async () => {
  await writeCampaign(config(), {
    'kira.json': {
      ...KIRA,
      persona: { motivation: 'Clear her name.', loreEntityIds: ['kanka-1'] },
    },
  });
  const campaign = await loadCampaign(campaignsDir, 'test');
  expect(campaign.personas?.kira).toEqual({
    motivation: 'Clear her name.',
    loreEntityIds: ['kanka-1'],
  });
  // The party stays purely mechanical: Combatant has no persona field.
  expect(campaign.party[0]).not.toHaveProperty('persona');
});

it('still loads a campaign with neither a premise nor personas', async () => {
  await writeCampaign(config(), { 'kira.json': KIRA });
  const campaign = await loadCampaign(campaignsDir, 'test');
  expect(campaign.premise).toBeUndefined();
  expect(campaign.personas).toBeUndefined();
});

it('rejects a malformed persona rather than dropping it silently', async () => {
  await writeCampaign(config(), { 'kira.json': { ...KIRA, persona: { motivation: 42 } } });
  await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow(/persona/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/cli/test/campaign.test.ts`
Expected: FAIL — `campaign.premise` and `campaign.personas` are undefined, and a bad persona is silently ignored.

- [ ] **Step 3: Implement**

In `apps/cli/src/campaign.ts`:

```ts
import { ownEntry, Persona, Premise } from '@cartyx-sim/core';
```

Add to `CampaignFile`, beside `lorePath`:

```ts
  /** What world this campaign is set in. Injected at the top of the DM system prompt. */
  premise: Premise.optional(),
```

Add to the `Campaign` interface:

```ts
  premise?: Premise;
  /** Personas by party member id, for the prompts and for `session_start`. */
  personas?: Record<string, Persona>;
```

`loadParty` currently parses each character file straight into `Combatant`. Change it to pull `persona` off first and return both:

```ts
async function loadParty(
  dir: string
): Promise<{ party: Combatant[]; personas: Record<string, Persona> }> {
  // ...existing file discovery unchanged...
  const party: Combatant[] = [];
  const personas: [string, Persona][] = [];
  for (const file of files) {
    const path = join(charactersDir, file);
    const raw = await readJson(path, `${path} is missing`);
    // Split persona off before Combatant.parse: Combatant is mechanical and shared with monsters,
    // and it is what lands in session_start.party.
    const { persona, ...mechanical } = raw as Record<string, unknown>;
    const parsed = Combatant.safeParse(mechanical);
    if (!parsed.success) {
      throw new Error(`${path}: invalid character\n${z.prettifyError(parsed.error)}`);
    }
    // ...existing kind/duplicate checks unchanged...
    if (persona !== undefined) {
      const person = Persona.safeParse(persona);
      if (!person.success) {
        throw new Error(`${path}: invalid persona\n${z.prettifyError(person.error)}`);
      }
      personas.push([parsed.data.id, person.data]);
    }
    party.push(parsed.data);
  }
  return { party, personas: Object.fromEntries(personas) };
}
```

Update `loadCampaign`'s call site and its return object:

```ts
  const { party, personas } = await loadParty(dir);
  // ...
    ...(file.premise ? { premise: file.premise } : {}),
    ...(Object.keys(personas).length > 0 ? { personas } : {}),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/cli`
Expected: PASS, including every pre-existing campaign test.

- [ ] **Step 5: Verify the repo is green and commit**

```bash
npm run typecheck && npm test && npm run format:check
npx prettier --write apps/cli
git add apps/cli
git commit -m "feat(cli): read a campaign premise and per-character personas"
```

---

### Task 7: `sim prep`

**Files:**

- Create: `apps/cli/src/prep.ts`
- Create test: `apps/cli/test/prep.test.ts`
- Modify: `apps/cli/src/main.ts` (register the command)

**Interfaces:**

- Consumes: `loadCampaign`, `Campaign.premise` (Task 6); `embedderFor`, `loreIndexDir` from `./index-lore`; `openIndex` from `@cartyx-sim/lore`; `writeFileAtomic` from `./atomic-write`.
- Produces:
  ```ts
  export interface PrepOptions {
    campaignsDir: string;
    campaign: string;
    session: number;
    location?: string;
    force?: boolean;
    log?: (line: string) => void;
    model?: ModelClient;
    embedder?: Embedder; // injected by tests
  }
  export interface PrepResult {
    path: string;
    location: string;
    locationEntityId: string;
    chunkIds: string[];
  }
  export const PREP_PROMPT_VERSION = 1;
  export function prepPath(campaignsDir: string, campaign: string, session: number): string;
  export function parsePrepHeader(
    markdown: string
  ): { location: string; locationEntityId: string } | undefined;
  export function runPrep(options: PrepOptions): Promise<PrepResult>;
  export function formatPrepSummary(result: PrepResult): string[];
  ```

**Design points this task must hold:**

1. **The opening location is always a real indexed entity.** With `--location`, retrieve that name; without, retrieve candidates anchored to `premise.region` and let the DM seat choose.
2. **If nothing clears the threshold, fail loudly** with the queries tried. Do **not** invent a location — a prep file naming a made-up place reintroduces the problem one step earlier.
3. **Only the front-matter header is parsed.** Body prose is for the model and the operator; nothing structural depends on it.
4. Without `--force`, refuse to overwrite an existing file.

- [ ] **Step 1: Write the failing test**

**How the threshold behaves under `FakeEmbedder`, and why these tests set it explicitly.** `FakeEmbedder` hashes the exact text, so a query that is not byte-identical to a chunk produces an effectively orthogonal vector and an arbitrary cosine. There is no query string that reliably scores above 0.69 in a unit test. So the fixture sets `loreThreshold` in `campaign.json` — `0` for the path where a location is found, `0.99` for the path where nothing clears it — and the tests are about prep's behaviour at a threshold, not about any particular score. Do not "fix" this by asserting a score; that is the mistake Plan 2B's 0.35 threshold made.

`apps/cli/test/prep.test.ts` — follow `apps/cli/test/index-lore.test.ts`'s `fixture()` helper, copied and extended with a `loreThreshold` argument. Every lore section's body must exceed 80 characters or the chunker drops it (`CHUNK_MIN_CHARS`).

```ts
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEmbedder } from '@cartyx-sim/lore';
import type { ChatMessage, ModelClient } from '@cartyx-sim/core';
import { describe, expect, it } from 'vitest';
import { runIndex } from '../src/index-lore';
import { parsePrepHeader, prepPath, runPrep } from '../src/prep';

/** A model that answers every request with the same body; no test may reach a network. */
function stubModel(reply = '## Hook\n\nSomething is wrong at the workshop.\n'): ModelClient {
  return {
    async complete() {
      return { text: reply, toolCalls: [] };
    },
  } as unknown as ModelClient;
}

async function fixture(loreThreshold: number): Promise<{ campaignsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sim-prep-'));
  const lore = join(root, 'lore');
  await mkdir(join(lore, 'dm'), { recursive: true });
  await writeFile(
    join(lore, 'dm', 'alpharetta.md'),
    '# Alpharetta\n\nA prosperous city north of Atlanta, home to the Avalon Artificers Academy, ' +
      'a dozen rival workshops and the best bake-off in the metro area.\n'
  );
  const campaignsDir = join(root, 'campaigns');
  const dir = join(campaignsDir, 'test');
  await mkdir(join(dir, 'characters'), { recursive: true });
  await writeFile(
    join(dir, 'campaign.json'),
    JSON.stringify({
      name: 'Test',
      targetMinutes: 5,
      lorePath: lore,
      loreThreshold,
      premise: { world: 'Cartyx', region: 'The Atlanta metro area, Georgia.' },
      endpoints: { local: { baseURL: 'http://127.0.0.1:1234/v1' } },
      seats: {
        dm: { endpoint: 'local', model: 'dm-model' },
        embed: { endpoint: 'local', model: 'embed-model' },
        players: { kira: { endpoint: 'local', model: 'pc-model' } },
      },
    })
  );
  await writeFile(
    join(dir, 'characters', 'kira.json'),
    JSON.stringify({
      id: 'kira',
      name: 'Kira Vale',
      kind: 'pc',
      level: 1,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      proficiencyBonus: 2,
      saveProficiencies: [],
      skillProficiencies: [],
      ac: 12,
      maxHp: 8,
      hp: 8,
      persona: { motivation: 'Clear the workshop’s name.' },
    })
  );
  // Prep reads an index; build it here so the test is about prep, not about indexing.
  await runIndex({ campaignsDir, campaign: 'test', embedder: new FakeEmbedder(16) });
  return { campaignsDir };
}

describe('parsePrepHeader', () => {
  it('reads the fields the engine depends on', () => {
    const md = [
      '---',
      'session: 14',
      'location: Alpharetta',
      'locationEntityId: kanka-1465238',
      '---',
      '',
      '## Hook',
      'Something is wrong.',
    ].join('\n');
    expect(parsePrepHeader(md)).toEqual({
      location: 'Alpharetta',
      locationEntityId: 'kanka-1465238',
    });
  });

  it('returns undefined for a file with no header, rather than guessing from the prose', () => {
    expect(parsePrepHeader('## Hook\n\nSomething happened in Alpharetta.')).toBeUndefined();
  });

  it('returns undefined when the header is missing a field the engine needs', () => {
    expect(parsePrepHeader('---\nsession: 14\n---\n\n## Hook\n')).toBeUndefined();
  });
});

describe('runPrep', () => {
  it('pins the location given on the command line and records its real entity id', async () => {
    const { campaignsDir } = await fixture(0);
    const result = await runPrep({
      campaignsDir,
      campaign: 'test',
      session: 1,
      location: 'Alpharetta',
      embedder: new FakeEmbedder(16),
      model: stubModel(),
    });
    expect(result.location).toBe('Alpharetta');
    // A real indexed entity, never invented. This repo has no kanka-export, so it is a file id.
    expect(result.locationEntityId).toMatch(/^(kanka-\d+|file:)/);
    expect(result.chunkIds.length).toBeGreaterThan(0);
    // The header the engine will read back must round-trip.
    const written = await readFile(result.path, 'utf8');
    expect(parsePrepHeader(written)).toEqual({
      location: 'Alpharetta',
      locationEntityId: result.locationEntityId,
    });
    expect(written).toContain('## Hook');
  });

  it('refuses rather than inventing when nothing clears the threshold', async () => {
    const { campaignsDir } = await fixture(0.99);
    await expect(
      runPrep({
        campaignsDir,
        campaign: 'test',
        session: 1,
        location: 'Nowhere At All',
        embedder: new FakeEmbedder(16),
        model: stubModel(),
      })
      // The message names what it tried, so an operator can see why and pick a real place.
    ).rejects.toThrow(/Nowhere At All/);
    // And nothing was written: a prep file naming a made-up place is the failure this prevents.
    await expect(readFile(prepPath(campaignsDir, 'test', 1), 'utf8')).rejects.toThrow();
  });

  it('refuses to overwrite an existing outline without --force', async () => {
    const { campaignsDir } = await fixture(0);
    const options = {
      campaignsDir,
      campaign: 'test',
      session: 1,
      location: 'Alpharetta',
      embedder: new FakeEmbedder(16),
    };
    const first = await runPrep({
      ...options,
      model: stubModel('## Hook\n\nThe first outline.\n'),
    });
    await expect(
      runPrep({ ...options, model: stubModel('## Hook\n\nA second outline.\n') })
    ).rejects.toThrow(/--force/);
    expect(await readFile(first.path, 'utf8')).toContain('The first outline.');
  });

  it('overwrites with --force', async () => {
    const { campaignsDir } = await fixture(0);
    const options = {
      campaignsDir,
      campaign: 'test',
      session: 1,
      location: 'Alpharetta',
      embedder: new FakeEmbedder(16),
    };
    await runPrep({ ...options, model: stubModel('## Hook\n\nThe first outline.\n') });
    const second = await runPrep({
      ...options,
      force: true,
      model: stubModel('## Hook\n\nA second outline.\n'),
    });
    const written = await readFile(second.path, 'utf8');
    expect(written).toContain('A second outline.');
    expect(written).not.toContain('The first outline.');
  });
});
```

`stubModel`'s cast is there because `ModelClient` has more surface than prep uses; if the real interface is small enough to implement outright, implement it and drop the cast. Check `packages/core/src/model.ts` before writing it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/cli/test/prep.test.ts`
Expected: FAIL — unresolved import `../src/prep`.

- [ ] **Step 3: Implement**

Create `apps/cli/src/prep.ts`. The two pure functions in full:

```ts
import { join } from 'node:path';
import { campaignDir } from './paths';

/** Where a session's outline lives. Zero-padded to three digits, like the session log paths. */
export function prepPath(campaignsDir: string, campaign: string, session: number): string {
  return join(
    campaignDir(campaignsDir, campaign),
    'prep',
    `session-${String(session).padStart(3, '0')}.md`
  );
}

/**
 * The outline's machine-readable header. Only the header is parsed: the body is prose for the
 * model and the operator, and nothing structural depends on parsing model-written text.
 *
 * Hand-rolled rather than a YAML dependency: the header is four known keys, and this project
 * prefers JSON for anything that needs a real parser.
 */
export function parsePrepHeader(
  markdown: string
): { location: string; locationEntityId: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (!match) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const location = fields.get('location');
  const locationEntityId = fields.get('locationEntityId');
  // A malformed header is not a half-usable one: the engine needs both or neither.
  if (!location || !locationEntityId) return undefined;
  return { location, locationEntityId };
}
```

Then `runPrep()`, in this order:

1. `loadCampaign(campaignsDir, campaign)`; require `campaign.lorePath`, erroring by name (`campaign.json has no lorePath; sim prep needs a lore repository`) otherwise.
2. Refuse if `prepPath(...)` exists and `!force`, with a message containing `--force`.
3. `const index = await openIndex(loreIndexDir(campaign), options.embedder ?? embedderFor(campaign))`.
4. `const threshold = campaign.loreThreshold ?? DEFAULT_LORE_THRESHOLD` (`DEFAULT_LORE_THRESHOLD` comes from `@cartyx-sim/core`).
5. Resolve the location. With `options.location`, search that one string. Without it, search `premise.region ?? premise.world ?? campaign.name`, collect the distinct `entityName`s of the hits that clear the threshold, and ask the DM seat to pick one by name; if the reply does not name a candidate, take the best-scoring one. Either way the result is a hit that came out of the index.
6. **Throw if nothing clears the threshold**, with the queries tried in the message. Do not invent a location — a prep file naming a made-up place reintroduces the problem this command exists to prevent, one step earlier.
7. Ask the DM seat for the body: the premise, the chosen location's chunk text, and each PC's name and `persona.motivation`, asking for the spec's shape (hook, 3–5 scenes, NPCs with motives, secrets and clues, likely endings).
8. Write the header plus the body with `writeFileAtomic`, after `mkdir(dirname(path), { recursive: true })`. The header carries `session`, `location`, `locationEntityId`, `loreChunkIds` and `generatedAt`.
9. Close the index in a `finally` — the same reason `runSession` does: never leak a LanceDB connection.

`formatPrepSummary()` prints the location, its entity id, the chunk count and the path, in the style of `formatIndexSummary`.

The model call goes through the DM seat with `findJsonReply` **not** used — the reply is prose, not JSON. Follow `apps/cli/src/script.ts` for how a CLI command builds a one-off model client from a campaign seat.

Register in `apps/cli/src/main.ts` following the existing `index`/`audit` style exactly — the `action(...)` wrapper, `parseNumber`, `--campaigns-dir` default.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/cli`
Expected: PASS.

- [ ] **Step 5: Verify the repo is green and commit**

```bash
npm run typecheck && npm test && npm run format:check
npx prettier --write apps/cli
git add apps/cli
git commit -m "feat(cli): add sim prep, seeded in a real indexed location"
```

---

### Task 8: Wire premise, personas and the outline into `sim run`

**Files:**

- Modify: `apps/cli/src/run.ts` (`directorConfig`, `campaignSetup`)
- Modify test: `apps/cli/test/run-campaign.test.ts`

**Interfaces:**

- Consumes: `Campaign.premise`/`personas` (Task 6); `prepPath` (Task 7); `DirectorConfig.premise`/`personas`/`prepOutline` (Task 5).
- Produces: nothing new.

**Behaviour:** when a lore-backed campaign has no prep file for the session, **warn and play** — a prep failure must never block a session, and the audit shows the difference.

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/test/run-campaign.test.ts`'s lore describe block, which already has `loreFixture(extra)` (it spreads `extra` into `campaign.json`), `readEvents`, and the `fake` endpoint. `loreFixture` writes `characters/kira.json` itself, so these tests rewrite that one file to add a persona.

```ts
it('passes the premise through and records the personas on session_start', async () => {
  const { campaign } = await loreFixture({
    premise: { world: 'Cartyx', region: 'The Atlanta metro area, Georgia.' },
  });
  await writeFile(
    join(campaignsDir, campaign, 'characters', 'kira.json'),
    JSON.stringify({
      ...KIRA,
      hp: 0,
      persona: { motivation: 'Clear the workshop’s name.', ties: 'Owes Professor Vaunt.' },
    })
  );
  const result = await runSession({
    campaignsDir,
    campaign,
    session: 1,
    resume: false,
    embedder: new FakeEmbedder(16),
  });
  const events = await readEvents(result.eventsPath);
  // The log is self-contained: an audit reads the personas this session was played with.
  expect(events.find((event) => event.type === 'session_start')).toMatchObject({
    personas: { kira: { motivation: 'Clear the workshop’s name.' } },
  });
  // The premise reached the DM seat.
  const dmPrompt = fake.requests.find((request) => request.model === 'dm-model')!;
  expect(JSON.stringify(dmPrompt.body)).toContain('World: Cartyx');
});

it('warns and plays when a lore campaign has no prep outline', async () => {
  const { campaign } = await loreFixture();
  const lines: string[] = [];
  const result = await runSession({
    campaignsDir,
    campaign,
    session: 1,
    resume: false,
    embedder: new FakeEmbedder(16),
    log: (line) => lines.push(line),
  });
  // A prep failure must never block a session; the audit shows the difference.
  expect(lines.join('\n')).toMatch(/no prep outline/i);
  expect(result.status).toBe('ended');
});

it('injects an existing prep outline into the DM prompt', async () => {
  const { campaign } = await loreFixture();
  await mkdir(join(campaignsDir, campaign, 'prep'), { recursive: true });
  await writeFile(
    join(campaignsDir, campaign, 'prep', 'session-001.md'),
    [
      '---',
      'session: 1',
      'location: Alpharetta',
      'locationEntityId: file:dm/avalon.md#avalon',
      '---',
      '',
      '## Hook',
      '',
      'A prototype went missing from the workshop overnight.',
    ].join('\n')
  );
  const lines: string[] = [];
  await runSession({
    campaignsDir,
    campaign,
    session: 1,
    resume: false,
    embedder: new FakeEmbedder(16),
    log: (line) => lines.push(line),
  });
  expect(lines.join('\n')).not.toMatch(/no prep outline/i);
  const dmPrompt = fake.requests.find((request) => request.model === 'dm-model')!;
  expect(JSON.stringify(dmPrompt.body)).toContain('A prototype went missing');
});
```

Check how the file's existing assertions reach into `fake.requests` before writing the last two — if it exposes parsed messages rather than a raw body, assert on those instead of `JSON.stringify`. The assertion is "the DM prompt contained this text"; the access path is whatever that helper already provides.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/cli/test/run-campaign.test.ts`
Expected: FAIL — no premise/persona/outline reaches the director.

- [ ] **Step 3: Implement**

In `apps/cli/src/run.ts`, extend the `directorConfig` helper added by the Plan 2B fix wave:

```ts
function directorConfig(
  campaign: Campaign,
  options: RunOptions,
  loreCommit: string,
  prepOutline: string | undefined
): DirectorConfig {
  return {
    session: options.session,
    targetMinutes: options.targetMinutes ?? campaign.targetMinutes,
    loreCommit,
    party: campaign.party,
    seats: campaign.seats,
    ...(campaign.loreThreshold === undefined ? {} : { loreThreshold: campaign.loreThreshold }),
    ...(campaign.premise ? { premise: campaign.premise } : {}),
    ...(campaign.personas ? { personas: campaign.personas } : {}),
    ...(prepOutline ? { prepOutline } : {}),
  };
}
```

`campaignSetup` calls `directorConfig` **three times** — the no-lore path, the resume path and the fresh path. Update all three; a field added to one and forgotten on the others is a session that plays by different rules depending on how it started, which is the comment already on that helper.

Read the outline before the lock, beside the other configuration loading:

```ts
/** The session's prep outline, or undefined with a warning when there is none. */
async function readPrepOutline(
  campaign: Campaign,
  session: number,
  campaignsDir: string,
  log: (line: string) => void
): Promise<string | undefined> {
  const path = prepPath(campaignsDir, campaign.id, session);
  try {
    return await readFile(path, 'utf8');
  } catch {
    // Warn and play: a prep failure must not block a session, and the audit shows the difference.
    log(`No prep outline at ${path}. Playing without one; run \`sim prep\` to seed the session.`);
    return undefined;
  }
}
```

Call it on the lore-backed paths and pass the result to `directorConfig`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/cli`
Expected: PASS.

- [ ] **Step 5: Verify the repo is green and commit**

```bash
npm run typecheck && npm test && npm run format:check
npx prettier --write apps/cli
git add apps/cli
git commit -m "feat(cli): play with the premise, personas and the session outline"
```

---

### Task 9: Documentation

**Files:**

- Modify: `docs/running-a-session.md`, `docs/status.md`, `README.md`, `docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md`

**Interfaces:** none.

- [ ] **Step 1: Operator guide**

In `docs/running-a-session.md`, add a section covering: writing a `premise` in `campaign.json`; writing a `persona` in a character file, including `loreEntityIds` and how to find an id (`sim index` prints ambiguous names; the wiki URL carries the entity id); running `sim prep`, with and without `--location`, and what its refusal means; that a session plays without prep and warns; and that ambient lore now appears as `lore_lookup` events with a `trigger` in the audit.

- [ ] **Step 2: Status**

In `docs/status.md`, add `sim prep` to "What works today", and note under session 014 that the prep/persona/ambient work is the response to its "No lore was used" finding.

- [ ] **Step 3: README and roadmap**

Add `sim prep` to the README's command list. In the roadmap, note that prep, personas and ambient lore are delivered ahead of the rest of Plan 2C, with the remaining 2C scope unchanged.

- [ ] **Step 4: Verify and commit**

```bash
npm run format:check
npx prettier --write docs README.md
git add docs README.md
git commit -m "docs: record prep, personas and ambient lore"
```

---

## After the plan

Measure before concluding anything. Run:

```bash
npm run sim -- prep  --campaign avalon --session 15 --location "Alpharetta"
npm run sim -- run   --campaign avalon --session 15 --target-minutes 15
npm run sim -- audit --campaign avalon --session 15
```

The three numbers that read zero in session 014 are the test:

| Measure             | Session 014 | Target        |
| ------------------- | ----------- | ------------- |
| Entities covered    | 0           | > 0           |
| Scenes tied to lore | 0 of 3      | most          |
| Lore lookups        | 1 (a gap)   | several, hits |

**Watch entities covered and scenes tied to lore, not the lookup count** — ambient retrieval raises the lookup count mechanically, so that number alone will look like success whether or not anything improved.

Use 10–15 minute sessions while iterating; a full hour only once coverage is real.

Two things from the spec's risk list to watch while measuring, neither of which is a task:

- **Gaps for lore that demonstrably exists** means 0.69 is too high for ambient queries, which exercise the threshold far harder than session 014 did. Lower `loreThreshold` in `campaign.json` rather than editing the default.
- **Prompt growth.** Premise, persona lines, outline and up to eight ambient chunks now land on every DM turn. Watch DM latency and the word share the session-012 batch worked to bring down. If ambient prose crowds the 30-line transcript window, cap ambient hits below `LORE_RESULT_LIMIT` — the cap is deliberately one number in `retrieveAmbient`.

Do not push. The user pushes.
