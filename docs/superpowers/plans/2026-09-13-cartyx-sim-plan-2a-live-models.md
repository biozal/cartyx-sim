# cartyx-sim Plan 2A — Live Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Plan 1 engine safe to run with real local models, then run it: a `models` package that talks to OpenAI-compatible servers, campaign config with per-seat endpoints and fallbacks, `sim bench` to check every seat, and `sim run` against real endpoints.

**Architecture:** Engine changes stay in `packages/core` (still I/O-free, now enforced by a Node-free typecheck): a player-safe prompt view, a runaway-loop backstop that pauses resumably, validator flags for every DM outcome, and turn ids plus tool choice on `ModelRequest`. A new `packages/models` implements `ModelClient` over the Vercel AI SDK's OpenAI-compatible provider with fallback targets and timeouts, plus seat benchmarking and a fake server for tests. `apps/cli` gains campaign loading (`campaign.yaml` + `characters/*.yaml`), `sim bench`, and a campaign-backed `sim run`. Lore retrieval arrives in Plan 2B; generated characters, prep, and production prompts in Plan 2C.

**Tech Stack:** Node ≥ 22.22, TypeScript 7.0.2, Vitest 5.0.0, Zod 4.6.4, Commander 15.0.0, Vercel AI SDK `ai` 7.0.99, `@ai-sdk/openai-compatible` 3.0.48, `yaml` 2.9.1, Prettier 3.9.6.

**Spec:** `docs/superpowers/specs/2026-09-13-cartyx-sim-v1-design.md` (roadmap, deviations, and backlog: `docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md`)

## Global Constraints

- `packages/core` and `packages/rules` must not import `node:*` modules; `npm run typecheck` enforces that after Task 1 (a Node-free `lib`, no `@types/node`). It does not and cannot enforce "no network I/O": the `DOM` lib still typechecks `fetch`. Network or filesystem I/O in `core`/`rules` is prohibited by convention and review, not by a lint rule. `packages/models` and `apps/cli` may do I/O.
- The event log is the single source of truth: `foldEvents(log)` must equal live state; a rejected or failed tool call leaves no events; older logs must still parse (new event fields are optional or defaulted).
- Every lookup keyed by a model- or event-supplied id uses `ownEntry`.
- Infrastructure failures (model endpoints, lore) retry with the director's delays, then pause resumably with a `session_paused` event (`seat`, `reason`, `kind`); they never crash `Director.run`.
- All dice go through an `Rng`; nothing calls `Math.random`.
- The director owns retries: model clients call the AI SDK with `maxRetries: 0`.
- The whole repository must pass `npm run format:check` (single quotes, semicolons, 2-space indent, `trailingComma: es5`, `printWidth: 100`).
- Dependencies use caret ranges in manifests with exact versions in `package-lock.json`; install with `npm install` during development and `npm ci` for clean checkouts.
- Commits end with the repository's required attribution trailer; do not push until the user asks.

## File Structure

```
packages/core/tsconfig.json          Node-free typecheck for core
packages/rules/tsconfig.json         Node-free typecheck for rules
packages/core/src/view.ts            PlayerView: player-safe game state for prompts
packages/core/src/director.ts        backstop limits, validator flags, turn ids, player view
packages/models/src/seat.ts          SeatConfig, Endpoint, ModelTarget schemas
packages/models/src/messages.ts      engine ChatMessage/ToolSchema <-> AI SDK mapping
packages/models/src/client.ts        OpenAICompatibleModelClient (fallbacks, timeouts)
packages/models/src/bench.ts         benchSeat
packages/models/src/testing.ts       startFakeOpenAIServer (test helper)
apps/cli/src/campaign.ts             loadCampaign: campaign.yaml + characters/*.yaml
apps/cli/src/bench.ts                runBench, formatBenchTable, benchPassed
apps/cli/src/run.ts                  runSession from a fixture or a campaign
apps/cli/src/jsonl-sink.ts           torn-tail recovery
apps/cli/examples/local-campaign/    example campaign.yaml and characters
docs/running-a-session.md            operator guide
```

Tasks that modify existing files show the exact change as a unified diff; apply it verbatim.

---

### Task 1: Keep Node APIs out of `core` and `rules` mechanically

Typecheck `packages/core` and `packages/rules` without Node types, so an accidental `node:*` import, `process`, or `Buffer` fails `npm run typecheck` instead of slipping into the embeddable engine.

**Files:**

- Modify: `package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/rules/tsconfig.json`

**Interfaces:**

- `npm run typecheck` now runs the root project plus `packages/rules/tsconfig.json` and `packages/core/tsconfig.json` (web-standard `DOM` lib, no `@types/node`).

- [ ] **Step 1: Make the change**

Modify `package.json`

```diff
diff --git a/package.json b/package.json
index 347268f..9d602d5 100644
--- a/package.json
+++ b/package.json
@@ -13,7 +13,7 @@
   "scripts": {
     "test": "vitest run",
     "test:watch": "vitest",
-    "typecheck": "tsc -p tsconfig.json",
+    "typecheck": "tsc -p tsconfig.json && tsc -p packages/rules/tsconfig.json && tsc -p packages/core/tsconfig.json",
     "format": "prettier --write .",
     "format:check": "prettier --check .",
     "sim": "tsx apps/cli/src/main.ts"
```

Create `packages/core/tsconfig.json`

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM"],
    "types": []
  },
  "include": ["src"]
}
```

Create `packages/rules/tsconfig.json`

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM"],
    "types": []
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Prove the guard works**

Run: `echo "import { readFile } from 'node:fs/promises'; export const probe = readFile;" > packages/core/src/zz-probe.ts && npx tsc -p packages/core/tsconfig.json; rm packages/core/src/zz-probe.ts`
Expected: `error TS2591: Cannot find name 'node:fs/promises'` — then the probe file is removed.

- [ ] **Step 3: Typecheck, run the full suite, and check formatting**

Run: `npm run typecheck && npm test && npm run format:check`
Expected: no type errors, every test passes, and Prettier reports all files formatted.

- [ ] **Step 4: Commit**

```bash
git add package.json \
  packages/core/tsconfig.json \
  packages/rules/tsconfig.json
git commit -m "build: typecheck core and rules without Node types"
```

### Task 2: Harden the engine contract for real models

Contract changes Plans 2B–4 depend on: a schema version on `session_start`, a `re_prompted` validator resolution, turn ids and tool choice on model requests, a player-safe `PlayerView` for prompts, living-but-downed PCs kept in initiative, an idle hand-off counter, and a clear `hand_off` result when nobody can respond.

**Files:**

- Modify: `packages/core/src/director.ts`
- Modify: `packages/core/src/events.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/model.ts`
- Modify: `packages/core/src/prompts.ts`
- Modify: `packages/core/src/state.ts`
- Modify: `packages/core/src/tools/combat.ts`
- Modify: `packages/core/src/tools/narrative.ts`
- Create: `packages/core/src/view.ts`
- Test (create): `packages/core/test/combat-initiative.test.ts`
- Test (create): `packages/core/test/contract.test.ts`
- Test (create): `packages/core/test/view.test.ts`

**Interfaces:**

- `EVENT_SCHEMA_VERSION` (1); `session_start.schemaVersion` defaults to 1 for older logs
- `validator_flag.resolution` adds `'re_prompted'`
- `ModelRequest` gains `turnId: string`, `toolChoice: ToolChoice` (`'auto' | 'required'`), `signal?: AbortSignal`; the director sends `toolChoice: 'required'`
- `playerView(state, pcId): PlayerView` (`pc`, `allies`, `others` by `VisibleStatus`, `npcs`, `scene`, `inCombat`) in `packages/core/src/view.ts`
- `PromptBuilder.player(input: PlayerPromptInput)` where `PlayerPromptInput = { view, transcript, instruction }` (no `GameState`)
- `GameState.idleHandOffs` — consecutive out-of-combat hand-offs with no responders
- `start_combat` rolls initiative for every living party member, including those at 0 HP

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/combat-initiative.test.ts`

```ts
import { scriptedRng } from '@cartyx-sim/rules';
import { describe, expect, it } from 'vitest';
import { TurnRecorder } from '../src/recorder';
import { advanceCombat, nextActor } from '../src/state';
import { startCombat } from '../src/tools/combat';
import { handOff } from '../src/tools/narrative';
import { kira, now, startedState, tomas } from './helpers';
import { toolHarness } from './tool-harness';

const goblins = {
  monsters: [
    {
      name: 'Goblin',
      ac: 13,
      maxHp: 7,
      attacks: [{ name: 'Scimitar', bonus: 4, damage: '1d6+2', damageType: 'slashing' }],
    },
  ],
};

describe('start_combat initiative', () => {
  it('adds a living party member at 0 HP to the order but never gives them a turn while down', async () => {
    const { state, history } = startedState([
      { ...kira, hp: 0, conditions: ['unconscious'] },
      tomas,
    ]);
    const harness = toolHarness({ state, history, rng: scriptedRng([15, 10, 5]) });
    const result = await harness.run(startCombat, goblins);
    expect(result.ok).toBe(true);
    const order = harness.recorder.state.combat!.order.map((entry) => entry.combatantId);
    expect(order).toContain('kira');
    expect(order).toEqual(['kira', 'tomas', 'goblin-1']);

    // The director moves past a downed first combatant; the pure helper it uses skips Kira.
    expect(advanceCombat(harness.recorder.state, { inclusive: true })).toMatchObject({
      combatantId: 'tomas',
    });
  });

  it('lets a PC healed mid-fight act on their next turn', async () => {
    const { state, history } = startedState([
      { ...kira, hp: 0, conditions: ['unconscious'] },
      tomas,
    ]);
    const harness = toolHarness({ state, history, rng: scriptedRng([15, 10, 5]) });
    await harness.run(startCombat, goblins);
    const recorder = new TurnRecorder(harness.recorder.state, 'heal', now);
    recorder.emit({ type: 'combat_turn', round: 1, turnIndex: 2, combatantId: 'goblin-1' });
    recorder.emit({
      type: 'state_change',
      entity: 'kira',
      field: 'hp',
      before: 0,
      after: 4,
      cause: 'healing:potion',
    });
    recorder.emit({
      type: 'state_change',
      entity: 'kira',
      field: 'conditions',
      before: ['unconscious'],
      after: [],
      cause: 'healing:potion',
    });
    const advance = advanceCombat(recorder.state)!;
    expect(advance).toEqual({ round: 2, turnIndex: 0, combatantId: 'kira' });
    recorder.emit({ type: 'combat_turn', ...advance });
    expect(nextActor(recorder.state)).toEqual({ kind: 'pc', pcId: 'kira', reason: 'combat_turn' });
  });

  it('still leaves the dead out of initiative', async () => {
    const { state, history } = startedState([{ ...kira, hp: 0, dead: true }, tomas]);
    const harness = toolHarness({ state, history, rng: scriptedRng([10, 5]) });
    await harness.run(startCombat, goblins);
    const order = harness.recorder.state.combat!.order.map((entry) => entry.combatantId);
    expect(order).not.toContain('kira');
  });
});

describe('hand_off when nobody can respond', () => {
  it('tells the DM to resolve the situation instead of silently handing off', async () => {
    const { state, history } = startedState([
      { ...kira, hp: 0, conditions: ['unconscious'] },
      { ...tomas, hp: 0, conditions: ['unconscious'] },
    ]);
    const harness = toolHarness({ state, history });
    const result = await harness.run(handOff, { target: { kind: 'party' } });
    expect(result).toMatchObject({
      ok: true,
      outcome: { endsBeat: true, result: expect.stringContaining('Nobody can respond') },
    });
  });
});
```

Create `packages/core/test/contract.test.ts`

```ts
import { scriptedRng } from '@cartyx-sim/rules';
import { describe, expect, it } from 'vitest';
import { Director } from '../src/director';
import { EVENT_SCHEMA_VERSION, SimEvent } from '../src/events';
import { basicPrompts } from '../src/prompts';
import { TurnRecorder } from '../src/recorder';
import { MemorySink } from '../src/sink';
import { respond, ScriptedModelClient, StaticLoreIndex, toolCall } from '../src/testing';
import { kira, now, startedState, tomas } from './helpers';

describe('event log contract', () => {
  it('stamps the schema version on session_start', async () => {
    const sink = new MemorySink();
    const director = await Director.create(
      {
        session: 1,
        targetMinutes: 60,
        loreCommit: 'abc',
        party: [kira, tomas],
        seats: { dm: 'dm', players: { kira: 'player-kira', tomas: 'player-tomas' } },
        retryDelaysMs: [],
      },
      {
        model: new ScriptedModelClient({}),
        lore: new StaticLoreIndex([]),
        rng: scriptedRng([]),
        sink,
        prompts: basicPrompts,
        now,
      }
    );
    await director.step();
    expect(sink.events[0]).toMatchObject({ type: 'session_start', schemaVersion: 1 });
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });

  it('reads a session_start written before the schema version existed as version 1', () => {
    const { history } = startedState();
    const legacy = { ...history[0]! } as Record<string, unknown>;
    delete legacy.schemaVersion;
    expect(SimEvent.parse(legacy)).toMatchObject({ type: 'session_start', schemaVersion: 1 });
  });

  it('accepts re_prompted as a validator_flag resolution', () => {
    const { state } = startedState();
    const recorder = new TurnRecorder(state, 'turn', now);
    const event = recorder.emit({
      type: 'validator_flag',
      visibility: 'dm',
      seat: 'dm',
      rule: 'invalid_tool_call',
      retries: 0,
      resolution: 're_prompted',
    });
    expect(event).toMatchObject({ resolution: 're_prompted' });
  });
});

describe('model requests', () => {
  it('carry the turn id and require a tool call', async () => {
    const model = new ScriptedModelClient({
      dm: [
        respond(
          toolCall('narrate', { text: 'The lab hums.' }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
      ],
    });
    let turn = 0;
    const director = await Director.create(
      {
        session: 1,
        targetMinutes: 60,
        loreCommit: 'abc',
        party: [kira, tomas],
        seats: { dm: 'dm', players: { kira: 'player-kira', tomas: 'player-tomas' } },
        retryDelaysMs: [],
      },
      {
        model,
        lore: new StaticLoreIndex([]),
        rng: scriptedRng([]),
        sink: new MemorySink(),
        prompts: basicPrompts,
        now,
        newTurnId: () => `turn-${++turn}`,
      }
    );
    await director.step();
    await director.step();
    expect(model.requests[0]).toMatchObject({
      seat: 'dm',
      turnId: 'turn-2',
      toolChoice: 'required',
    });
  });
});

describe('idle hand-offs', () => {
  it('counts consecutive out-of-combat hand-offs nobody could answer and resets on an answer', () => {
    const { state } = startedState();
    const recorder = new TurnRecorder(state, 'turn', now);
    recorder.emit({ type: 'hand_off', target: { kind: 'party' }, responders: [] });
    recorder.emit({ type: 'hand_off', target: { kind: 'party' }, responders: [] });
    expect(recorder.state.idleHandOffs).toBe(2);
    recorder.emit({ type: 'hand_off', target: { kind: 'party' }, responders: ['kira'] });
    expect(recorder.state.idleHandOffs).toBe(0);
  });
});
```

Create `packages/core/test/view.test.ts`

```ts
import { makeCombatant } from '@cartyx-sim/rules/testing';
import { describe, expect, it } from 'vitest';
import { basicPrompts } from '../src/prompts';
import { TurnRecorder } from '../src/recorder';
import { playerView } from '../src/view';
import { kira, now, startedState } from './helpers';

const ogre = makeCombatant({
  id: 'ogre-1',
  name: 'Ogre',
  kind: 'monster',
  ac: 17,
  hp: 30,
  maxHp: 59,
  attacks: [{ name: 'Greatclub', bonus: 6, damage: '2d8+4', damageType: 'bludgeoning' }],
});

function stateWithOgre() {
  const { state } = startedState();
  const recorder = new TurnRecorder(state, 'turn', now);
  recorder.emit({ type: 'combatant_added', combatant: ogre });
  recorder.emit({ type: 'scene_change', location: 'Crystal Engine Lab', artPrompt: 'A lab' });
  recorder.emit({
    type: 'npc_introduced',
    npcId: 'npc-sella-vaunt',
    name: 'Sella Vaunt',
    description: 'Crystal engine professor',
    invented: false,
  });
  return recorder.state;
}

describe('playerView', () => {
  it('gives the player their own sheet and allies vitals', () => {
    const view = playerView(stateWithOgre(), 'kira');
    expect(view.pc).toEqual(kira);
    expect(view.allies).toEqual([
      { id: 'tomas', name: 'Tomas Reed', hp: 12, maxHp: 12, conditions: [], dead: false },
    ]);
    expect(view.scene).toBe('Crystal Engine Lab');
    expect(view.npcs).toEqual([{ npcId: 'npc-sella-vaunt', name: 'Sella Vaunt' }]);
    expect(view.inCombat).toBe(false);
  });

  it('shows monsters only by coarse status, with no stat block', () => {
    const view = playerView(stateWithOgre(), 'kira');
    expect(view.others).toEqual([
      { id: 'ogre-1', name: 'Ogre', kind: 'monster', status: 'wounded' },
    ]);
    const serialized = JSON.stringify(view.others);
    for (const secret of ['17', '30', '59', 'Greatclub', '2d8']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('is a copy that cannot change the game state', () => {
    const state = stateWithOgre();
    const view = playerView(state, 'kira');
    view.pc.hp = 0;
    expect(state.combatants.kira?.hp).toBe(10);
  });

  it('rejects an unknown or prototype-named PC id', () => {
    expect(() => playerView(stateWithOgre(), 'constructor')).toThrow(
      'No party member "constructor"'
    );
  });

  it('keeps monster stats out of the basic player prompt', () => {
    const messages = basicPrompts.player({
      view: playerView(stateWithOgre(), 'kira'),
      transcript: '',
      instruction: 'Your turn.',
    });
    const prompt = messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('Ogre (id: ogre-1): wounded');
    expect(prompt).not.toContain('AC 17');
    expect(prompt).not.toContain('30/59');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/combat-initiative.test.ts packages/core/test/contract.test.ts packages/core/test/view.test.ts`
Expected: FAIL — the new tests fail: `EVENT_SCHEMA_VERSION` and `playerView` do not exist, `session_start` has no `schemaVersion`, and a downed PC is missing from initiative.

- [ ] **Step 3: Write the implementation**

Modify `packages/core/src/director.ts`

```diff
diff --git a/packages/core/src/director.ts b/packages/core/src/director.ts
index 1d5c8d7..387cb97 100644
--- a/packages/core/src/director.ts
+++ b/packages/core/src/director.ts
@@ -1,7 +1,7 @@
 import type { Combatant, Rng } from '@cartyx-sim/rules';
 import { clockInstruction, clockPhase } from './clock';
 import { SessionPausedError } from './errors';
-import type { SimEvent } from './events';
+import { EVENT_SCHEMA_VERSION, type SimEvent } from './events';
 import {
   ModelResponse,
   type ChatMessage,
@@ -30,6 +30,7 @@ import {
 } from './tools/types';
 import { renderTranscript, type Audience } from './transcript';
 import { validateDmText, validatePlayerText } from './validators';
+import { playerView } from './view';

 export interface DirectorConfig {
   session: number;
@@ -250,6 +251,7 @@ export class Director {
     const recorder = this.newRecorder();
     recorder.emit({
       type: 'session_start',
+      schemaVersion: EVENT_SCHEMA_VERSION,
       session: this.config.session,
       loreCommit: this.config.loreCommit,
       targetMinutes: this.config.targetMinutes,
@@ -282,7 +284,7 @@ export class Director {
     let ended = false;

     for (let step = 0; step < this.maxDmStepsPerBeat && !ended; step++) {
-      const response = await this.callModel(seat, messages, DM_TOOL_SCHEMAS);
+      const response = await this.callModel(seat, recorder.turnId, messages, DM_TOOL_SCHEMAS);
       const calls = callsFromResponse(response, 'narrate', `auto-narrate-${step}`);
       messages.push({
         role: 'assistant',
@@ -402,8 +404,7 @@ export class Director {
         ? 'It is your turn in combat. Declare your action with act or declare_spell, and optionally speak.'
         : 'The DM has turned to you. Respond in character: speak, act, or pass.';
     const messages = this.deps.prompts.player({
-      pc,
-      state: this.state,
+      view: playerView(this.state, pcId),
       transcript: this.transcript('player'),
       instruction,
     });
@@ -413,7 +414,7 @@ export class Director {
     const context = this.toolContext(recorder, pcId, seat);

     for (let attempt = 0; ; attempt++) {
-      const response = await this.callModel(seat, messages, PLAYER_TOOL_SCHEMAS);
+      const response = await this.callModel(seat, recorder.turnId, messages, PLAYER_TOOL_SCHEMAS);
       const calls = callsFromResponse(response, 'speak', `auto-speak-${attempt}`);
       messages.push({
         role: 'assistant',
@@ -538,12 +539,15 @@ export class Director {
   /** Calls the model and validates its response; a malformed response is a failed attempt. */
   private callModel(
     seat: string,
+    turnId: string,
     messages: ChatMessage[],
     tools: ToolSchema[]
   ): Promise<ModelResponse> {
     return this.withRetries(seat, async () => {
       const parsed = ModelResponse.safeParse(
-        await this.deps.model.complete({ seat, messages, tools })
+        // Every turn must end in a tool call (hand_off, speak, act, pass...), so require one;
+        // a seat's client config may relax this for servers that do not support it.
+        await this.deps.model.complete({ seat, turnId, messages, tools, toolChoice: 'required' })
       );
       if (!parsed.success) {
         const issues = parsed.error.issues.map(
```

Modify `packages/core/src/events.ts`

```diff
diff --git a/packages/core/src/events.ts b/packages/core/src/events.ts
index 112a643..b201a41 100644
--- a/packages/core/src/events.ts
+++ b/packages/core/src/events.ts
@@ -40,6 +40,9 @@ export const HandOffTarget = z.discriminatedUnion('kind', [
 ]);
 export type HandOffTarget = z.infer<typeof HandOffTarget>;

+/** Bumped whenever the event log format changes incompatibly; stamped on every `session_start`. */
+export const EVENT_SCHEMA_VERSION = 1;
+
 const base = {
   seq: z.number().int().min(0),
   ts: z.string().min(1),
@@ -51,6 +54,8 @@ export const SimEvent = z.discriminatedUnion('type', [
   z.object({
     ...base,
     type: z.literal('session_start'),
+    // Logs written before the field existed are version 1.
+    schemaVersion: z.literal(EVENT_SCHEMA_VERSION).default(EVENT_SCHEMA_VERSION),
     session: z.number().int().min(1),
     loreCommit: z.string(),
     targetMinutes: z.number().positive(),
@@ -164,7 +169,7 @@ export const SimEvent = z.discriminatedUnion('type', [
     seat: z.string().min(1),
     rule: z.string().min(1),
     retries: z.number().int().min(0),
-    resolution: z.enum(['accepted_with_flag', 'forced_pass', 'forced_hand_off']),
+    resolution: z.enum(['re_prompted', 'accepted_with_flag', 'forced_pass', 'forced_hand_off']),
   }),
   z.object({ ...base, type: z.literal('ooc_note'), text: z.string().min(1) }),
 ]);
```

Modify `packages/core/src/index.ts`

```diff
diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts
index 882a472..abf76e2 100644
--- a/packages/core/src/index.ts
+++ b/packages/core/src/index.ts
@@ -10,5 +10,6 @@ export * from './state';
 export * from './text';
 export * from './transcript';
 export * from './validators';
+export * from './view';
 export { DM_TOOLS, PLAYER_TOOLS } from './tools/registry';
 export { ToolError, toToolSchema, type ToolContext, type ToolDef } from './tools/types';
```

Modify `packages/core/src/model.ts`

```diff
diff --git a/packages/core/src/model.ts b/packages/core/src/model.ts
index 9e5fb86..ecbe97e 100644
--- a/packages/core/src/model.ts
+++ b/packages/core/src/model.ts
@@ -26,11 +26,19 @@ export interface ToolSchema {
   parameters: Record<string, unknown>;
 }

+/** Whether the model may answer with plain text ("auto") or must call a tool ("required"). */
+export type ToolChoice = 'auto' | 'required';
+
 export interface ModelRequest {
   /** Seat id from the campaign config, e.g. "dm" or "player-kira". */
   seat: string;
+  /** The engine turn this call belongs to. Stable across retries, so usable as an idempotency key. */
+  turnId: string;
   messages: ChatMessage[];
   tools: ToolSchema[];
+  toolChoice: ToolChoice;
+  /** Aborts the call, e.g. on shutdown. Clients apply their own timeout as well. */
+  signal?: AbortSignal;
 }

 export interface ModelClient {
```

Modify `packages/core/src/prompts.ts`

```diff
diff --git a/packages/core/src/prompts.ts b/packages/core/src/prompts.ts
index dc1d6e3..e4de751 100644
--- a/packages/core/src/prompts.ts
+++ b/packages/core/src/prompts.ts
@@ -1,6 +1,7 @@
 import type { Combatant } from '@cartyx-sim/rules';
 import type { ChatMessage } from './model';
 import type { GameState } from './state';
+import type { PlayerView } from './view';

 export interface PromptInput {
   state: GameState;
@@ -8,10 +9,17 @@ export interface PromptInput {
   instruction: string;
 }

-/** Builds the messages for each seat. Plan 2 replaces `basicPrompts` with lore- and persona-rich prompts. */
+export interface PlayerPromptInput {
+  /** A player-safe view of the game: no monster or NPC stat blocks. */
+  view: PlayerView;
+  transcript: string;
+  instruction: string;
+}
+
+/** Builds the messages for each seat. Plan 2C replaces `basicPrompts` with lore- and persona-rich prompts. */
 export interface PromptBuilder {
   dm(input: PromptInput): ChatMessage[];
-  player(input: PromptInput & { pc: Combatant }): ChatMessage[];
+  player(input: PlayerPromptInput): ChatMessage[];
 }

 const DM_SYSTEM = [
@@ -53,12 +61,18 @@ export const basicPrompts: PromptBuilder = {
       },
     ];
   },
-  player({ pc, transcript, instruction }) {
+  player({ view, transcript, instruction }) {
+    const allies = view.allies.map((ally) => {
+      const health = ally.dead ? 'DEAD' : `HP ${ally.hp}/${ally.maxHp}`;
+      const conditions = ally.conditions.length > 0 ? `, ${ally.conditions.join(', ')}` : '';
+      return `- ${ally.name} (id: ${ally.id}) ${health}${conditions}`;
+    });
+    const others = view.others.map((other) => `- ${other.name} (id: ${other.id}): ${other.status}`);
     return [
       {
         role: 'system',
         content: [
-          `You are playing ${pc.name} (id: ${pc.id}) in a Dungeons & Dragons 5e session.`,
+          `You are playing ${view.pc.name} (id: ${view.pc.id}) in a Dungeons & Dragons 5e session.`,
           'Stay in character. Use speak for dialogue and act to declare what you attempt; use pass if your character does nothing.',
           'Only ever control your own character, and never describe the outcome of your actions: the DM decides what happens.',
         ].join('\n'),
@@ -66,7 +80,10 @@ export const basicPrompts: PromptBuilder = {
       {
         role: 'user',
         content: [
-          `Your character:\n${describeCombatant(pc)}`,
+          `Your character:\n${describeCombatant(view.pc)}`,
+          `Party:\n${allies.join('\n') || '- just you'}`,
+          `Others here:\n${others.join('\n') || '- none'}`,
+          `Scene: ${view.scene ?? 'not set'}`,
           `Recent events:\n${transcript || '(nothing yet)'}`,
           instruction,
         ].join('\n\n'),
```

Modify `packages/core/src/state.ts`

```diff
diff --git a/packages/core/src/state.ts b/packages/core/src/state.ts
index 68a73df..abd856b 100644
--- a/packages/core/src/state.ts
+++ b/packages/core/src/state.ts
@@ -38,6 +38,8 @@ export interface GameState {
   silentTurns: number;
   /** Spoken words so far in the turn being recorded. */
   turnWords: number;
+  /** Consecutive out-of-combat hand-offs that no player character could answer. */
+  idleHandOffs: number;
 }

 export const OPEN_FLOOR_RESPONDERS = 2;
@@ -67,6 +69,7 @@ export function initialState(): GameState {
     wordsBySpeaker: {},
     silentTurns: 0,
     turnWords: 0,
+    idleHandOffs: 0,
   };
 }

@@ -121,11 +124,15 @@ export function applyEvent(state: GameState, event: SimEvent): GameState {
       next.scene = { location: event.location, loreEntityId: event.loreEntityId };
       break;
     case 'hand_off':
-      if (!next.combat) next.pendingResponders = [...event.responders];
+      if (!next.combat) {
+        next.pendingResponders = [...event.responders];
+        next.idleHandOffs = event.responders.length === 0 ? next.idleHandOffs + 1 : 0;
+      }
       break;
     case 'combat_start':
       next.combat = { order: event.order, round: 1, turnIndex: 0, declared: false };
       next.pendingResponders = [];
+      next.idleHandOffs = 0;
       break;
     case 'combat_turn':
       if (!next.combat) throw new Error('combat_turn without an active combat');
```

Modify `packages/core/src/tools/combat.ts`

```diff
diff --git a/packages/core/src/tools/combat.ts b/packages/core/src/tools/combat.ts
index df6b51a..7e19bbe 100644
--- a/packages/core/src/tools/combat.ts
+++ b/packages/core/src/tools/combat.ts
@@ -6,7 +6,7 @@ import {
   rollInitiative,
 } from '@cartyx-sim/rules';
 import { z } from 'zod';
-import { isUp, ownEntry } from '../state';
+import { ownEntry } from '../state';
 import { slugify } from '../text';
 import { defineTool, ToolError } from './types';

@@ -22,7 +22,7 @@ const MonsterSpec = z.object({
 export const startCombat = defineTool({
   name: 'start_combat',
   description:
-    'Start combat with the given monsters. The engine adds them, rolls initiative for everyone who can act, and fixes turn order.',
+    'Start combat with the given monsters. The engine adds them, rolls initiative for every living combatant (a party member at 0 HP joins the order but is skipped until healed), and fixes turn order.',
   parameters: z.object({ monsters: z.array(MonsterSpec).min(1) }),
   run(args, { recorder, rng }) {
     const { state } = recorder;
@@ -61,7 +61,11 @@ export const startCombat = defineTool({
       }
     }

-    const party = state.partyIds.map((id) => state.combatants[id]).filter(isUp);
+    // Every living party member joins initiative, even at 0 HP: the turn loop skips anyone who
+    // cannot act, so a PC healed mid-fight gets turns again.
+    const party = state.partyIds
+      .map((id) => ownEntry(state.combatants, id))
+      .filter((pc): pc is Combatant => pc !== undefined && !pc.dead);
     const participants = [...party, ...monsters];
     const order = rollInitiative(participants, rng);
```

Modify `packages/core/src/tools/narrative.ts`

```diff
diff --git a/packages/core/src/tools/narrative.ts b/packages/core/src/tools/narrative.ts
index 5e35491..46966de 100644
--- a/packages/core/src/tools/narrative.ts
+++ b/packages/core/src/tools/narrative.ts
@@ -169,9 +169,13 @@ export const handOff = defineTool({
     }
     const responders = selectResponders(args.target, state);
     recorder.emit({ type: 'hand_off', target: args.target, responders });
-    return {
-      result: responders.length > 0 ? `Handed off to ${responders.join(', ')}.` : 'Handed off.',
-      endsBeat: true,
-    };
+    let result = 'Handed off.';
+    if (responders.length > 0) result = `Handed off to ${responders.join(', ')}.`;
+    else if (!state.combat) {
+      result =
+        'Nobody can respond: no player character you handed off to is able to act. Resolve that in ' +
+        'the story (healing, rescue, or a scene change) before handing off again.';
+    }
+    return { result, endsBeat: true };
   },
 });
```

Create `packages/core/src/view.ts`

```ts
import type { Combatant, Condition } from '@cartyx-sim/rules';
import { ownEntry, type GameState } from './state';

/** How a non-PC combatant looks to the players: a coarse status, never numbers. */
export type VisibleStatus = 'unhurt' | 'wounded' | 'down' | 'dead';

export interface VisibleAlly {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  conditions: Condition[];
  dead: boolean;
}

export interface VisibleCombatant {
  id: string;
  name: string;
  kind: 'npc' | 'monster';
  status: VisibleStatus;
}

/**
 * Everything a player prompt may use. Built from `GameState` but containing no monster or NPC
 * stat blocks, so a `PromptBuilder` cannot leak them by construction (spec §5.5).
 */
export interface PlayerView {
  /** The player's own full character sheet. */
  pc: Combatant;
  /** The other party members' visible vitals. */
  allies: VisibleAlly[];
  /** Non-PC combatants in play, by coarse status only. */
  others: VisibleCombatant[];
  npcs: { npcId: string; name: string }[];
  scene: string | null;
  inCombat: boolean;
}

function visibleStatus(combatant: Combatant): VisibleStatus {
  if (combatant.dead) return 'dead';
  if (combatant.hp === 0) return 'down';
  return combatant.hp < combatant.maxHp ? 'wounded' : 'unhurt';
}

export function playerView(state: GameState, pcId: string): PlayerView {
  const pc = ownEntry(state.combatants, pcId);
  if (!pc) throw new Error(`No party member "${pcId}" in the game state`);
  const allies = state.partyIds
    .filter((id) => id !== pcId)
    .map((id) => ownEntry(state.combatants, id))
    .filter((ally) => ally !== undefined)
    .map(({ id, name, hp, maxHp, conditions, dead }) => ({
      id,
      name,
      hp,
      maxHp,
      conditions: [...conditions],
      dead,
    }));
  const others = Object.values(state.combatants)
    .filter((combatant) => combatant.kind !== 'pc')
    .map((combatant) => ({
      id: combatant.id,
      name: combatant.name,
      kind: combatant.kind as 'npc' | 'monster',
      status: visibleStatus(combatant),
    }));
  const npcs = Object.values(state.npcs).map(({ npcId, name }) => ({ npcId, name }));
  return {
    pc: structuredClone(pc),
    allies,
    others,
    npcs,
    scene: state.scene?.location ?? null,
    inCombat: state.combat !== null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/combat-initiative.test.ts packages/core/test/contract.test.ts packages/core/test/view.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5: Typecheck, run the full suite, and check formatting**

Run: `npm run typecheck && npm test && npm run format:check`
Expected: no type errors, every test passes, and Prettier reports all files formatted.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/director.ts \
  packages/core/src/events.ts \
  packages/core/src/index.ts \
  packages/core/src/model.ts \
  packages/core/src/prompts.ts \
  packages/core/src/state.ts \
  packages/core/src/tools/combat.ts \
  packages/core/src/tools/narrative.ts \
  packages/core/src/view.ts \
  packages/core/test/combat-initiative.test.ts \
  packages/core/test/contract.test.ts \
  packages/core/test/view.test.ts
git commit -m "feat(core): harden the engine contract for real models"
```

### Task 3: Runaway-loop backstop and a validator flag for every DM outcome

Make the director safe to leave running with real models: pause when the table goes silent or the DM keeps handing off to a party that cannot act, cap DM tool calls per beat, and flag every rejected, failed, or accepted-with-flag outcome (spec §5.6, §12).

> **Superseded by the review fix wave (see `fix-wave-findings.md` Fixes 1, 2, and 4):** the task below, as executed, paused on `silentTurns` (spoken words only) and recorded the pause as an `ooc_note`. The fix wave replaced that with `stalledTurns` (narration, dialogue, a roll, a state change, or a scene/combat change — not a PC's own declared action, which is not progress until the DM resolves it), added a `session_paused` event (`seat`, `reason`, `kind: 'seat' | 'backstop'`) that resets every backstop counter so a resume gets a fresh budget, and gave `SessionPausedError` that same `kind` so a backstop pause's message is the reason alone, not `Seat "..." failed: ...`. The code blocks below are left as originally written, for history.

**Files:**

- Modify: `packages/core/src/director.ts`
- Test (create): `packages/core/test/director-backstop.test.ts`
- Test (modify): `packages/core/test/director.test.ts`

**Interfaces:**

- `DirectorConfig` adds `silentTurnPauseLimit` (default 12), `idleHandOffLimit` (default 3), `maxDmToolCallsPerBeat` (default 24)
- Pauses surface as `RunResult { status: "paused", seat: <DM seat> }`, recorded in the log as a `session_paused` event (`seat`, `reason`, `kind`)
- DM `validator_flag` rules: `invalid_tool_call` and `tool_error` (`re_prompted`), the validator rule (`re_prompted`, then `accepted_with_flag` only after the tool succeeds), `dm_step_limit` / `dm_tool_call_limit` (`forced_hand_off`); player re-prompts are flagged `re_prompted` too

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/director-backstop.test.ts`

```ts
import { scriptedRng } from '@cartyx-sim/rules';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import { describe, expect, it } from 'vitest';
import { Director, type DirectorConfig } from '../src/director';
import { basicPrompts } from '../src/prompts';
import { TurnRecorder } from '../src/recorder';
import { MemorySink } from '../src/sink';
import { foldEvents } from '../src/state';
import {
  respond,
  ScriptedModelClient,
  StaticLoreIndex,
  toolCall,
  type ScriptedResponse,
} from '../src/testing';
import { kira, now, startedState, tomas } from './helpers';

function config(overrides: Partial<DirectorConfig> = {}): DirectorConfig {
  return {
    session: 1,
    targetMinutes: 60,
    loreCommit: 'test',
    party: [kira, tomas],
    seats: { dm: 'dm', players: { kira: 'player-kira', tomas: 'player-tomas' } },
    retryDelaysMs: [],
    ...overrides,
  };
}

async function director(
  script: Record<string, ScriptedResponse[]>,
  overrides: Partial<DirectorConfig> = {},
  sink = new MemorySink()
) {
  const model = new ScriptedModelClient(script);
  const created = await Director.create(config(overrides), {
    model,
    lore: new StaticLoreIndex([]),
    rng: scriptedRng([]),
    sink,
    prompts: basicPrompts,
    now,
  });
  return { director: created, model, sink };
}

const handOffParty = toolCall('hand_off', { target: { kind: 'party' } });

describe('runaway-loop backstop', () => {
  it('pauses when nobody speaks for too many turns', async () => {
    const pass = respond(toolCall('pass'));
    const { director: run, sink } = await director(
      {
        dm: [respond(handOffParty), respond(handOffParty)],
        'player-kira': [pass, pass],
        'player-tomas': [pass, pass],
      },
      { silentTurnLimit: 99, silentTurnPauseLimit: 5 }
    );
    const result = await run.run(50);
    expect(result).toMatchObject({ status: 'paused', seat: 'dm' });
    expect(sink.events.at(-1)).toMatchObject({
      type: 'ooc_note',
      text: expect.stringContaining('No one has spoken for 5 turns'),
    });
    expect(foldEvents(sink.events)).toEqual(run.currentState);
  });

  it('pauses during combat too', async () => {
    const goblin = makeCombatant({
      id: 'goblin-1',
      name: 'Goblin',
      kind: 'monster',
      hp: 7,
      maxHp: 7,
    });
    const sink = new MemorySink();
    const { state, history } = startedState([kira, tomas]);
    const recorder = new TurnRecorder(state, 'setup-combat', now);
    recorder.emit({ type: 'combatant_added', combatant: goblin });
    recorder.emit({
      type: 'combat_start',
      order: [
        { combatantId: 'goblin-1', roll: 20, dexMod: 0, total: 20 },
        { combatantId: 'kira', roll: 10, dexMod: 2, total: 12 },
        { combatantId: 'tomas', roll: 5, dexMod: 1, total: 6 },
      ],
    });
    await sink.append([...history, ...recorder.events]);
    const { director: run } = await director(
      {
        dm: [respond(handOffParty), respond(handOffParty), respond(handOffParty)],
        'player-kira': [respond(toolCall('pass'))],
        'player-tomas': [respond(toolCall('pass'))],
      },
      { silentTurnLimit: 99, silentTurnPauseLimit: 3 },
      sink
    );
    const result = await run.run(50);
    expect(result).toMatchObject({ status: 'paused' });
    expect(run.currentState.combat).not.toBeNull();
    expect(sink.events.at(-1)).toMatchObject({
      type: 'ooc_note',
      text: expect.stringContaining('No one has spoken for 3 turns'),
    });
  });

  it('pauses when the DM keeps handing off to a party that cannot act', async () => {
    const downed = [
      { ...kira, hp: 0, conditions: ['unconscious' as const] },
      { ...tomas, hp: 0, conditions: ['unconscious' as const] },
    ];
    const narrateAndHandOff = () =>
      respond(
        toolCall('narrate', { text: 'The party lies still on the cold floor.' }),
        handOffParty
      );
    const {
      director: run,
      sink,
      model,
    } = await director(
      { dm: [narrateAndHandOff(), narrateAndHandOff(), narrateAndHandOff()] },
      { party: downed, idleHandOffLimit: 2 }
    );
    const result = await run.run(50);
    expect(result).toMatchObject({ status: 'paused', seat: 'dm' });
    expect(model.remaining('dm')).toBe(1);
    expect(sink.events.at(-1)).toMatchObject({
      type: 'ooc_note',
      text: expect.stringContaining('handed off 2 times in a row'),
    });
  });

  it('caps DM tool calls per beat and forces the hand-off', async () => {
    const narrations = Array.from({ length: 5 }, (_, index) =>
      toolCall('narrate', { text: `Moment ${index + 1} passes.` })
    );
    const {
      director: run,
      sink,
      model,
    } = await director(
      { dm: [respond(...narrations, handOffParty)] },
      { maxDmToolCallsPerBeat: 3 }
    );
    await run.step();
    await run.step();
    const beat = sink.events.slice(1).map((event) => event.type);
    expect(beat.filter((type) => type === 'narration')).toHaveLength(3);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        type: 'validator_flag',
        rule: 'dm_tool_call_limit',
        resolution: 'forced_hand_off',
      })
    );
    expect(sink.events).toContainEqual(expect.objectContaining({ type: 'hand_off' }));
    expect(model.requests).toHaveLength(1);
  });
});

describe('DM validator flags', () => {
  it('flags an invalid tool call and a tool error as re-prompted', async () => {
    const { director: run, sink } = await director({
      dm: [
        respond(toolCall('narrate', {})),
        respond(toolCall('npc_say', { npcId: 'npc-nobody', text: 'Hello.' })),
        respond(toolCall('narrate', { text: 'The lab hums.' }), handOffParty),
      ],
    });
    await run.step();
    await run.step();
    const flags = sink.events.filter((event) => event.type === 'validator_flag');
    expect(flags).toEqual([
      expect.objectContaining({ rule: 'invalid_tool_call', resolution: 're_prompted' }),
      expect.objectContaining({ rule: 'tool_error', resolution: 're_prompted' }),
    ]);
  });

  it('flags accepted_with_flag only after the accepted tool actually succeeds', async () => {
    const controlling = toolCall('npc_say', {
      npcId: 'npc-nobody',
      text: 'Kira decides to open the door.',
    });
    const { director: run, sink } = await director(
      {
        dm: [
          respond(controlling),
          respond(toolCall('narrate', { text: 'The door stays shut.' }), handOffParty),
        ],
      },
      { maxValidatorRetries: 0 }
    );
    await run.step();
    await run.step();
    const flags = sink.events.filter((event) => event.type === 'validator_flag');
    expect(flags.map((flag) => flag.type === 'validator_flag' && flag.resolution)).toEqual([
      're_prompted',
    ]);
    expect(flags[0]).toMatchObject({ rule: 'tool_error' });
  });
});

describe('watchdog', () => {
  it('does not nudge the DM in combat even after the silent-turn limit', async () => {
    const goblin = makeCombatant({
      id: 'goblin-1',
      name: 'Goblin',
      kind: 'monster',
      hp: 7,
      maxHp: 7,
    });
    const sink = new MemorySink();
    const { state, history } = startedState([kira, tomas]);
    const recorder = new TurnRecorder(state, 'setup-combat', now);
    recorder.emit({ type: 'combatant_added', combatant: goblin });
    recorder.emit({
      type: 'combat_start',
      order: [
        { combatantId: 'kira', roll: 20, dexMod: 2, total: 22 },
        { combatantId: 'goblin-1', roll: 10, dexMod: 0, total: 10 },
        { combatantId: 'tomas', roll: 5, dexMod: 1, total: 6 },
      ],
    });
    recorder.emit({ type: 'turn_end', actor: 'dm' });
    recorder.emit({ type: 'turn_end', actor: 'dm' });
    await sink.append([...history, ...recorder.events]);
    const { director: run, model } = await director(
      { 'player-kira': [respond(toolCall('pass'))] },
      { silentTurnLimit: 2, silentTurnPauseLimit: 99 },
      sink
    );
    await run.step();
    // With the combat guard, the silent table goes to Kira's combat turn, not a DM nudge beat.
    expect(model.requests.map((request) => request.seat)).toEqual(['player-kira']);
  });
});
```

Modify `packages/core/test/director.test.ts`

```diff
diff --git a/packages/core/test/director.test.ts b/packages/core/test/director.test.ts
index 7199505..4cafe6d 100644
--- a/packages/core/test/director.test.ts
+++ b/packages/core/test/director.test.ts
@@ -197,6 +197,7 @@ describe('Director', () => {
       'dialogue',
       'action',
       'turn_end',
+      'validator_flag',
       'dialogue',
       'pass',
       'turn_end',
@@ -273,13 +274,15 @@ describe('Director', () => {
     await director.step();

     expect(sink.events.slice(1).map((e) => e.type)).toEqual([
+      'validator_flag',
       'narration',
       'validator_flag',
       'hand_off',
       'turn_end',
     ]);
-    expect(sink.events[1]).toMatchObject({ text: 'The door creaks.' });
-    expect(sink.events[2]).toMatchObject({ rule: 'dm_step_limit', resolution: 'forced_hand_off' });
+    expect(sink.events[1]).toMatchObject({ rule: 'dm_controls_pc', resolution: 're_prompted' });
+    expect(sink.events[2]).toMatchObject({ text: 'The door creaks.' });
+    expect(sink.events[3]).toMatchObject({ rule: 'dm_step_limit', resolution: 'forced_hand_off' });
     expect(model.requests[1]!.messages.at(-1)).toMatchObject({
       role: 'tool',
       content: expect.stringContaining('Rejected (dm_controls_pc)'),
@@ -902,7 +905,9 @@ describe('Director', () => {
     await director.run(3);

     expect(sink.events.filter((e) => e.type === 'dialogue')).toHaveLength(1);
-    expect(sink.events.filter((e) => e.type === 'validator_flag')).toHaveLength(0);
+    expect(sink.events.filter((e) => e.type === 'validator_flag')).toMatchObject([
+      { rule: 'tool_error', retries: 1, resolution: 're_prompted' },
+    ]);
     expect(sink.events.some((e) => e.type === 'action')).toBe(false);
     const kiraRequests = model.requests.filter((r) => r.seat === 'player-kira');
     expect(kiraRequests).toHaveLength(2);
@@ -934,7 +939,7 @@ describe('Director', () => {
     ]);
   });

-  it('G5.6: emits an accepted-with-flag validator flag before the narration once DM rejections are exhausted', async () => {
+  it('G5.6: flags each DM rejection, then accepted-with-flag after the narration once retries are exhausted', async () => {
     const violatingText = 'Kira decides to open the door.';
     const { deps: built, sink } = deps({
       dm: [
@@ -949,19 +954,25 @@ describe('Director', () => {
     await director.run(2);

     expect(sink.events.slice(1).map((e) => e.type)).toEqual([
+      'validator_flag',
       'validator_flag',
       'narration',
+      'validator_flag',
       'hand_off',
       'turn_end',
     ]);
-    expect(sink.events[1]).toMatchObject({
-      type: 'validator_flag',
-      visibility: 'dm',
-      rule: 'dm_controls_pc',
-      retries: 2,
-      resolution: 'accepted_with_flag',
-    });
-    expect(sink.events[2]).toMatchObject({ type: 'narration', text: violatingText });
+    expect(sink.events.slice(1, 5)).toMatchObject([
+      { type: 'validator_flag', rule: 'dm_controls_pc', retries: 1, resolution: 're_prompted' },
+      { type: 'validator_flag', rule: 'dm_controls_pc', retries: 2, resolution: 're_prompted' },
+      { type: 'narration', text: violatingText },
+      {
+        type: 'validator_flag',
+        visibility: 'dm',
+        rule: 'dm_controls_pc',
+        retries: 2,
+        resolution: 'accepted_with_flag',
+      },
+    ]);
   });

   it('G5.8: skips remaining calls in a response after a rejection, without ending the beat', async () => {
@@ -1208,6 +1219,12 @@ describe('Director', () => {
     await director.run(2);

     expect(sink.events[1]).toMatchObject({
+      type: 'validator_flag',
+      rule: 'dm_controls_pc',
+      retries: 1,
+      resolution: 're_prompted',
+    });
+    expect(sink.events[3]).toMatchObject({
       type: 'validator_flag',
       rule: 'dm_controls_pc',
       retries: 1,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/director-backstop.test.ts packages/core/test/director.test.ts`
Expected: FAIL — the backstop tests fail: the session never pauses, the tool-call cap is not enforced, and invalid calls or tool errors leave no `validator_flag`. The existing director tests that assert exact event lists also fail until updated for the new flags.

- [ ] **Step 3: Write the implementation**

Modify `packages/core/src/director.ts`

```diff
diff --git a/packages/core/src/director.ts b/packages/core/src/director.ts
index 387cb97..2296aee 100644
--- a/packages/core/src/director.ts
+++ b/packages/core/src/director.ts
@@ -49,6 +49,12 @@ export interface DirectorConfig {
   transcriptWindow?: number;
   /** Consecutive silent turns before the DM is nudged to narrate. Default 6. */
   silentTurnLimit?: number;
+  /** Consecutive silent turns, in or out of combat, before the session pauses. Default 12. */
+  silentTurnPauseLimit?: number;
+  /** Consecutive hand-offs that no player character can answer before the session pauses. Default 3. */
+  idleHandOffLimit?: number;
+  /** Tool calls the DM may make in one beat before hand_off is forced. Default 24. */
+  maxDmToolCallsPerBeat?: number;
   /** Waits between retries of a failing model call; the session pauses after the last. */
   retryDelaysMs?: number[];
 }
@@ -76,6 +82,11 @@ function toolMessage(call: ToolCall, content: string): ChatMessage {
   return { role: 'tool', toolCallId: call.id, toolName: call.name, content };
 }

+/** The distinct rule names of a set of problems, for one validator_flag. */
+function ruleList(problems: readonly { rule: string }[]): string {
+  return [...new Set(problems.map((problem) => problem.rule))].join(',');
+}
+
 /** The same ids, ignoring order. */
 function sameIds(a: readonly string[], b: readonly string[]): boolean {
   return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
@@ -96,6 +107,9 @@ export class Director {
   private readonly maxValidatorRetries: number;
   private readonly transcriptWindow: number;
   private readonly silentTurnLimit: number;
+  private readonly silentTurnPauseLimit: number;
+  private readonly idleHandOffLimit: number;
+  private readonly maxDmToolCallsPerBeat: number;
   private readonly retryDelaysMs: number[];
   private readonly now: () => Date;
   private readonly newTurnId: () => string;
@@ -113,6 +127,9 @@ export class Director {
     this.maxValidatorRetries = config.maxValidatorRetries ?? 2;
     this.transcriptWindow = config.transcriptWindow ?? 30;
     this.silentTurnLimit = config.silentTurnLimit ?? 6;
+    this.silentTurnPauseLimit = config.silentTurnPauseLimit ?? 12;
+    this.idleHandOffLimit = config.idleHandOffLimit ?? 3;
+    this.maxDmToolCallsPerBeat = config.maxDmToolCallsPerBeat ?? 24;
     this.retryDelaysMs = config.retryDelaysMs ?? [1000, 4000, 15000];
     this.now = deps.now ?? (() => new Date());
     this.newTurnId = deps.newTurnId ?? (() => crypto.randomUUID());
@@ -222,6 +239,7 @@ export class Director {
       await this.commit(recorder);
       return 'ended';
     }
+    this.pauseIfStuck();
     const next = nextActor(this.state);
     if (next.kind === 'ended') return 'ended';

@@ -247,6 +265,29 @@ export class Director {
     return this.state.ended ? 'ended' : 'continue';
   }

+  /**
+   * The runaway-loop backstop (spec §12): the watchdog only nudges, so a table that stays silent
+   * or a DM who keeps handing off to a party that cannot act would otherwise loop forever. Pausing
+   * is resumable, and the state that tripped it is derived from the log.
+   */
+  private pauseIfStuck(): void {
+    const seat = this.config.seats.dm;
+    if (this.state.silentTurns >= this.silentTurnPauseLimit) {
+      throw new SessionPausedError(
+        seat,
+        `No one has spoken for ${this.state.silentTurns} turns in a row. Check the seats' model ` +
+          'output, then resume.'
+      );
+    }
+    if (this.state.idleHandOffs >= this.idleHandOffLimit) {
+      throw new SessionPausedError(
+        seat,
+        `The DM handed off ${this.state.idleHandOffs} times in a row with no player character able ` +
+          'to respond. Resolve the downed party (or raise idleHandOffLimit), then resume.'
+      );
+    }
+  }
+
   private async startSession(): Promise<void> {
     const recorder = this.newRecorder();
     recorder.emit({
@@ -282,8 +323,10 @@ export class Director {
     let mechanicsCalled = false;
     let rejections = 0;
     let ended = false;
+    let toolCalls = 0;
+    let callLimitHit = false;

-    for (let step = 0; step < this.maxDmStepsPerBeat && !ended; step++) {
+    for (let step = 0; step < this.maxDmStepsPerBeat && !ended && !callLimitHit; step++) {
       const response = await this.callModel(seat, recorder.turnId, messages, DM_TOOL_SCHEMAS);
       const calls = callsFromResponse(response, 'narrate', `auto-narrate-${step}`);
       messages.push({
@@ -301,16 +344,21 @@ export class Director {

       let skipRest = false;
       for (const call of calls) {
-        if (ended || skipRest) {
+        if (!ended && !skipRest && toolCalls >= this.maxDmToolCallsPerBeat) callLimitHit = true;
+        if (ended || skipRest || callLimitHit) {
           const why = ended
             ? 'your turn already ended with hand_off'
-            : 'an earlier call was rejected';
+            : callLimitHit
+              ? 'you reached the tool call limit for this turn'
+              : 'an earlier call was rejected';
           messages.push(toolMessage(call, `Not executed: ${why}.`));
           continue;
         }
+        toolCalls++;
         const prepared = prepareToolCall(call, DM_TOOLS);
         if (!prepared.ok) {
           messages.push(toolMessage(call, prepared.error));
+          this.flag(recorder, seat, 'invalid_tool_call', rejections, 're_prompted');
           skipRest = true;
           continue;
         }
@@ -318,33 +366,27 @@ export class Director {
         const violation = text
           ? validateDmText(text, { pcNames, mechanicsToolCalled: mechanicsCalled })
           : null;
-        if (violation) {
-          if (rejections < this.maxValidatorRetries) {
-            rejections++;
-            messages.push(
-              toolMessage(
-                call,
-                `Rejected (${violation.rule}): ${violation.message} Call the tool again with corrected text.`
-              )
-            );
-            skipRest = true;
-            continue;
-          }
-          recorder.emit({
-            type: 'validator_flag',
-            visibility: 'dm',
-            seat,
-            rule: violation.rule,
-            retries: rejections,
-            resolution: 'accepted_with_flag',
-          });
+        if (violation && rejections < this.maxValidatorRetries) {
+          rejections++;
+          messages.push(
+            toolMessage(
+              call,
+              `Rejected (${violation.rule}): ${violation.message} Call the tool again with corrected text.`
+            )
+          );
+          this.flag(recorder, seat, violation.rule, rejections, 're_prompted');
+          skipRest = true;
+          continue;
         }
         const execution = await runPreparedCall(prepared.def, prepared.args, context);
         if (!execution.ok) {
           messages.push(toolMessage(call, `Error: ${execution.error}`));
+          this.flag(recorder, seat, 'tool_error', rejections, 're_prompted');
           skipRest = true;
           continue;
         }
+        // Retries are exhausted: the output stands, flagged only once it actually took effect.
+        if (violation) this.flag(recorder, seat, violation.rule, rejections, 'accepted_with_flag');
         if (MECHANICS_TOOL_NAMES.has(call.name)) mechanicsCalled = true;
         if (execution.outcome.endsBeat) ended = true;
         messages.push(toolMessage(call, execution.outcome.result));
@@ -352,14 +394,8 @@ export class Director {
     }

     if (!ended) {
-      recorder.emit({
-        type: 'validator_flag',
-        visibility: 'dm',
-        seat,
-        rule: 'dm_step_limit',
-        retries: rejections,
-        resolution: 'forced_hand_off',
-      });
+      const rule = callLimitHit ? 'dm_tool_call_limit' : 'dm_step_limit';
+      this.flag(recorder, seat, rule, rejections, 'forced_hand_off');
       const forced = prepareToolCall(
         { id: 'forced-hand-off', name: 'hand_off', args: { target: { kind: 'party' } } },
         DM_TOOLS
@@ -453,6 +489,7 @@ export class Director {
         for (const call of calls) messages.push(toolMessage(call, `Not executed. ${summary}`));
         if (calls.length === 0)
           messages.push({ role: 'user', content: `Your response was rejected. ${summary}` });
+        this.flag(recorder, seat, ruleList(problems), attempt + 1, 're_prompted');
         continue;
       }

@@ -476,18 +513,18 @@ export class Director {
         recorder.rollback(checkpoint);
         const summary = problems.map((problem) => `${problem.rule}: ${problem.message}`).join(' ');
         for (const call of calls) messages.push(toolMessage(call, `Not executed. ${summary}`));
+        this.flag(recorder, seat, ruleList(problems), attempt + 1, 're_prompted');
         continue;
       }

       if (problems.length > 0) {
-        recorder.emit({
-          type: 'validator_flag',
-          visibility: 'dm',
+        this.flag(
+          recorder,
           seat,
-          rule: problems.map((problem) => problem.rule).join(','),
-          retries: attempt,
-          resolution: tookTurn ? 'accepted_with_flag' : 'forced_pass',
-        });
+          ruleList(problems),
+          attempt,
+          tookTurn ? 'accepted_with_flag' : 'forced_pass'
+        );
       }
       if (!tookTurn) recorder.emit({ type: 'pass', actor: pcId });
       break;
@@ -497,6 +534,17 @@ export class Director {
     await this.commit(recorder);
   }

+  /** Records a validator outcome for the lore audit and review (spec §5.6: every case is flagged). */
+  private flag(
+    recorder: TurnRecorder,
+    seat: string,
+    rule: string,
+    retries: number,
+    resolution: 're_prompted' | 'accepted_with_flag' | 'forced_pass' | 'forced_hand_off'
+  ): void {
+    recorder.emit({ type: 'validator_flag', visibility: 'dm', seat, rule, retries, resolution });
+  }
+
   private dmInstruction(
     reason: 'beat' | 'resolve' | 'monster',
     combatantId: string | undefined,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/director-backstop.test.ts packages/core/test/director.test.ts`
Expected: PASS — 50 tests.

- [ ] **Step 5: Typecheck, run the full suite, and check formatting**

Run: `npm run typecheck && npm test && npm run format:check`
Expected: no type errors, every test passes, and Prettier reports all files formatted.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/director.ts \
  packages/core/test/director-backstop.test.ts \
  packages/core/test/director.test.ts
git commit -m "feat(core): add a runaway-loop backstop and flag every DM validator outcome"
```

### Task 4: Recover from a torn final line in the event log

A crash or power loss mid-append can leave a partial last line. Ignore an unterminated, unparseable final line on read and truncate it before the next append, while still rejecting real corruption.

**Files:**

- Modify: `apps/cli/src/jsonl-sink.ts`
- Modify: `apps/cli/src/run.ts`
- Test (modify): `apps/cli/test/jsonl-sink.test.ts`
- Test (create): `apps/cli/test/jsonl-torn.test.ts`

**Interfaces:**

- `JsonlFileSinkFs` adds `truncate(path, length)`
- `JsonlFileSink.tornTail: { line, text } | undefined` after `readAll`
- `runSession` logs a notice when it resumes past a torn tail

- [ ] **Step 1: Write the failing tests**

Modify `apps/cli/test/jsonl-sink.test.ts`

```diff
diff --git a/apps/cli/test/jsonl-sink.test.ts b/apps/cli/test/jsonl-sink.test.ts
index d1ea95a..5cab447 100644
--- a/apps/cli/test/jsonl-sink.test.ts
+++ b/apps/cli/test/jsonl-sink.test.ts
@@ -26,6 +26,7 @@ function fakeFs(handle: {
 }): { fs: JsonlFileSinkFs; calls: string[] } {
   const calls: string[] = [];
   const fs: JsonlFileSinkFs = {
+    truncate: async () => {},
     open: async () => {
       calls.push('open');
       return {
@@ -226,6 +227,7 @@ describe('JsonlFileSink', () => {
       const real = await import('node:fs/promises');
       const calls: string[] = [];
       const fs: JsonlFileSinkFs = {
+        truncate: (path, length) => real.truncate(path, length),
         open: (path, flags) => {
           calls.push('open');
           return real.open(path, flags);
```

Create `apps/cli/test/jsonl-torn.test.ts`

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimEvent } from '@cartyx-sim/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFileSink } from '../src/jsonl-sink';

const event = (seq: number): SimEvent =>
  SimEvent.parse({
    seq,
    ts: '2026-09-13T12:00:00.000Z',
    turnId: `turn-${seq}`,
    visibility: 'dm',
    type: 'ooc_note',
    text: `note ${seq}`,
  });

describe('JsonlFileSink torn writes', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cartyx-sim-torn-'));
    path = join(dir, 'events.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('ignores an unterminated, unparseable final line and removes it on the next append', async () => {
    const whole = `${JSON.stringify(event(0))}\n`;
    await writeFile(path, `${whole}{"seq":1,"ts":"2026-09-13T12:0`);
    const sink = new JsonlFileSink(path);

    expect(await sink.readAll()).toEqual([event(0)]);
    expect(sink.tornTail).toEqual({ line: 2, text: '{"seq":1,"ts":"2026-09-13T12:0' });

    await sink.append([event(1)]);
    expect(await readFile(path, 'utf8')).toBe(`${whole}${JSON.stringify(event(1))}\n`);
    expect(sink.tornTail).toBeUndefined();
    expect(await new JsonlFileSink(path).readAll()).toEqual([event(0), event(1)]);
  });

  it('keeps a valid final event that lacks its newline and appends after it cleanly', async () => {
    await writeFile(path, JSON.stringify(event(0)));
    const sink = new JsonlFileSink(path);

    expect(await sink.readAll()).toEqual([event(0)]);
    expect(sink.tornTail).toBeUndefined();

    await sink.append([event(1)]);
    expect(await new JsonlFileSink(path).readAll()).toEqual([event(0), event(1)]);
  });

  it('still rejects a corrupt line that is not the unterminated tail', async () => {
    await writeFile(path, `{"seq":0,"ts\n${JSON.stringify(event(1))}\n`);
    await expect(new JsonlFileSink(path).readAll()).rejects.toThrow(`${path}:1: invalid event`);
  });

  it('still rejects a corrupt final line that was fully terminated', async () => {
    await writeFile(path, `${JSON.stringify(event(0))}\n{"seq":1,"ts\n`);
    await expect(new JsonlFileSink(path).readAll()).rejects.toThrow(`${path}:2: invalid event`);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/test/jsonl-sink.test.ts apps/cli/test/jsonl-torn.test.ts`
Expected: FAIL — reading a log whose last line is `{"seq":1,"ts":"2026-09-13T12:0` throws `invalid event` instead of returning the complete events.

- [ ] **Step 3: Write the implementation**

Modify `apps/cli/src/jsonl-sink.ts`

```diff
diff --git a/apps/cli/src/jsonl-sink.ts b/apps/cli/src/jsonl-sink.ts
index 8944c48..8766fc4 100644
--- a/apps/cli/src/jsonl-sink.ts
+++ b/apps/cli/src/jsonl-sink.ts
@@ -1,5 +1,5 @@
 import type { FileHandle } from 'node:fs/promises';
-import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
+import { mkdir, open, readFile, stat, truncate, unlink } from 'node:fs/promises';
 import { dirname } from 'node:path';
 import { SimEvent, type EventSink } from '@cartyx-sim/core';

@@ -39,9 +39,10 @@ export interface JsonlFileSinkFs {
   readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
   stat: (path: string) => Promise<unknown>;
   unlink: (path: string) => Promise<void>;
+  truncate: (path: string, length: number) => Promise<void>;
 }

-const defaultFs: JsonlFileSinkFs = { open, mkdir, readFile, stat, unlink };
+const defaultFs: JsonlFileSinkFs = { open, mkdir, readFile, stat, unlink, truncate };

 /** Sinks holding a session lock in this process, so a signal handler can release them. */
 const heldLocks = new Set<JsonlFileSink>();
@@ -65,6 +66,14 @@ export class JsonlFileSink implements EventSink {
   private readonly fs: JsonlFileSinkFs;
   private readonly lockPath: string;
   private lastSeq: number | undefined;
+  /** How to make the file end cleanly before the next append, when `readAll` found it did not. */
+  private repair: { truncateTo: number } | { appendNewline: true } | undefined;
+  /**
+   * Set by `readAll` when the log ended in an unterminated line that is not a valid event: the
+   * remains of a write cut off by a crash or power loss. The line is ignored on read and removed
+   * before the next append.
+   */
+  tornTail: { line: number; text: string } | undefined;

   constructor(
     readonly path: string,
@@ -96,13 +105,23 @@ export class JsonlFileSink implements EventSink {
       throw error;
     }
     const events: SimEvent[] = [];
-    for (const [index, line] of content.split('\n').entries()) {
+    const lines = content.split('\n');
+    const terminated = content === '' || content.endsWith('\n');
+    this.tornTail = undefined;
+    this.repair = undefined;
+    for (const [index, line] of lines.entries()) {
       if (line.trim() === '') continue;
       const number = index + 1;
       let event: SimEvent;
       try {
         event = SimEvent.parse(JSON.parse(line));
       } catch (error) {
+        // Only an unterminated final line can be a torn write; anything else is corruption.
+        if (!terminated && index === lines.length - 1) {
+          this.tornTail = { line: number, text: line };
+          this.repair = { truncateTo: Buffer.byteLength(content) - Buffer.byteLength(line) };
+          break;
+        }
         const reason = error instanceof Error ? error.message : String(error);
         throw new Error(`${this.path}:${number}: invalid event (${reason})`);
       }
@@ -115,6 +134,7 @@ export class JsonlFileSink implements EventSink {
       }
       events.push(event);
     }
+    if (!terminated && !this.tornTail) this.repair = { appendNewline: true };
     this.lastSeq = events.length - 1;
     return events;
   }
@@ -131,13 +151,21 @@ export class JsonlFileSink implements EventSink {
       );
     }
     await this.fs.mkdir(dirname(this.path), { recursive: true });
+    if (this.repair && 'truncateTo' in this.repair) {
+      await this.fs.truncate(this.path, this.repair.truncateTo);
+    }
+    const separator = this.repair && 'appendNewline' in this.repair ? '\n' : '';
     const handle = await this.fs.open(this.path, 'a');
     try {
-      await handle.appendFile(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
+      await handle.appendFile(
+        `${separator}${events.map((event) => JSON.stringify(event)).join('\n')}\n`
+      );
       await handle.sync();
     } finally {
       await handle.close();
     }
+    this.repair = undefined;
+    this.tornTail = undefined;
     this.lastSeq = events.at(-1)!.seq;
   }
```

Modify `apps/cli/src/run.ts`

```diff
diff --git a/apps/cli/src/run.ts b/apps/cli/src/run.ts
index 8f4a89c..264ed43 100644
--- a/apps/cli/src/run.ts
+++ b/apps/cli/src/run.ts
@@ -63,6 +63,12 @@ export async function runSession(options: RunOptions): Promise<RunSessionResult>
         },
       }
     );
+    if (sink.tornTail) {
+      log(
+        `Ignoring an incomplete final line (line ${sink.tornTail.line}) left by an interrupted ` +
+          `write; it will be removed on the next write: ${eventsPath}`
+      );
+    }
     const result = await director.run();
     return { ...result, eventsPath };
   } finally {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/test/jsonl-sink.test.ts apps/cli/test/jsonl-torn.test.ts`
Expected: PASS — 23 tests.

- [ ] **Step 5: Typecheck, run the full suite, and check formatting**

Run: `npm run typecheck && npm test && npm run format:check`
Expected: no type errors, every test passes, and Prettier reports all files formatted.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/jsonl-sink.ts \
  apps/cli/src/run.ts \
  apps/cli/test/jsonl-sink.test.ts \
  apps/cli/test/jsonl-torn.test.ts
git commit -m "fix(cli): recover from a torn final line in the event log"
```

### Task 5: `models` package: an OpenAI-compatible model client

Implement `ModelClient` over the Vercel AI SDK for any OpenAI-compatible server (LM Studio, llama.cpp, mlx_lm, vLLM), with per-seat settings, fallback endpoints, timeouts, and a local fake server for tests.

**Files:**

- Create: `packages/models/package.json`
- Create: `packages/models/src/client.ts`
- Create: `packages/models/src/index.ts`
- Create: `packages/models/src/messages.ts`
- Create: `packages/models/src/seat.ts`
- Create: `packages/models/src/testing.ts`
- Test (create): `packages/models/test/client.test.ts`
- Test (create): `packages/models/test/messages.test.ts`
- Modify: `package-lock.json` (by `npm install`)

**Interfaces:**

- `SeatConfig` (zod): `endpoint { baseURL, apiKey? }`, `model`, `temperature?`, `maxOutputTokens?`, `timeoutMs` (default 120000), `toolChoice?`, `fallbacks[]`
- `new OpenAICompatibleModelClient(seats: Record<seatId, SeatConfigInput>)` implementing `ModelClient`
- `toInstructions`, `toModelMessages`, `toToolSet`, `toToolCalls` message mapping
- `startFakeOpenAIServer(reply, { models })` from `@cartyx-sim/models/testing`
- With `toolChoice: "required"`, the AI SDK rejects a text-only reply; the client treats it as a failed attempt

- [ ] **Step 1: Write the failing tests**

Create `packages/models/test/client.test.ts`

```ts
import {
  basicPrompts,
  Director,
  MemorySink,
  type ModelRequest,
  type ToolSchema,
} from '@cartyx-sim/core';
import { StaticLoreIndex } from '@cartyx-sim/core/testing';
import { scriptedRng } from '@cartyx-sim/rules';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleModelClient } from '../src/client';
import { startFakeOpenAIServer, type FakeOpenAIServer } from '../src/testing';

const narrateTool: ToolSchema = {
  name: 'narrate',
  description: 'Narrate the scene.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    seat: 'dm',
    turnId: 'turn-1',
    messages: [
      { role: 'system', content: 'You are the DM.' },
      { role: 'user', content: 'Begin.' },
    ],
    tools: [narrateTool],
    toolChoice: 'required',
    ...overrides,
  };
}

const servers: FakeOpenAIServer[] = [];
async function server(...args: Parameters<typeof startFakeOpenAIServer>) {
  const started = await startFakeOpenAIServer(...args);
  servers.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((started) => started.close()));
});

describe('OpenAICompatibleModelClient', () => {
  it('sends an OpenAI chat completion and maps the tool calls back', async () => {
    const fake = await server(() => ({
      text: 'thinking',
      toolCalls: [{ id: 'call_1', name: 'narrate', arguments: { text: 'The lab hums.' } }],
    }));
    const client = new OpenAICompatibleModelClient({
      dm: {
        endpoint: { baseURL: fake.baseURL },
        model: 'qwen-dm',
        temperature: 0.8,
        maxOutputTokens: 400,
      },
    });

    const response = await client.complete(request());

    expect(response).toEqual({
      text: 'thinking',
      toolCalls: [{ id: 'call_1', name: 'narrate', args: { text: 'The lab hums.' } }],
    });
    const sent = fake.requests[0]!;
    expect(sent).toMatchObject({
      model: 'qwen-dm',
      temperature: 0.8,
      max_tokens: 400,
      tool_choice: 'required',
      messages: [
        { role: 'system', content: 'You are the DM.' },
        { role: 'user', content: 'Begin.' },
      ],
    });
    expect(sent.tools?.[0]?.function).toMatchObject({
      name: 'narrate',
      parameters: narrateTool.parameters,
    });
  });

  it('returns plain text when tool calls are optional', async () => {
    const fake = await server(() => ({ text: 'The lab hums.' }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });
    expect(await client.complete(request({ toolChoice: 'auto' }))).toEqual({
      text: 'The lab hums.',
      toolCalls: [],
    });
  });

  it('treats a text-only reply to a required tool call as a failed attempt', async () => {
    const fake = await server(() => ({ text: 'I would rather just talk.' }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });
    await expect(client.complete(request())).rejects.toThrow('did not contain a tool call');
  });

  it('gives malformed tool arguments empty args for the engine to reject', async () => {
    const fake = await server(() => ({ toolCalls: [{ name: 'narrate', arguments: '{bad' }] }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });
    const response = await client.complete(request());
    expect(response.toolCalls).toMatchObject([{ name: 'narrate', args: {} }]);
  });

  it("lets a seat's toolChoice override the engine's request", async () => {
    const fake = await server(() => ({ text: 'ok' }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm', toolChoice: 'auto' },
    });
    await client.complete(request());
    expect(fake.requests[0]?.tool_choice).toBe('auto');
  });

  it('falls back to the next target when the primary fails', async () => {
    const primary = await server(() => ({ status: 500 }));
    const backup = await server(() => ({
      toolCalls: [{ name: 'narrate', arguments: { text: 'From the backup.' } }],
    }));
    const client = new OpenAICompatibleModelClient({
      dm: {
        endpoint: { baseURL: primary.baseURL },
        model: 'big',
        fallbacks: [{ endpoint: { baseURL: backup.baseURL }, model: 'small' }],
      },
    });
    expect(await client.complete(request())).toMatchObject({
      toolCalls: [{ name: 'narrate', args: { text: 'From the backup.' } }],
    });
    expect(primary.requests).toHaveLength(1);
    expect(backup.requests[0]?.model).toBe('small');
  });

  it('names every failed endpoint when all targets fail', async () => {
    const primary = await server(() => ({ status: 503 }));
    const backup = await server(() => ({ status: 500 }));
    const client = new OpenAICompatibleModelClient({
      dm: {
        endpoint: { baseURL: primary.baseURL },
        model: 'big',
        fallbacks: [{ endpoint: { baseURL: backup.baseURL }, model: 'small' }],
      },
    });
    await expect(client.complete(request())).rejects.toThrow(
      new RegExp(
        `Seat "dm" failed on every endpoint: big at ${primary.baseURL}.*; small at ${backup.baseURL}`
      )
    );
  });

  it('times out a slow endpoint', async () => {
    const fake = await server(() => ({ text: 'late', delayMs: 500 }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm', timeoutMs: 50 },
    });
    await expect(client.complete(request())).rejects.toThrow('Seat "dm" failed on every endpoint');
  });

  it('does not fall back after a deliberate abort', async () => {
    const primary = await server(() => ({ text: 'late', delayMs: 500 }));
    const backup = await server(() => ({ text: 'from backup' }));
    const client = new OpenAICompatibleModelClient({
      dm: {
        endpoint: { baseURL: primary.baseURL },
        model: 'big',
        fallbacks: [{ endpoint: { baseURL: backup.baseURL }, model: 'small' }],
      },
    });
    const controller = new AbortController();
    const pending = client.complete(request({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow();
    expect(backup.requests).toHaveLength(0);
  });

  it('rejects an unconfigured seat', async () => {
    const client = new OpenAICompatibleModelClient({});
    await expect(client.complete(request({ seat: 'player-kira' }))).rejects.toThrow(
      'No model is configured for seat "player-kira".'
    );
  });

  it('drives a Director turn, including a tool result sent back mid-beat', async () => {
    const fake = await server((body) => {
      const tools = (body.tools ?? []).map((entry) => entry.function.name);
      if (!tools.includes('narrate')) return { toolCalls: [{ name: 'pass', arguments: {} }] };
      const sawToolResult = body.messages.some((message) => message.role === 'tool');
      return sawToolResult
        ? { toolCalls: [{ name: 'hand_off', arguments: { target: { kind: 'party' } } }] }
        : { toolCalls: [{ name: 'narrate', arguments: { text: 'The crystal engines hum.' } }] };
    });
    const kira = makeCombatant({ id: 'kira', name: 'Kira Vale' });
    const seat = { endpoint: { baseURL: fake.baseURL }, model: 'm' };
    const sink = new MemorySink();
    const director = await Director.create(
      {
        session: 1,
        targetMinutes: 60,
        loreCommit: 'test',
        party: [kira],
        seats: { dm: 'dm', players: { kira: 'player-kira' } },
        retryDelaysMs: [],
      },
      {
        model: new OpenAICompatibleModelClient({ dm: seat, 'player-kira': seat }),
        lore: new StaticLoreIndex([]),
        rng: scriptedRng([]),
        sink,
        prompts: basicPrompts,
      }
    );

    const result = await director.run(3);

    expect(result.status).toBe('turn_limit');
    expect(sink.events.map((event) => event.type)).toEqual([
      'session_start',
      'narration',
      'hand_off',
      'turn_end',
      'pass',
      'turn_end',
    ]);
    const secondDmCall = fake.requests[1]!;
    const toolMessage = secondDmCall.messages.find((message) => message.role === 'tool');
    const assistant = secondDmCall.messages.find((message) => message.role === 'assistant');
    expect(toolMessage).toMatchObject({ content: 'Narrated.' });
    expect(toolMessage?.tool_call_id).toBe(assistant?.tool_calls?.[0]?.id);
  });
});
```

Create `packages/models/test/messages.test.ts`

```ts
import type { ChatMessage } from '@cartyx-sim/core';
import { describe, expect, it } from 'vitest';
import { toInstructions, toModelMessages, toToolCalls, toToolSet } from '../src/messages';

const conversation: ChatMessage[] = [
  { role: 'system', content: 'You are the DM.' },
  { role: 'system', content: 'Use tools.' },
  { role: 'user', content: 'Begin.' },
  {
    role: 'assistant',
    content: 'Setting the scene.',
    toolCalls: [{ id: 'c1', name: 'narrate', args: { text: 'The lab hums.' } }],
  },
  { role: 'tool', toolCallId: 'c1', toolName: 'narrate', content: 'Narrated.' },
  { role: 'assistant', content: '', toolCalls: [] },
];

describe('toInstructions', () => {
  it('joins every system message', () => {
    expect(toInstructions(conversation)).toBe('You are the DM.\n\nUse tools.');
  });

  it('is undefined without system messages', () => {
    expect(toInstructions([{ role: 'user', content: 'hi' }])).toBeUndefined();
  });
});

describe('toModelMessages', () => {
  it('drops system messages and maps assistant tool calls and tool results', () => {
    expect(toModelMessages(conversation)).toEqual([
      { role: 'user', content: 'Begin.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Setting the scene.' },
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'narrate',
            input: { text: 'The lab hums.' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'narrate',
            output: { type: 'text', value: 'Narrated.' },
          },
        ],
      },
      { role: 'assistant', content: '' },
    ]);
  });
});

describe('toToolSet', () => {
  it('creates tools without execute so calls come back to the engine', () => {
    const set = toToolSet([
      {
        name: 'narrate',
        description: 'Narrate.',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ]);
    expect(Object.keys(set)).toEqual(['narrate']);
    expect(set.narrate?.description).toBe('Narrate.');
    expect(
      set.narrate && 'execute' in set.narrate ? set.narrate.execute : undefined
    ).toBeUndefined();
  });
});

describe('toToolCalls', () => {
  it('keeps object arguments and empties anything else', () => {
    expect(
      toToolCalls([
        { toolCallId: 'a', toolName: 'speak', input: { text: 'Hi' } },
        { toolCallId: 'b', toolName: 'speak', input: '{bad' },
        { toolCallId: 'c', toolName: 'speak', input: ['x'] },
      ])
    ).toEqual([
      { id: 'a', name: 'speak', args: { text: 'Hi' } },
      { id: 'b', name: 'speak', args: {} },
      { id: 'c', name: 'speak', args: {} },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/models/test/client.test.ts packages/models/test/messages.test.ts`
Expected: FAIL — the tests cannot import `../src/client` and `../src/messages` because the package does not exist yet.

- [ ] **Step 3: Add the package manifest and install**

Create `packages/models/package.json`

```json
{
  "name": "@cartyx-sim/models",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts"
  },
  "dependencies": {
    "@ai-sdk/openai-compatible": "^3.0.48",
    "@cartyx-sim/core": "*",
    "ai": "^7.0.99",
    "zod": "^4.6.4"
  }
}
```

Run: `npm install`
Expected: install completes and links the workspace packages.

- [ ] **Step 4: Write the implementation**

Create `packages/models/src/client.ts`

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelClient, ModelRequest, ModelResponse } from '@cartyx-sim/core';
import { generateText } from 'ai';
import { toInstructions, toModelMessages, toToolCalls, toToolSet } from './messages';
import { SeatConfig, type ModelTarget, type SeatConfigInput } from './seat';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A `ModelClient` for OpenAI-compatible servers, one configuration per seat. Each call tries the
 * seat's primary target, then its fallbacks in order; the engine's director handles retry delays
 * and pausing when every target fails.
 */
export class OpenAICompatibleModelClient implements ModelClient {
  private readonly seats: ReadonlyMap<string, SeatConfig>;

  constructor(seats: Record<string, SeatConfigInput>) {
    this.seats = new Map(Object.entries(seats).map(([id, seat]) => [id, SeatConfig.parse(seat)]));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const seat = this.seats.get(request.seat);
    if (!seat) throw new Error(`No model is configured for seat "${request.seat}".`);
    const failures: string[] = [];
    for (const target of [seat, ...seat.fallbacks]) {
      try {
        return await this.generate(seat, target, request);
      } catch (error) {
        // A deliberate abort (e.g. shutdown) is not an endpoint failure; do not fall back.
        if (request.signal?.aborted) throw error;
        failures.push(`${target.model} at ${target.endpoint.baseURL}: ${errorMessage(error)}`);
      }
    }
    throw new Error(`Seat "${request.seat}" failed on every endpoint: ${failures.join('; ')}`);
  }

  private async generate(
    seat: SeatConfig,
    target: ModelTarget,
    request: ModelRequest
  ): Promise<ModelResponse> {
    const provider = createOpenAICompatible({
      name: 'cartyx-sim',
      baseURL: target.endpoint.baseURL,
      apiKey: target.endpoint.apiKey,
    });
    const timeout = AbortSignal.timeout(seat.timeoutMs);
    const hasTools = request.tools.length > 0;
    const result = await generateText({
      model: provider.chatModel(target.model),
      instructions: toInstructions(request.messages),
      messages: toModelMessages(request.messages),
      tools: hasTools ? toToolSet(request.tools) : undefined,
      toolChoice: hasTools ? (seat.toolChoice ?? request.toolChoice) : undefined,
      temperature: seat.temperature,
      maxOutputTokens: seat.maxOutputTokens,
      // The director owns retries (with delays, then a resumable pause).
      maxRetries: 0,
      abortSignal: request.signal ? AbortSignal.any([timeout, request.signal]) : timeout,
    });
    return { text: result.text, toolCalls: toToolCalls(result.toolCalls) };
  }
}
```

Create `packages/models/src/index.ts`

```ts
export * from './client';
export * from './messages';
export * from './seat';
```

Create `packages/models/src/messages.ts`

```ts
import type { ChatMessage, ToolCall, ToolSchema } from '@cartyx-sim/core';
import {
  jsonSchema,
  tool,
  type ModelMessage,
  type TextPart,
  type ToolCallPart,
  type ToolSet,
} from 'ai';

/** The engine's system messages, joined; the AI SDK takes them as `instructions`, not messages. */
export function toInstructions(messages: readonly ChatMessage[]): string | undefined {
  const system = messages.filter((message) => message.role === 'system');
  return system.length > 0 ? system.map((message) => message.content).join('\n\n') : undefined;
}

export function toModelMessages(messages: readonly ChatMessage[]): ModelMessage[] {
  const converted: ModelMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        break;
      case 'user':
        converted.push({ role: 'user', content: message.content });
        break;
      case 'assistant': {
        const parts: (TextPart | ToolCallPart)[] = [];
        if (message.content) parts.push({ type: 'text', text: message.content });
        for (const call of message.toolCalls) {
          parts.push({
            type: 'tool-call',
            toolCallId: call.id,
            toolName: call.name,
            input: call.args,
          });
        }
        converted.push({ role: 'assistant', content: parts.length > 0 ? parts : '' });
        break;
      }
      case 'tool':
        converted.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              output: { type: 'text', value: message.content },
            },
          ],
        });
        break;
    }
  }
  return converted;
}

/** Tools without `execute`, so the AI SDK returns the model's calls for the engine to run. */
export function toToolSet(tools: readonly ToolSchema[]): ToolSet {
  return Object.fromEntries(
    tools.map((schema) => [
      schema.name,
      tool({
        description: schema.description,
        inputSchema: jsonSchema(schema.parameters as Parameters<typeof jsonSchema>[0]),
      }),
    ])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Maps AI SDK tool calls to the engine's. A call whose arguments did not parse as a JSON object
 * gets empty args, so the engine's schema check reports it back to the model as invalid.
 */
export function toToolCalls(
  calls: readonly { toolCallId: string; toolName: string; input: unknown }[]
): ToolCall[] {
  return calls.map((call) => ({
    id: call.toolCallId,
    name: call.toolName,
    args: isRecord(call.input) ? call.input : {},
  }));
}
```

Create `packages/models/src/seat.ts`

```ts
import { z } from 'zod';

/** An OpenAI-compatible server: LM Studio, llama.cpp `llama-server`, mlx_lm.server, vLLM, Ollama. */
export const Endpoint = z.object({
  /** Base URL including the `/v1` path, e.g. `http://192.168.1.20:1234/v1`. */
  baseURL: z.url(),
  apiKey: z.string().min(1).optional(),
});
export type Endpoint = z.infer<typeof Endpoint>;

export const ModelTarget = z.object({
  endpoint: Endpoint,
  model: z.string().min(1),
});
export type ModelTarget = z.infer<typeof ModelTarget>;

/** One seat's model: where to call, how, and what to fall back to when that endpoint fails. */
export const SeatConfig = ModelTarget.extend({
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** Per-call timeout, including every fallback attempt's own call. Default 120 s. */
  timeoutMs: z.number().int().positive().default(120_000),
  /**
   * Overrides the engine's requested tool choice. The engine asks for "required", and a reply
   * without a tool call then counts as a failed attempt (fallback, retry, pause). Set "auto" for a
   * server that ignores "required", so a text-only reply is used as narration or speech instead.
   */
  toolChoice: z.enum(['auto', 'required']).optional(),
  /** Tried in order when the primary target fails. */
  fallbacks: z.array(ModelTarget).default([]),
});
export type SeatConfig = z.output<typeof SeatConfig>;
export type SeatConfigInput = z.input<typeof SeatConfig>;
```

Create `packages/models/src/testing.ts`

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/** The subset of an OpenAI chat completion request the tests inspect. */
export interface ChatCompletionRequest {
  model: string;
  messages: {
    role: string;
    content?: unknown;
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
  }[];
  tools?: {
    type: 'function';
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
}

export interface FakeToolCall {
  id?: string;
  name: string;
  /** A JSON string exactly as the server should send it, or an object to stringify. */
  arguments: string | Record<string, unknown>;
}

export interface FakeReply {
  text?: string;
  toolCalls?: FakeToolCall[];
  /** A non-200 status makes the server answer with an OpenAI-style error body. */
  status?: number;
  delayMs?: number;
  completionTokens?: number;
}

export interface FakeOpenAIServer {
  /** Includes `/v1`. */
  baseURL: string;
  requests: ChatCompletionRequest[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

/**
 * A local OpenAI-compatible chat completions server for tests. `reply` receives each request and
 * its zero-based index and decides the response; `GET /v1/models` lists `models`.
 */
export async function startFakeOpenAIServer(
  reply: (request: ChatCompletionRequest, index: number) => FakeReply | Promise<FakeReply>,
  options: { models?: string[] } = {}
): Promise<FakeOpenAIServer> {
  const requests: ChatCompletionRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        sendJson(response, 200, {
          object: 'list',
          data: (options.models ?? []).map((id) => ({ id, object: 'model' })),
        });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        sendJson(response, 404, { error: { message: `No route for ${request.url}` } });
        return;
      }
      const body = JSON.parse(await readBody(request)) as ChatCompletionRequest;
      const index = requests.push(body) - 1;
      const planned = await reply(body, index);
      if (planned.delayMs) await new Promise((resolve) => setTimeout(resolve, planned.delayMs));
      if (planned.status && planned.status !== 200) {
        sendJson(response, planned.status, {
          error: { message: `fake failure ${planned.status}` },
        });
        return;
      }
      const toolCalls = (planned.toolCalls ?? []).map((call, position) => ({
        id: call.id ?? `call_${index}_${position}`,
        type: 'function',
        function: {
          name: call.name,
          arguments:
            typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
        },
      }));
      sendJson(response, 200, {
        id: `chatcmpl-${index}`,
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
            message: {
              role: 'assistant',
              content: planned.text ?? null,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: planned.completionTokens ?? 5,
          total_tokens: 10 + (planned.completionTokens ?? 5),
        },
      });
    })().catch((error: unknown) => {
      sendJson(response, 500, { error: { message: String(error) } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake server has no port');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/models/test/client.test.ts packages/models/test/messages.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 6: Typecheck, run the full suite, and check formatting**

Run: `npm run typecheck && npm test && npm run format:check`
Expected: no type errors, every test passes, and Prettier reports all files formatted.

- [ ] **Step 7: Commit**

```bash
git add package-lock.json \
  packages/models/package.json \
  packages/models/src/client.ts \
  packages/models/src/index.ts \
  packages/models/src/messages.ts \
  packages/models/src/seat.ts \
  packages/models/src/testing.ts \
  packages/models/test/client.test.ts \
  packages/models/test/messages.test.ts
git commit -m "feat(models): add an OpenAI-compatible model client with seat fallbacks"
```

### Task 6: Benchmark a seat

Measure each seat the way a session uses it: whether the server answers and lists the model, generation speed, and tool-call reliability over repeated trials.

**Files:**

- Create: `packages/models/src/bench.ts`
- Modify: `packages/models/src/index.ts`
- Test (create): `packages/models/test/bench.test.ts`

**Interfaces:**

- `benchSeat(seatId, seat: SeatConfigInput, { trials?, now? }): Promise<BenchResult>` (`reachable`, `modelListed`, `latencyMs`, `outputTokens`, `tokensPerSecond`, `toolCallTrials`, `toolCallSuccesses`, `errors`)

- [ ] **Step 1: Write the failing tests**

Create `packages/models/test/bench.test.ts`

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { benchSeat } from '../src/bench';
import { startFakeOpenAIServer, type FakeOpenAIServer, type FakeReply } from '../src/testing';

const servers: FakeOpenAIServer[] = [];
async function server(...args: Parameters<typeof startFakeOpenAIServer>) {
  const started = await startFakeOpenAIServer(...args);
  servers.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((started) => started.close()));
});

/** A clock that returns each value in turn. */
function clock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

describe('benchSeat', () => {
  it('reports reachability, model listing, and generation speed', async () => {
    const fake = await server(
      (_body, index) =>
        index === 0
          ? { text: 'A corridor.', completionTokens: 40 }
          : { toolCalls: [{ name: 'roll_dice', arguments: { dice: '1d20+3', reason: 'test' } }] },
      { models: ['qwen-dm', 'other'] }
    );

    const result = await benchSeat(
      'dm',
      { endpoint: { baseURL: fake.baseURL }, model: 'qwen-dm' },
      { trials: 1, now: clock(1000, 1500) }
    );

    expect(result).toMatchObject({
      seat: 'dm',
      model: 'qwen-dm',
      baseURL: fake.baseURL,
      reachable: true,
      modelListed: true,
      latencyMs: 500,
      outputTokens: 40,
      tokensPerSecond: 80,
      toolCallTrials: 1,
      toolCallSuccesses: 1,
      errors: [],
    });
  });

  it('counts only well-formed calls to the test tool as successes', async () => {
    const trials: FakeReply[] = [
      { toolCalls: [{ name: 'roll_dice', arguments: { dice: '1d20+3', reason: 'ok' } }] },
      { toolCalls: [{ name: 'roll_dice', arguments: { dice: '2d6', reason: 'wrong dice' } }] },
      { toolCalls: [{ name: 'roll_dice', arguments: '{not json' }] },
      { toolCalls: [{ name: 'narrate', arguments: { text: 'wrong tool' } }] },
      { text: 'No tool at all.' },
      { toolCalls: [{ name: 'roll_dice', arguments: { dice: '1d20+3', reason: 'ok again' } }] },
    ];
    const fake = await server((_body, index) =>
      index === 0 ? { text: 'A corridor.' } : trials[index - 1]!
    );

    const result = await benchSeat(
      'player-kira',
      { endpoint: { baseURL: fake.baseURL }, model: 'gemma' },
      { trials: trials.length }
    );

    expect(result.toolCallTrials).toBe(6);
    expect(result.toolCallSuccesses).toBe(2);
    expect(result.errors).toEqual([expect.stringContaining('tool trial 5 failed')]);
    expect(fake.requests.slice(1).every((request) => request.tool_choice === 'required')).toBe(
      true
    );
  });

  it('flags a model the server does not list', async () => {
    const fake = await server(() => ({ text: 'ok' }), { models: ['something-else'] });
    const result = await benchSeat(
      'dm',
      { endpoint: { baseURL: fake.baseURL }, model: 'missing-model', toolChoice: 'auto' },
      { trials: 0 }
    );
    expect(result.modelListed).toBe(false);
  });

  it('reports an unreachable endpoint without throwing', async () => {
    const fake = await server(() => ({ text: 'never used' }));
    const baseURL = fake.baseURL;
    await fake.close();
    servers.splice(servers.indexOf(fake), 1);

    const result = await benchSeat('dm', { endpoint: { baseURL }, model: 'm' }, { trials: 1 });

    expect(result).toMatchObject({
      reachable: false,
      modelListed: null,
      latencyMs: null,
      tokensPerSecond: null,
      toolCallSuccesses: 0,
    });
    expect(result.errors).toEqual([
      expect.stringContaining('GET /models failed'),
      expect.stringContaining('speed test failed'),
      expect.stringContaining('tool trial 1 failed'),
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/models/test/bench.test.ts`
Expected: FAIL — the tests cannot import `../src/bench`.

- [ ] **Step 3: Write the implementation**

Create `packages/models/src/bench.ts`

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, tool } from 'ai';
import { SeatConfig, type SeatConfigInput } from './seat';

export interface BenchResult {
  seat: string;
  model: string;
  baseURL: string;
  /** Whether the server answered at all (its model list or a completion). */
  reachable: boolean;
  /** Whether the server's model list includes the configured model; null if the list was unreadable. */
  modelListed: boolean | null;
  latencyMs: number | null;
  outputTokens: number | null;
  tokensPerSecond: number | null;
  toolCallTrials: number;
  /** Trials where the model called the test tool exactly as asked. */
  toolCallSuccesses: number;
  errors: string[];
}

export interface BenchOptions {
  /** Tool-call trials to run. Default 5. */
  trials?: number;
  /** Milliseconds clock, injectable for tests. */
  now?: () => number;
}

const SPEED_PROMPT = 'Describe a torch-lit dungeon corridor in about sixty words.';
const EXPECTED_DICE = '1d20+3';
const MAX_ERRORS = 10;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks one seat's endpoint the way a session will use it: reachability and model listing,
 * generation speed, and how reliably the model makes a well-formed tool call.
 */
export async function benchSeat(
  seatId: string,
  input: SeatConfigInput,
  options: BenchOptions = {}
): Promise<BenchResult> {
  const seat = SeatConfig.parse(input);
  const now = options.now ?? (() => performance.now());
  const trials = options.trials ?? 5;
  const result: BenchResult = {
    seat: seatId,
    model: seat.model,
    baseURL: seat.endpoint.baseURL,
    reachable: false,
    modelListed: null,
    latencyMs: null,
    outputTokens: null,
    tokensPerSecond: null,
    toolCallTrials: trials,
    toolCallSuccesses: 0,
    errors: [],
  };
  const addError = (message: string) => {
    if (result.errors.length < MAX_ERRORS) result.errors.push(message);
  };

  try {
    const response = await fetch(`${seat.endpoint.baseURL}/models`, {
      headers: seat.endpoint.apiKey ? { authorization: `Bearer ${seat.endpoint.apiKey}` } : {},
      signal: AbortSignal.timeout(seat.timeoutMs),
    });
    result.reachable = response.ok;
    if (response.ok) {
      const body = (await response.json()) as { data?: { id?: unknown }[] };
      result.modelListed = Array.isArray(body.data)
        ? body.data.some((entry) => entry.id === seat.model)
        : null;
    } else {
      addError(`GET /models returned ${response.status}`);
    }
  } catch (error) {
    addError(`GET /models failed: ${errorMessage(error)}`);
  }

  const model = createOpenAICompatible({
    name: 'cartyx-sim-bench',
    baseURL: seat.endpoint.baseURL,
    apiKey: seat.endpoint.apiKey,
  }).chatModel(seat.model);

  try {
    const started = now();
    const speed = await generateText({
      model,
      prompt: SPEED_PROMPT,
      temperature: seat.temperature,
      maxOutputTokens: seat.maxOutputTokens,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(seat.timeoutMs),
    });
    const elapsedMs = now() - started;
    result.reachable = true;
    result.latencyMs = Math.round(elapsedMs);
    result.outputTokens = speed.usage.outputTokens ?? null;
    if (result.outputTokens !== null && elapsedMs > 0) {
      result.tokensPerSecond = Math.round((result.outputTokens / (elapsedMs / 1000)) * 10) / 10;
    }
  } catch (error) {
    addError(`speed test failed: ${errorMessage(error)}`);
  }

  const rollDice = tool({
    description: 'Roll dice for the table.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { dice: { type: 'string' }, reason: { type: 'string' } },
      required: ['dice', 'reason'],
      additionalProperties: false,
    }),
  });
  for (let trial = 1; trial <= trials; trial++) {
    try {
      const reply = await generateText({
        model,
        instructions: 'You are testing a game engine. Always respond by calling a tool.',
        prompt: `Call roll_dice exactly once with dice "${EXPECTED_DICE}" and a short reason.`,
        tools: { roll_dice: rollDice },
        toolChoice: seat.toolChoice ?? 'required',
        temperature: seat.temperature,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(seat.timeoutMs),
      });
      const call = reply.toolCalls[0];
      const invalid = (call as { invalid?: boolean } | undefined)?.invalid === true;
      const dice = (call?.input as { dice?: unknown } | undefined)?.dice;
      if (call && !invalid && call.toolName === 'roll_dice' && dice === EXPECTED_DICE) {
        result.toolCallSuccesses++;
      }
    } catch (error) {
      addError(`tool trial ${trial} failed: ${errorMessage(error)}`);
    }
  }
  return result;
}
```

Modify `packages/models/src/index.ts`

```diff
diff --git a/packages/models/src/index.ts b/packages/models/src/index.ts
index ee22c08..8b4cc56 100644
--- a/packages/models/src/index.ts
+++ b/packages/models/src/index.ts
@@ -1,3 +1,4 @@
+export * from './bench';
 export * from './client';
 export * from './messages';
 export * from './seat';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/models/test/bench.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Typecheck, run the full suite, and check formatting**

Run: `npm run typecheck && npm test && npm run format:check`
Expected: no type errors, every test passes, and Prettier reports all files formatted.

- [ ] **Step 6: Commit**

```bash
git add packages/models/src/bench.ts \
  packages/models/src/index.ts \
  packages/models/test/bench.test.ts
git commit -m "feat(models): benchmark a seat's reachability, speed, and tool-call reliability"
```

### Task 7: Campaign config

Load `campaigns/<id>/campaign.yaml` (endpoints, seats, fallbacks) and `characters/*.yaml` (the party), validating that every seat names a defined endpoint and matches a party member. Ship an example campaign.

**Files:**

- Create: `apps/cli/examples/local-campaign/campaign.yaml`
- Create: `apps/cli/examples/local-campaign/characters/kira.yaml`
- Create: `apps/cli/examples/local-campaign/characters/tomas.yaml`
- Modify: `apps/cli/package.json`
- Create: `apps/cli/src/campaign.ts`
- Modify: `apps/cli/src/paths.ts`
- Test (create): `apps/cli/test/campaign.test.ts`
- Modify: `package-lock.json` (by `npm install`)

**Interfaces:**

- `loadCampaign(campaignsDir, id): Promise<Campaign>` (`name`, `targetMinutes`, `loreCommit`, `party`, `seats` for the director, `models` per seat id)
- `DM_SEAT` (`"dm"`), `playerSeat(pcId)` (`"player-<pcId>"`), `CampaignFile` schema
- `campaignDir(campaignsDir, id)` in `paths.ts`
- `apps/cli/examples/local-campaign/`

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/test/campaign.test.ts`

```ts
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign';

const EXAMPLE = fileURLToPath(new URL('../examples/local-campaign', import.meta.url));

const KIRA = `id: kira
name: Kira Vale
kind: pc
level: 3
abilities: { str: 10, dex: 14, con: 12, int: 16, wis: 12, cha: 10 }
proficiencyBonus: 2
ac: 15
maxHp: 24
hp: 24
`;

const CONFIG = `name: Test
targetMinutes: 30
endpoints:
  studio: { baseURL: http://10.0.0.2:1234/v1 }
  ampere: { baseURL: http://10.0.0.3:8080/v1, apiKey: secret }
seats:
  dm: { endpoint: studio, model: big-dm, fallbacks: [{ endpoint: ampere, model: backup-dm }] }
  players:
    kira: { endpoint: ampere, model: player-model, toolChoice: auto }
`;

describe('loadCampaign', () => {
  let campaignsDir: string;

  beforeEach(async () => {
    campaignsDir = await mkdtemp(join(tmpdir(), 'cartyx-sim-campaign-'));
  });

  afterEach(async () => {
    await rm(campaignsDir, { recursive: true, force: true });
  });

  async function writeCampaign(config: string, characters: Record<string, string>) {
    const dir = join(campaignsDir, 'test');
    await mkdir(join(dir, 'characters'), { recursive: true });
    await writeFile(join(dir, 'campaign.yaml'), config);
    for (const [file, text] of Object.entries(characters)) {
      await writeFile(join(dir, 'characters', file), text);
    }
  }

  it('loads the shipped example campaign', async () => {
    await cp(EXAMPLE, join(campaignsDir, 'local-campaign'), { recursive: true });
    const campaign = await loadCampaign(campaignsDir, 'local-campaign');
    expect(campaign.party.map((pc) => pc.id)).toEqual(['kira', 'tomas']);
    expect(campaign.seats).toEqual({
      dm: 'dm',
      players: { kira: 'player-kira', tomas: 'player-tomas' },
    });
    expect(campaign.models.dm).toMatchObject({
      endpoint: { baseURL: 'http://127.0.0.1:1234/v1' },
    });
    expect(campaign.loreCommit).toBe('unversioned');
  });

  it('resolves endpoints, fallbacks, and seat options', async () => {
    await writeCampaign(CONFIG, { 'kira.yaml': KIRA });
    const campaign = await loadCampaign(campaignsDir, 'test');
    expect(campaign).toMatchObject({ name: 'Test', targetMinutes: 30 });
    expect(campaign.models).toEqual({
      dm: {
        endpoint: { baseURL: 'http://10.0.0.2:1234/v1' },
        model: 'big-dm',
        fallbacks: [
          {
            endpoint: { baseURL: 'http://10.0.0.3:8080/v1', apiKey: 'secret' },
            model: 'backup-dm',
          },
        ],
      },
      'player-kira': {
        endpoint: { baseURL: 'http://10.0.0.3:8080/v1', apiKey: 'secret' },
        model: 'player-model',
        toolChoice: 'auto',
        fallbacks: [],
      },
    });
  });

  it('names an unknown endpoint and where it is used', async () => {
    await writeCampaign(
      CONFIG.replace('fallbacks: [{ endpoint: ampere', 'fallbacks: [{ endpoint: nowhere'),
      {
        'kira.yaml': KIRA,
      }
    );
    await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow(
      'seats.dm fallback 1 uses unknown endpoint "nowhere". Defined endpoints: studio, ampere'
    );
  });

  it('requires a seat for every party member and no extra seats', async () => {
    await writeCampaign(CONFIG, {
      'kira.yaml': KIRA,
      'tomas.yaml': KIRA.replace('id: kira', 'id: tomas'),
    });
    await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow(
      'no seat under seats.players for tomas'
    );

    await writeCampaign(
      CONFIG.replace('    kira:', '    kira2: { endpoint: studio, model: m }\n    kira:'),
      {
        'kira.yaml': KIRA,
      }
    );
    await rm(join(campaignsDir, 'test', 'characters', 'tomas.yaml'));
    await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow(
      'seats.players lists kira2, who is not in characters/'
    );
  });

  it('reports an invalid character file by path', async () => {
    await writeCampaign(CONFIG, { 'kira.yaml': KIRA.replace('ac: 15', 'ac: nope') });
    await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow(
      `${join(campaignsDir, 'test', 'characters', 'kira.yaml')}: invalid character`
    );
  });

  it('only accepts player characters in the party', async () => {
    await writeCampaign(CONFIG, { 'kira.yaml': KIRA.replace('kind: pc', 'kind: npc') });
    await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow(
      'party members must have kind "pc", not "npc"'
    );
  });

  it('explains a missing campaign.yaml', async () => {
    await expect(loadCampaign(campaignsDir, 'absent')).rejects.toThrow(
      'campaign.yaml not found. Create it (see apps/cli/examples/local-campaign).'
    );
  });

  it('rejects an unsafe campaign id', async () => {
    await expect(loadCampaign(campaignsDir, '../escape')).rejects.toThrow(
      'must be lowercase letters, digits, and dashes'
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/test/campaign.test.ts`
Expected: FAIL — the tests cannot import `../src/campaign`.

- [ ] **Step 3: Add the package manifest and install**

Modify `apps/cli/package.json`

```diff
diff --git a/apps/cli/package.json b/apps/cli/package.json
index ebfd0a1..8bbc61c 100644
--- a/apps/cli/package.json
+++ b/apps/cli/package.json
@@ -5,8 +5,10 @@
   "type": "module",
   "dependencies": {
     "@cartyx-sim/core": "*",
+    "@cartyx-sim/models": "*",
     "@cartyx-sim/rules": "*",
     "commander": "^15.0.0",
+    "yaml": "^2.9.1",
     "zod": "^4.6.4"
   }
 }
```

Run: `npm install`
Expected: install completes and links the workspace packages.

- [ ] **Step 4: Write the implementation**

Create `apps/cli/examples/local-campaign/campaign.yaml`

```yaml
# An example campaign for `npm run sim -- bench --campaign local-campaign` and
# `npm run sim -- run --campaign local-campaign`.
#
# Copy this folder into your campaigns directory (default: ./campaigns), then point the
# endpoints at your model servers. Use the exact model ids each server lists; `sim bench`
# reports whether the configured model is listed.
name: Local test campaign
targetMinutes: 5
loreCommit: unversioned

endpoints:
  # LM Studio's server listens on port 1234 by default.
  macbook:
    baseURL: http://127.0.0.1:1234/v1

seats:
  dm:
    endpoint: macbook
    model: qwen3.5-122b-a10b
    temperature: 0.8
    maxOutputTokens: 800
  players:
    kira:
      endpoint: macbook
      model: gemma-4-26b-a4b
      temperature: 0.9
      maxOutputTokens: 400
    tomas:
      endpoint: macbook
      model: gemma-4-26b-a4b
      temperature: 0.9
      maxOutputTokens: 400
```

Create `apps/cli/examples/local-campaign/characters/kira.yaml`

```yaml
# Placeholder party member until `sim chargen` (Plan 2C) drafts real characters from the lore.
id: kira
name: Kira Vale
kind: pc
level: 3
abilities: { str: 10, dex: 14, con: 12, int: 16, wis: 12, cha: 10 }
proficiencyBonus: 2
saveProficiencies: [con, int]
skillProficiencies: [arcana, investigation]
ac: 15
maxHp: 24
hp: 24
spellSlots:
  - { level: 1, max: 3, used: 0 }
attacks:
  - { name: Light Hammer, bonus: 5, damage: 1d4+3, damageType: bludgeoning }
inventory:
  - { name: Healing Potion, quantity: 1 }
```

Create `apps/cli/examples/local-campaign/characters/tomas.yaml`

```yaml
# Placeholder party member until `sim chargen` (Plan 2C) drafts real characters from the lore.
id: tomas
name: Tomas Reed
kind: pc
level: 3
abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 12 }
proficiencyBonus: 2
saveProficiencies: [str, con]
skillProficiencies: [athletics, intimidation]
ac: 16
maxHp: 28
hp: 28
attacks:
  - { name: Longsword, bonus: 5, damage: 1d8+3, damageType: slashing }
```

Create `apps/cli/src/campaign.ts`

```ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Endpoint, type SeatConfigInput } from '@cartyx-sim/models';
import { Combatant } from '@cartyx-sim/rules';
import YAML from 'yaml';
import { z } from 'zod';
import { campaignDir } from './paths';

const SeatRef = z.object({
  /** Name of an entry under `endpoints`. */
  endpoint: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  toolChoice: z.enum(['auto', 'required']).optional(),
  fallbacks: z
    .array(z.object({ endpoint: z.string().min(1), model: z.string().min(1) }))
    .default([]),
});
type SeatRef = z.output<typeof SeatRef>;

/** `campaigns/<id>/campaign.yaml`. */
export const CampaignFile = z.object({
  name: z.string().min(1),
  targetMinutes: z.number().positive(),
  /** The lore version the campaign plays against. Plan 2B sets this from the lore repository. */
  loreCommit: z.string().min(1).default('unversioned'),
  endpoints: z.record(z.string(), Endpoint),
  seats: z.object({
    dm: SeatRef,
    /** Keyed by party member id. */
    players: z.record(z.string(), SeatRef),
  }),
});

export const DM_SEAT = 'dm';

export function playerSeat(pcId: string): string {
  return `player-${pcId}`;
}

export interface Campaign {
  id: string;
  dir: string;
  name: string;
  targetMinutes: number;
  loreCommit: string;
  party: Combatant[];
  /** Seat ids for the director. */
  seats: { dm: string; players: Record<string, string> };
  /** Model configuration per seat id, for the model client and `sim bench`. */
  models: Record<string, SeatConfigInput>;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readYaml(path: string, missing: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) throw new Error(missing);
    throw error;
  }
  try {
    return YAML.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid YAML (${error instanceof Error ? error.message : error})`);
  }
}

async function loadParty(dir: string): Promise<Combatant[]> {
  const charactersDir = join(dir, 'characters');
  let files: string[];
  try {
    files = (await readdir(charactersDir)).filter((file) => /\.ya?ml$/.test(file)).sort();
  } catch (error) {
    if (isNotFound(error)) files = [];
    else throw error;
  }
  if (files.length === 0) {
    throw new Error(`${charactersDir}: no character files. Add one <id>.yaml per party member.`);
  }
  const party: Combatant[] = [];
  for (const file of files) {
    const path = join(charactersDir, file);
    const parsed = Combatant.safeParse(await readYaml(path, `${path} is missing`));
    if (!parsed.success) {
      throw new Error(`${path}: invalid character\n${z.prettifyError(parsed.error)}`);
    }
    if (parsed.data.kind !== 'pc') {
      throw new Error(`${path}: party members must have kind "pc", not "${parsed.data.kind}"`);
    }
    if (party.some((pc) => pc.id === parsed.data.id)) {
      throw new Error(`${path}: duplicate party member id "${parsed.data.id}"`);
    }
    party.push(parsed.data);
  }
  return party;
}

/** Loads and validates a campaign folder: its config, its party, and every seat's endpoints. */
export async function loadCampaign(campaignsDir: string, campaignId: string): Promise<Campaign> {
  const dir = campaignDir(campaignsDir, campaignId);
  const configPath = join(dir, 'campaign.yaml');
  const raw = await readYaml(
    configPath,
    `${configPath} not found. Create it (see apps/cli/examples/local-campaign).`
  );
  const parsed = CampaignFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${configPath}: invalid campaign\n${z.prettifyError(parsed.error)}`);
  }
  const file = parsed.data;
  const party = await loadParty(dir);

  const endpoint = (name: string, where: string) => {
    if (!Object.hasOwn(file.endpoints, name)) {
      const known = Object.keys(file.endpoints).join(', ') || 'none';
      throw new Error(
        `${configPath}: ${where} uses unknown endpoint "${name}". Defined endpoints: ${known}`
      );
    }
    return file.endpoints[name]!;
  };
  const resolve = (ref: SeatRef, where: string): SeatConfigInput => ({
    endpoint: endpoint(ref.endpoint, where),
    model: ref.model,
    temperature: ref.temperature,
    maxOutputTokens: ref.maxOutputTokens,
    timeoutMs: ref.timeoutMs,
    toolChoice: ref.toolChoice,
    fallbacks: ref.fallbacks.map((fallback, index) => ({
      endpoint: endpoint(fallback.endpoint, `${where} fallback ${index + 1}`),
      model: fallback.model,
    })),
  });

  const partyIds = party.map((pc) => pc.id);
  const seatedIds = Object.keys(file.seats.players);
  const unseated = partyIds.filter((id) => !seatedIds.includes(id));
  if (unseated.length > 0) {
    throw new Error(`${configPath}: no seat under seats.players for ${unseated.join(', ')}`);
  }
  const strangers = seatedIds.filter((id) => !partyIds.includes(id));
  if (strangers.length > 0) {
    throw new Error(
      `${configPath}: seats.players lists ${strangers.join(', ')}, who ` +
        `${strangers.length === 1 ? 'is' : 'are'} not in characters/. Party: ${partyIds.join(', ')}`
    );
  }

  const models: Record<string, SeatConfigInput> = {
    [DM_SEAT]: resolve(file.seats.dm, 'seats.dm'),
  };
  const players: Record<string, string> = {};
  for (const pc of party) {
    const seat = playerSeat(pc.id);
    players[pc.id] = seat;
    models[seat] = resolve(file.seats.players[pc.id]!, `seats.players.${pc.id}`);
  }
  return {
    id: campaignId,
    dir,
    name: file.name,
    targetMinutes: file.targetMinutes,
    loreCommit: file.loreCommit,
    party,
    seats: { dm: DM_SEAT, players },
    models,
  };
}
```

Modify `apps/cli/src/paths.ts`

```diff
diff --git a/apps/cli/src/paths.ts b/apps/cli/src/paths.ts
index 8ac913e..55499bf 100644
--- a/apps/cli/src/paths.ts
+++ b/apps/cli/src/paths.ts
@@ -2,14 +2,19 @@ import { join } from 'node:path';

 const CAMPAIGN_ID = /^[a-z0-9][a-z0-9-]*$/;

-export function sessionDir(campaignsDir: string, campaign: string, session: number): string {
+export function campaignDir(campaignsDir: string, campaign: string): string {
   if (!CAMPAIGN_ID.test(campaign)) {
     throw new Error(`Campaign id "${campaign}" must be lowercase letters, digits, and dashes`);
   }
+  return join(campaignsDir, campaign);
+}
+
+export function sessionDir(campaignsDir: string, campaign: string, session: number): string {
+  const dir = campaignDir(campaignsDir, campaign);
   if (!Number.isSafeInteger(session) || session < 1) {
     throw new Error(`Session number must be a positive integer, got ${session}`);
   }
-  return join(campaignsDir, campaign, 'sessions', String(session).padStart(3, '0'));
+  return join(dir, 'sessions', String(session).padStart(3, '0'));
 }

 export function sessionEventsPath(campaignsDir: string, campaign: string, session: number): string {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/test/campaign.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 6: Typecheck, run the full suite, and check formatting**

Run: `npm run typecheck && npm test && npm run format:check`
Expected: no type errors, every test passes, and Prettier reports all files formatted.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/examples/local-campaign/campaign.yaml \
  apps/cli/examples/local-campaign/characters/kira.yaml \
  apps/cli/examples/local-campaign/characters/tomas.yaml \
  apps/cli/package.json \
  apps/cli/src/campaign.ts \
  apps/cli/src/paths.ts \
  apps/cli/test/campaign.test.ts \
  package-lock.json
git commit -m "feat(cli): load campaign config with seats, endpoints, and party files"
```

### Task 8: `sim run` against campaign seats, and `sim bench`

Play a session against the models configured in a campaign (with `--fixture` still available for scripted runs), and add `sim bench` to check every seat before a session.

**Files:**

- Create: `apps/cli/src/bench.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/run.ts`
- Test (create): `apps/cli/test/bench.test.ts`
- Test (create): `apps/cli/test/run-campaign.test.ts`

**Interfaces:**

- `RunOptions.fixturePath` is optional; without it `runSession` loads the campaign and uses `OpenAICompatibleModelClient` with an empty lore index (Plan 2B adds lore)
- `runBench({ campaignsDir, campaign, trials?, now?, log? }): Promise<{ results, reportPath }>`, `formatBenchTable(results)`, `benchPassed(results)`
- `npm run sim -- run --campaign <id> [--fixture <path>] ...` and `npm run sim -- bench --campaign <id> [--trials N]`

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/test/bench.test.ts`

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BenchResult } from '@cartyx-sim/models';
import { startFakeOpenAIServer, type FakeOpenAIServer } from '@cartyx-sim/models/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { benchPassed, formatBenchTable, runBench } from '../src/bench';

const KIRA = `id: kira
name: Kira Vale
kind: pc
level: 3
abilities: { str: 10, dex: 14, con: 12, int: 16, wis: 12, cha: 10 }
proficiencyBonus: 2
ac: 15
maxHp: 24
hp: 24
`;

describe('runBench', () => {
  let campaignsDir: string;
  let fake: FakeOpenAIServer;

  beforeEach(async () => {
    campaignsDir = await mkdtemp(join(tmpdir(), 'cartyx-sim-bench-'));
    fake = await startFakeOpenAIServer(
      (body) =>
        (body.tools ?? []).some((entry) => entry.function.name === 'roll_dice')
          ? {
              toolCalls: [{ name: 'roll_dice', arguments: { dice: '1d20+3', reason: 'bench' } }],
            }
          : { text: 'A corridor.', completionTokens: 20 },
      { models: ['dm-model', 'player-model'] }
    );
    const dir = join(campaignsDir, 'live');
    await mkdir(join(dir, 'characters'), { recursive: true });
    await writeFile(
      join(dir, 'campaign.yaml'),
      `name: Bench
targetMinutes: 30
endpoints:
  local: { baseURL: ${fake.baseURL} }
seats:
  dm: { endpoint: local, model: dm-model }
  players:
    kira: { endpoint: local, model: player-model }
`
    );
    await writeFile(join(dir, 'characters', 'kira.yaml'), KIRA);
  });

  afterEach(async () => {
    await fake.close();
    await rm(campaignsDir, { recursive: true, force: true });
  });

  it('benchmarks every seat, prints a table, and saves a report', async () => {
    const lines: string[] = [];
    const report = await runBench({
      campaignsDir,
      campaign: 'live',
      trials: 2,
      now: () => new Date('2026-09-13T12:00:00.000Z'),
      log: (line) => lines.push(line),
    });

    expect(report.results.map((result) => [result.seat, result.toolCallSuccesses])).toEqual([
      ['dm', 2],
      ['player-kira', 2],
    ]);
    expect(benchPassed(report.results)).toBe(true);
    expect(report.reportPath).toBe(
      join(campaignsDir, 'live', 'bench', '2026-09-13T12-00-00-000Z.json')
    );
    const saved = JSON.parse(await readFile(report.reportPath, 'utf8')) as {
      campaign: string;
      results: BenchResult[];
    };
    expect(saved).toMatchObject({ campaign: 'live', createdAt: '2026-09-13T12:00:00.000Z' });
    expect(saved.results).toHaveLength(2);
    expect(lines.some((line) => line.startsWith('seat') && line.includes('tool calls'))).toBe(true);
  });
});

describe('formatBenchTable', () => {
  it('aligns columns and lists each seat’s errors under the table', () => {
    const results: BenchResult[] = [
      {
        seat: 'dm',
        model: 'qwen',
        baseURL: 'http://a/v1',
        reachable: true,
        modelListed: true,
        latencyMs: 812,
        outputTokens: 60,
        tokensPerSecond: 73.9,
        toolCallTrials: 5,
        toolCallSuccesses: 5,
        errors: [],
      },
      {
        seat: 'player-kira',
        model: 'gemma',
        baseURL: 'http://b/v1',
        reachable: false,
        modelListed: null,
        latencyMs: null,
        outputTokens: null,
        tokensPerSecond: null,
        toolCallTrials: 5,
        toolCallSuccesses: 0,
        errors: ['GET /models failed: connect ECONNREFUSED'],
      },
    ];
    expect(formatBenchTable(results)).toEqual([
      'seat         model  reachable  listed  tok/s  latency ms  tool calls',
      'dm           qwen   yes        yes     73.9   812         5/5',
      'player-kira  gemma  NO         ?       -      -           0/5',
      '  player-kira: GET /models failed: connect ECONNREFUSED',
    ]);
    expect(benchPassed(results)).toBe(false);
  });
});
```

Create `apps/cli/test/run-campaign.test.ts`

```ts
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeOpenAIServer, type FakeOpenAIServer } from '@cartyx-sim/models/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFileSink } from '../src/jsonl-sink';
import { runSession } from '../src/run';

const KIRA = `id: kira
name: Kira Vale
kind: pc
level: 3
abilities: { str: 10, dex: 14, con: 12, int: 16, wis: 12, cha: 10 }
proficiencyBonus: 2
ac: 15
maxHp: 24
hp: 24
`;

function campaignYaml(baseURL: string): string {
  return `name: Live test
targetMinutes: 0.12
endpoints:
  local: { baseURL: ${baseURL} }
seats:
  dm: { endpoint: local, model: dm-model, temperature: 0.7 }
  players:
    kira: { endpoint: local, model: player-model }
`;
}

describe('runSession with campaign model seats', () => {
  let campaignsDir: string;
  let fake: FakeOpenAIServer;

  beforeEach(async () => {
    campaignsDir = await mkdtemp(join(tmpdir(), 'cartyx-sim-live-'));
    let dmCalls = 0;
    fake = await startFakeOpenAIServer((body) => {
      const tools = (body.tools ?? []).map((entry) => entry.function.name);
      if (tools.includes('speak')) {
        return { toolCalls: [{ name: 'speak', arguments: { text: 'Who turned off the wards?' } }] };
      }
      dmCalls++;
      return dmCalls === 1
        ? {
            toolCalls: [
              {
                name: 'scene_change',
                arguments: { location: 'Crystal Engine Lab', artPrompt: 'A humming lab' },
              },
              { name: 'narrate', arguments: { text: 'The lab lights flicker as you arrive.' } },
              { name: 'hand_off', arguments: { target: { kind: 'open' } } },
            ],
          }
        : {
            toolCalls: [
              {
                name: 'narrate',
                arguments: { text: 'A shadow slips out the east door, leaving frost behind.' },
              },
              {
                name: 'scene_change',
                arguments: { location: 'East Corridor', artPrompt: 'A frosted corridor' },
              },
              { name: 'hand_off', arguments: { target: { kind: 'party' } } },
            ],
          };
    });
    const dir = join(campaignsDir, 'live');
    await mkdir(join(dir, 'characters'), { recursive: true });
    await writeFile(join(dir, 'campaign.yaml'), campaignYaml(fake.baseURL));
    await writeFile(join(dir, 'characters', 'kira.yaml'), KIRA);
  });

  afterEach(async () => {
    await fake.close();
    await rm(campaignsDir, { recursive: true, force: true });
  });

  it('plays a session against the configured OpenAI-compatible endpoints', async () => {
    const lines: string[] = [];
    const result = await runSession({
      campaignsDir,
      campaign: 'live',
      session: 1,
      resume: false,
      log: (line) => lines.push(line),
    });

    expect(result.status).toBe('ended');
    const events = await new JsonlFileSink(result.eventsPath).readAll();
    expect(events.map((event) => event.type)).toEqual([
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
    expect(lines).toContain('Kira Vale: "Who turned off the wards?"');
    expect(fake.requests.map((request) => request.model)).toEqual([
      'dm-model',
      'player-model',
      'dm-model',
    ]);
    expect(fake.requests[0]).toMatchObject({ temperature: 0.7, tool_choice: 'required' });
    await expect(stat(`${result.eventsPath}.lock`)).rejects.toThrow();
  });

  it('rejects an invalid campaign before creating a lock or log', async () => {
    await writeFile(join(campaignsDir, 'live', 'campaign.yaml'), 'name: Broken\n');
    await expect(
      runSession({ campaignsDir, campaign: 'live', session: 1, resume: false })
    ).rejects.toThrow('invalid campaign');
    await expect(stat(join(campaignsDir, 'live', 'sessions'))).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/test/bench.test.ts apps/cli/test/run-campaign.test.ts`
Expected: FAIL — the campaign run test fails because `runSession` requires a fixture, and the bench tests cannot import `../src/bench`.

- [ ] **Step 3: Write the implementation**

Create `apps/cli/src/bench.ts`

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { benchSeat, type BenchResult } from '@cartyx-sim/models';
import { loadCampaign } from './campaign';

export interface BenchOptions {
  campaignsDir: string;
  campaign: string;
  /** Tool-call trials per seat. Default 5. */
  trials?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface BenchReport {
  results: BenchResult[];
  reportPath: string;
}

/** Whether every seat is reachable and made every tool call correctly. */
export function benchPassed(results: readonly BenchResult[]): boolean {
  return results.every(
    (result) => result.reachable && result.toolCallSuccesses === result.toolCallTrials
  );
}

export function formatBenchTable(results: readonly BenchResult[]): string[] {
  const header = ['seat', 'model', 'reachable', 'listed', 'tok/s', 'latency ms', 'tool calls'];
  const rows = results.map((result) => [
    result.seat,
    result.model,
    result.reachable ? 'yes' : 'NO',
    result.modelListed === null ? '?' : result.modelListed ? 'yes' : 'NO',
    result.tokensPerSecond === null ? '-' : String(result.tokensPerSecond),
    result.latencyMs === null ? '-' : String(result.latencyMs),
    `${result.toolCallSuccesses}/${result.toolCallTrials}`,
  ]);
  const widths = header.map((_, column) =>
    Math.max(...[header, ...rows].map((row) => row[column]!.length))
  );
  const lines = [header, ...rows].map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join('  ')
      .trimEnd()
  );
  for (const result of results) {
    for (const error of result.errors) lines.push(`  ${result.seat}: ${error}`);
  }
  return lines;
}

/** Benchmarks every seat in a campaign, prints a table, and saves a JSON report under bench/. */
export async function runBench(options: BenchOptions): Promise<BenchReport> {
  const campaign = await loadCampaign(options.campaignsDir, options.campaign);
  const log = options.log ?? (() => {});
  const results: BenchResult[] = [];
  for (const [seat, model] of Object.entries(campaign.models)) {
    log(`Benchmarking ${seat} (${model.model} at ${model.endpoint.baseURL})...`);
    results.push(await benchSeat(seat, model, { trials: options.trials }));
  }
  for (const line of formatBenchTable(results)) log(line);

  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const dir = join(campaign.dir, 'bench');
  await mkdir(dir, { recursive: true });
  const reportPath = join(dir, `${createdAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(
    reportPath,
    `${JSON.stringify({ campaign: campaign.id, createdAt, results }, null, 2)}\n`
  );
  return { results, reportPath };
}
```

Modify `apps/cli/src/main.ts`

```diff
diff --git a/apps/cli/src/main.ts b/apps/cli/src/main.ts
index 893b2da..e124c04 100644
--- a/apps/cli/src/main.ts
+++ b/apps/cli/src/main.ts
@@ -1,5 +1,6 @@
 import { Command } from 'commander';
 import { parseNumber } from './args';
+import { benchPassed, runBench } from './bench';
 import { releaseHeldLocks } from './jsonl-sink';
 import { runSession } from './run';

@@ -15,7 +16,7 @@ for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {

 interface RunCommandOptions {
   campaign: string;
-  fixture: string;
+  fixture?: string;
   session: number;
   targetMinutes?: number;
   seed?: number;
@@ -23,17 +24,23 @@ interface RunCommandOptions {
   resume: boolean;
 }

+interface BenchCommandOptions {
+  campaign: string;
+  trials: number;
+  campaignsDir: string;
+}
+
 const program = new Command().name('sim').description('Cartyx AI D&D session simulator');

 program
   .command('run')
-  .description('Simulate a session and write its event log')
+  .description("Simulate a session with the campaign's model seats and write its event log")
   .requiredOption('--campaign <id>', 'campaign id (a folder under the campaigns directory)')
-  .requiredOption('--fixture <path>', 'scripted fixture to play; real models arrive in Plan 2')
+  .option('--fixture <path>', 'play a scripted fixture instead of the configured model seats')
   .option('--session <n>', 'session number', parseNumber('integer'), 1)
   .option(
     '--target-minutes <n>',
-    'target spoken minutes (overrides the fixture)',
+    'target spoken minutes (overrides the campaign or fixture)',
     parseNumber('positive')
   )
   .option('--seed <n>', 'seed for reproducible dice', parseNumber('integer'))
@@ -59,4 +66,21 @@ program
     }
   });

+program
+  .command('bench')
+  .description("Check each seat's endpoint: reachability, speed, and tool-call reliability")
+  .requiredOption('--campaign <id>', 'campaign id (a folder under the campaigns directory)')
+  .option('--trials <n>', 'tool-call trials per seat', parseNumber('integer'), 5)
+  .option('--campaigns-dir <path>', 'campaigns directory', 'campaigns')
+  .action(async (options: BenchCommandOptions) => {
+    const report = await runBench({
+      campaignsDir: options.campaignsDir,
+      campaign: options.campaign,
+      trials: options.trials,
+      log: (line) => console.log(line),
+    });
+    console.log(`\nBench report: ${report.reportPath}`);
+    if (!benchPassed(report.results)) process.exitCode = 1;
+  });
+
 await program.parseAsync(process.argv);
```

Modify `apps/cli/src/run.ts`

```diff
diff --git a/apps/cli/src/run.ts b/apps/cli/src/run.ts
index 264ed43..f372738 100644
--- a/apps/cli/src/run.ts
+++ b/apps/cli/src/run.ts
@@ -1,7 +1,17 @@
-import { basicPrompts, describeEvent, Director, type RunResult } from '@cartyx-sim/core';
+import {
+  basicPrompts,
+  describeEvent,
+  Director,
+  type DirectorConfig,
+  type LoreIndex,
+  type ModelClient,
+  type RunResult,
+} from '@cartyx-sim/core';
 import { ScriptedModelClient, StaticLoreIndex } from '@cartyx-sim/core/testing';
+import { OpenAICompatibleModelClient } from '@cartyx-sim/models';
 import { scriptedRng, secureRng, seededRng, type Rng } from '@cartyx-sim/rules';
-import { loadFixture, type Fixture } from './fixture';
+import { loadCampaign } from './campaign';
+import { loadFixture } from './fixture';
 import { JsonlFileSink } from './jsonl-sink';
 import { sessionEventsPath } from './paths';

@@ -9,7 +19,8 @@ export interface RunOptions {
   campaignsDir: string;
   campaign: string;
   session: number;
-  fixturePath: string;
+  /** Plays a scripted fixture instead of the campaign's configured model seats. */
+  fixturePath?: string;
   targetMinutes?: number;
   seed?: number;
   resume: boolean;
@@ -18,13 +29,55 @@ export interface RunOptions {

 export type RunSessionResult = RunResult & { eventsPath: string };

-function pickRng(fixture: Fixture, seed: number | undefined): Rng {
-  if (fixture.dice) return scriptedRng(fixture.dice);
+interface SessionSetup {
+  config: DirectorConfig;
+  model: ModelClient;
+  lore: LoreIndex;
+  rng: Rng;
+}
+
+function rngFor(seed: number | undefined): Rng {
   return seed === undefined ? secureRng() : seededRng(seed);
 }

+async function fixtureSetup(options: RunOptions, fixturePath: string): Promise<SessionSetup> {
+  const fixture = await loadFixture(fixturePath);
+  return {
+    config: {
+      session: options.session,
+      targetMinutes: options.targetMinutes ?? fixture.targetMinutes,
+      loreCommit: fixture.loreCommit,
+      party: fixture.party,
+      seats: fixture.seats,
+    },
+    model: new ScriptedModelClient(fixture.script),
+    lore: new StaticLoreIndex(fixture.lore),
+    rng: fixture.dice ? scriptedRng(fixture.dice) : rngFor(options.seed),
+  };
+}
+
+async function campaignSetup(options: RunOptions): Promise<SessionSetup> {
+  const campaign = await loadCampaign(options.campaignsDir, options.campaign);
+  return {
+    config: {
+      session: options.session,
+      targetMinutes: options.targetMinutes ?? campaign.targetMinutes,
+      loreCommit: campaign.loreCommit,
+      party: campaign.party,
+      seats: campaign.seats,
+    },
+    model: new OpenAICompatibleModelClient(campaign.models),
+    // No lore yet: every lookup reports a gap. Plan 2B replaces this with the cartyx-lore index.
+    lore: new StaticLoreIndex([]),
+    rng: rngFor(options.seed),
+  };
+}
+
 export async function runSession(options: RunOptions): Promise<RunSessionResult> {
-  const fixture = await loadFixture(options.fixturePath);
+  // Load and validate everything before taking the lock, so a config error leaves nothing behind.
+  const setup = options.fixturePath
+    ? await fixtureSetup(options, options.fixturePath)
+    : await campaignSetup(options);
   const eventsPath = sessionEventsPath(options.campaignsDir, options.campaign, options.session);
   const sink = new JsonlFileSink(eventsPath);
   const log = options.log ?? (() => {});
@@ -40,29 +93,20 @@ export async function runSession(options: RunOptions): Promise<RunSessionResult>
     if (!options.resume && (await sink.exists())) {
       throw new Error(`${eventsPath} already exists. Pass --resume to continue that session.`);
     }
-    const director = await Director.create(
-      {
-        session: options.session,
-        targetMinutes: options.targetMinutes ?? fixture.targetMinutes,
-        loreCommit: fixture.loreCommit,
-        party: fixture.party,
-        seats: fixture.seats,
+    const director = await Director.create(setup.config, {
+      model: setup.model,
+      lore: setup.lore,
+      rng: setup.rng,
+      sink,
+      prompts: basicPrompts,
+      onCommit: (events, state) => {
+        for (const event of events) {
+          if (event.visibility !== 'public') continue;
+          const line = describeEvent(event, state);
+          if (line) log(line);
+        }
       },
-      {
-        model: new ScriptedModelClient(fixture.script),
-        lore: new StaticLoreIndex(fixture.lore),
-        rng: pickRng(fixture, options.seed),
-        sink,
-        prompts: basicPrompts,
-        onCommit: (events, state) => {
-          for (const event of events) {
-            if (event.visibility !== 'public') continue;
-            const line = describeEvent(event, state);
-            if (line) log(line);
-          }
-        },
-      }
-    );
+    });
     if (sink.tornTail) {
       log(
         `Ignoring an incomplete final line (line ${sink.tornTail.line}) left by an interrupted ` +
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/test/bench.test.ts apps/cli/test/run-campaign.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Typecheck, run the full suite, and check formatting**

Run: `npm run typecheck && npm test && npm run format:check`
Expected: no type errors, every test passes, and Prettier reports all files formatted.

- [ ] **Step 6: Smoke-test the CLI**

Run: `npm run sim -- run --campaign demo --fixture apps/cli/fixtures/demo-session.json --campaigns-dir /tmp/cartyx-sim-2a-demo && rm -rf /tmp/cartyx-sim-2a-demo && npm run sim -- bench --help`
Expected: The fixture session ends with `Session ended.`, and `bench --help` lists `--campaign`, `--trials`, and `--campaigns-dir`.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/bench.ts \
  apps/cli/src/main.ts \
  apps/cli/src/run.ts \
  apps/cli/test/bench.test.ts \
  apps/cli/test/run-campaign.test.ts
git commit -m "feat(cli): run sessions against campaign model seats and add sim bench"
```

### Task 9: Roadmap and a guide to running a session

Record Plan 2A in the roadmap (splitting Plan 2 into 2A–2C, adding the new deviations, and rescheduling the backlog) and document how to bring up model servers, configure a campaign, bench, run, and resume.

**Files:**

- Create: `docs/running-a-session.md`
- Modify: `docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md`

**Interfaces:**

- `docs/running-a-session.md`
- `docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md`

- [ ] **Step 1: Make the change**

Create `docs/running-a-session.md`

````markdown
# Running a session with local models

This guide covers what Plan 2A delivers: checking your model servers with `sim bench` and playing a session with `sim run`. Lore retrieval (Plan 2B), generated characters and session prep (Plan 2C), and voices, art, and playback (Plans 3–4) come later.

## 1. Install

```bash
npm ci
```

Node 22.22 or newer is required.

## 2. Start an OpenAI-compatible server for each seat

Every seat (the DM and each player) talks to an OpenAI-compatible `/v1` endpoint. Seats can share a server or each use a different machine.

- **LM Studio:** load the model, open the Developer tab, start the server, and enable "Serve on Local Network" so other machines can reach it. The default base URL is `http://<machine>:1234/v1`.
- **llama.cpp:** `llama-server -m <model>.gguf --host 0.0.0.0 --port 8080 --jinja`. The `--jinja` flag enables tool calling. The base URL is `http://<machine>:8080/v1`.
- **mlx_lm:** `mlx_lm.server --model <model> --host 0.0.0.0 --port 8080`.

The engine asks every call to use a tool. If a server ignores that and replies with plain text, set `toolChoice: auto` on that seat (see below) so a text reply is used as narration or speech instead of counting as a failure.

## 3. Create a campaign

Copy the example into your campaigns directory (`./campaigns` by default; it is git-ignored):

```bash
mkdir -p campaigns && cp -R apps/cli/examples/local-campaign campaigns/avalon
```

Then edit `campaigns/avalon/campaign.yaml`:

```yaml
name: Avalon
targetMinutes: 60
endpoints:
  macbook: { baseURL: http://127.0.0.1:1234/v1 }
  studio: { baseURL: http://192.168.1.20:1234/v1 }
  ampere: { baseURL: http://192.168.1.30:8080/v1 }
seats:
  dm:
    endpoint: macbook
    model: <model id as the server lists it>
    temperature: 0.8
    fallbacks:
      - { endpoint: ampere, model: <backup model id> }
  players:
    kira: { endpoint: studio, model: <model id>, temperature: 0.9 }
    tomas: { endpoint: ampere, model: <model id>, toolChoice: auto }
```

Seat options: `temperature`, `maxOutputTokens`, `timeoutMs` (default 120000), `toolChoice` (`auto` or `required`), and `fallbacks` (tried in order when a call fails).

Each party member is a file in `characters/` (for example `characters/kira.yaml`). Every party member needs a seat under `seats.players`, and every seat there needs a matching character. The example characters are placeholders until `sim chargen` arrives in Plan 2C.

## 4. Check the seats

```bash
npm run sim -- bench --campaign avalon
```

For each seat this reports whether the server answered, whether it lists the configured model id, generation speed in tokens per second, and how many of the tool-call trials (default 5, `--trials N`) were well-formed. A report is saved to `campaigns/avalon/bench/<timestamp>.json`. The command exits with code 1 if any seat is unreachable or missed a tool-call trial.

## 5. Play a session

```bash
npm run sim -- run --campaign avalon --target-minutes 10
```

Public events print as they happen, and every event is appended to `campaigns/avalon/sessions/001/events.jsonl`. Use `--session N` for later sessions and `--seed N` for reproducible dice.

Until Plan 2B there is no lore index: every lore lookup reports a gap, and the DM invents details and records them with `record_invention`.

## 6. Pauses and resuming

A session pauses (exit code 2) instead of crashing when:

- a seat keeps failing after its fallbacks and the retry delays (the message names the seat);
- nobody has spoken for 12 turns in a row;
- the DM hands off 3 times in a row with no player character able to respond.

Fix the cause, then continue with the same command plus `--resume`. The log is the source of truth: resuming uses the logged party, target minutes, and lore commit.

Ctrl-C releases the session lock before exiting. If a run was killed without releasing it, the next run replaces a lock whose process is no longer running and says so.
````

Modify `docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md`

```diff
diff --git a/docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md b/docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md
index b0a7dfc..ced38b2 100644
--- a/docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md
+++ b/docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md
@@ -4,12 +4,14 @@

 The v1 spec covers four independent subsystems. Each gets its own implementation plan, and each plan ends in working, testable software. Later plans are written after the earlier plan lands, so they build on the real interfaces rather than guessed ones.

-| #   | Plan                                          | Delivers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Depends on                               | Status                 |
-| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ---------------------- |
-| 1   | `2026-09-13-cartyx-sim-plan-1-engine-core.md` | Monorepo, `rules` package (dice, checks, attacks, HP, conditions, slots, initiative, inventory), `core` package (event log schema, state projection, tools, validators, scheduler, session clock, director turn loop with resume), `sim run` against a scripted fixture model. Fully tested with no AI models.                                                                                                                                                                                                           | —                                        | Implemented (hardened) |
-| 2   | Plan 2 — Live AI session                      | `models` package (Vercel AI SDK, OpenAI-compatible seats, fallbacks), `sim bench`, `lore` package (ingest `cartyx-lore`, embeddings, LanceDB, `sim index`), SRD 5.2.1 import (classes, equipment, monsters) and SRD-backed spell validation and `award_milestone`, production prompts (DM persona, player personas, class primers, knowledge isolation), scribe (scene summaries, recap, DM notes, journals), `sim chargen` (text only), `sim prep`, `sim run` with real models, `sim audit`, 5-minute end-to-end smoke. | 1                                        | Not written            |
-| 3   | Plan 3 — Media production                     | Ampere ARM64 spike (ComfyUI + Z-Image-Turbo on the 3090, Qwen3-TTS on the 4070, with fallbacks), `media` package, chargen portraits and PC voices, `sim cast`, `sim art`, `sim voice`, `timeline.json`.                                                                                                                                                                                                                                                                                                                  | 1 (event log), 2 (chargen, scribe model) | Not written            |
-| 4   | Plan 4 — Playback page                        | `apps/playback` (React + Vite): 20/80 video-call layout, stage rules (PC / DM-with-scene / NPC nameplate / overlap split), subtitles, live stats, roll callouts, review controls, `sim play`, Playwright layout checks.                                                                                                                                                                                                                                                                                                  | 1 (event types), 3 (timeline format)     | Not written            |
+| #   | Plan                                           | Delivers                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Depends on                                | Status                 |
+| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------- |
+| 1   | `2026-09-13-cartyx-sim-plan-1-engine-core.md`  | Monorepo, `rules` package (dice, checks, attacks, HP, conditions, slots, initiative, inventory), `core` package (event log schema, state projection, tools, validators, scheduler, session clock, director turn loop with resume), `sim run` against a scripted fixture model. Fully tested with no AI models.                                                                                                                                                                        | —                                         | Implemented (hardened) |
+| 2A  | `2026-09-13-cartyx-sim-plan-2a-live-models.md` | Engine hardening for real models (runaway-loop backstop, a validator flag for every DM outcome, a player-safe prompt view, downed PCs kept in initiative, turn ids and tool choice on model requests, an event schema version, a Node-free core typecheck, torn-log recovery), `models` package (OpenAI-compatible seats with fallbacks and timeouts, seat benchmarking), campaign config (`campaign.yaml` + `characters/*.yaml`), `sim bench`, and `sim run` against real endpoints. | 1                                         | Written                |
+| 2B  | Plan 2B — Lore                                 | `lore` package (ingest `cartyx-lore` markdown, chunk by heading with entity and Kanka-ID metadata, local embeddings, LanceDB, `sim index`), the campaign lore commit taken from the lore repository, entity ids on `LoreHit`, `lore_invention` linked to the narration it supports, and `sim audit`.                                                                                                                                                                                  | 2A                                        | Not written            |
+| 2C  | Plan 2C — Characters, prep, and prompts        | SRD 5.2.1 import (classes, equipment, monsters), SRD-backed spell validation and `award_milestone`, production prompts (DM persona, player personas, class primers), scribe (scene summaries, recap, DM notes, journals), `sim chargen` (text only), `sim prep`, player target-id validation, a class field on PCs, and a 5-minute end-to-end smoke run with real models.                                                                                                             | 2A, 2B                                    | Not written            |
+| 3   | Plan 3 — Media production                      | Ampere ARM64 spike (ComfyUI + Z-Image-Turbo on the 3090, Qwen3-TTS on the 4070, with fallbacks), `media` package, chargen portraits and PC voices, `sim cast`, `sim art`, `sim voice`, `timeline.json`.                                                                                                                                                                                                                                                                               | 1 (event log), 2C (chargen, scribe model) | Not written            |
+| 4   | Plan 4 — Playback page                         | `apps/playback` (React + Vite): 20/80 video-call layout, stage rules (PC / DM-with-scene / NPC nameplate / overlap split), subtitles, live stats, roll callouts, review controls, `sim play`, Playwright layout checks.                                                                                                                                                                                                                                                               | 1 (event types), 3 (timeline format)      | Not written            |

 The Plan 3 Ampere spike needs no code from Plans 1–2 and can be run on the hardware at any time. Running it early de-risks the machine assignment.

@@ -25,22 +27,32 @@ The Plan 3 Ampere spike needs no code from Plans 1–2 and can be run on the har
 - **Unexpected tool errors pause the session** (with the configured seat, not the bare actor id) instead of crashing the process, so a transient failure (a clock or lore outage, a bug) can be diagnosed and resumed from the log.
 - **Player transcripts redact monster AC and HP** (spec §5.5): attack rolls omit the AC comparison and a monster's HP change renders as wounded/down/recovers instead of numbers, for the player audience only — the event log and the DM's view are unchanged.

-## Carried into Plan 2 (from the Plan 1 final review)
-
-- **Runaway-loop backstop.** The watchdog only nudges (never pauses), never runs in combat, and a DM handing off to an all-down party gets unbounded empty beats. Spec §12 asks for a cap on DM tool calls per beat, but Plan 1 caps model calls. Add: pause with an `ooc_note` after K nudges or M silent turns (including combat), a per-beat tool-call cap, and a `hand_off` result that tells the DM nobody can respond.
-- **Validator flags for DM tool/schema errors** (spec §5.6 says every case emits `validator_flag`), and emit `accepted_with_flag` only after the tool succeeds.
-- **Downed PCs at combat start never get a turn** — `start_combat` still filters party members to `isUp` before rolling initiative, so a PC already at 0 HP when combat starts is never added to the order at all (and so can never act even after being healed mid-fight). The hardening pass fixed a related-but-different bug (a combatant who goes down _during_ the beat that starts combat could still wrongly be given the next turn); this one — adding every non-dead PC to initiative — is still open.
-- **Player prompt isolation by construction** — pass `PromptBuilder.player` a player-filtered view rather than the full `GameState` (monster stat blocks currently reachable). The hardening pass redacted monster AC/HP from the rendered transcript text, but the prompt builder still receives the whole `GameState`, so a future `PromptBuilder` could still leak monster stat blocks by construction.
-- **Interface additions:** `turnId`, `AbortSignal`/timeout, and `toolChoice` on `ModelRequest`; entity/Kanka-ID metadata on `LoreHit`; a schema version on `session_start`; decide `state_change.cause` string vs a `causeSeq` (spec §4.2 says cause seq — a spec deviation to record).
-- **Keep Node APIs out of core mechanically** — a core tsconfig without `types: ["node"]` or a grep test.
-- **JSONL torn writes** — tolerate or truncate an unterminated final line on read; CLI `--resume` with a scripted fixture replays from the start (document that resume is meaningful with real models).
-- **Deferred minors:** `applyEvent` exhaustiveness guard (before adding event types); `renderTranscript` limit 0 guard (when token-budgeted windows arrive); `skillName` title-casing ("Sleight Of Hand"); injectable tool lists for cartyx-app; old monsters accumulating in state.
-- **Link `lore_invention` events to the narration they support**, so an audit can tell which line of dialogue or narration used an invented fact.
-- **A class field (or character-file reference) on the PC**, for the playback page's character tiles (Plan 4).
-- **Clock thresholds can land one word late for some targets** due to floating-point minute math; worth a small epsilon if it causes visible drift.
-- **A seeded run's dice restart from the seed on resume**, so a resumed `--seed` session replays the same rolls it already used. Either document that, or offset the seeded RNG by the number of rolls already logged.
-- **Player target ids are free text.** `act` and `declare_spell` accept any target id without checking it names a combatant, and Plan 4's roll callouts key on `action.target`; validate them against the combatants in play.
-- **Extract a shared roll-event builder.** Roll events are built in about six places (attacks, checks, saves, spell damage and healing, initiative, `apply_damage`/`heal`) that must set `mode` and `subject` consistently; one builder would keep them from drifting.
-- **Move end-of-beat combat bookkeeping out of `director.ts`** into pure `state.ts` helpers (advancing past a finished or downed turn, ending combat when nobody can act), and split `director.test.ts` by concern (scheduling, validators, resume, pausing, combat).
-- **The watchdog's combat guard lacks a dedicated mutation-killing test**: add one that fails when the `!this.state.combat` check in `Director.step` is removed.
-- **Package manifests use caret ranges while the lockfile pins exact versions** — decide whether to pin manifests too once real models/dependencies are added in Plan 2.
+- **Real models must call a tool.** The director requests `toolChoice: "required"`, and the AI SDK treats a text-only reply to a required tool call as a failure, so it counts as a failed attempt (fallback endpoint, retry, then pause). A seat whose server ignores "required" sets `toolChoice: auto` in `campaign.yaml`, which restores the text-as-narration or text-as-speech fallback. (Plan 2A)
+- **The runaway-loop backstop pauses the session** rather than ending it: after 12 consecutive stalled turns (in or out of combat) — a turn with no spoken words and no game-state progress — or 3 consecutive hand-offs no player character can answer, and a DM beat is capped at 24 tool calls before `hand_off` is forced. A backstop pause resets its own counters, so resuming gives the table a fresh budget; an unfixed cause trips the same backstop again after another full limit. Every limit is a `DirectorConfig` option. (Plan 2A)
+- **Player prompts receive a `PlayerView`**, not `GameState`: the player's own sheet, allies' vitals, and other combatants by coarse status only, so no prompt builder can leak monster stats. (Plan 2A)
+- **A torn final line in `events.jsonl` is recovered, not fatal**: an unterminated line that is not a valid event is ignored on read and truncated before the next append. (Plan 2A)
+- **Lore is empty until Plan 2B.** `sim run --campaign` plays with no lore index, so every `lookup_lore` reports a gap and the DM invents and records details. (Plan 2A)
+- **Package manifests keep caret ranges; the lockfile pins exact versions.** Installs use `npm ci`. (Plan 2A)
+
+## Backlog
+
+Items carried from the Plan 1 reviews. Plan 2A resolved the runaway-loop backstop, validator flags for every DM outcome, downed PCs in initiative, player prompt isolation, turn ids and tool choice on `ModelRequest`, the event schema version, the Node-free core typecheck, torn JSONL writes, the watchdog combat-guard test, and the manifest pinning decision.
+
+### Scheduled
+
+- **Plan 2B:** entity and Kanka-ID metadata on `LoreHit`; link `lore_invention` events to the narration they support.
+- **Plan 2C:** a class field (or character-file reference) on PCs for the playback tiles; validate player `act` and `declare_spell` target ids against the combatants in play (Plan 4 roll callouts key on `action.target`).
+
+### Unscheduled cleanup
+
+- Decide `state_change.cause` (free text) versus a `causeSeq` (spec §4.2 says cause seq), and record the decision as a deviation if it stays text.
+- `applyEvent` exhaustiveness guard, before adding event types.
+- `renderTranscript` guard for a limit of 0, when token-budgeted windows arrive.
+- `skillName` title-casing ("Sleight Of Hand").
+- Injectable tool lists for cartyx-app.
+- Old monsters accumulating in state across combats.
+- Clock thresholds can land one word late for some targets due to floating-point minute math.
+- A seeded run's dice restart from the seed on resume; document it or offset the RNG by the logged rolls.
+- A scripted fixture replays from its first response on `--resume`; resume is meaningful with real models.
+- Extract a shared roll-event builder (roll events are built in about six places that must set `mode` and `subject` consistently).
+- Move end-of-beat combat bookkeeping out of `director.ts` into pure `state.ts` helpers, and split `director.test.ts` by concern.
```

- [ ] **Step 2: Typecheck, run the full suite, and check formatting**

Run: `npm run typecheck && npm test && npm run format:check`
Expected: no type errors, every test passes, and Prettier reports all files formatted.

- [ ] **Step 3: Commit**

```bash
git add docs/running-a-session.md \
  docs/superpowers/plans/2026-09-13-cartyx-sim-v1-roadmap.md
git commit -m "docs: split Plan 2 into 2A–2C and add a guide to running a session"
```

---

## Completion Check

- [ ] `npm run typecheck` reports no errors (root, `packages/rules`, and `packages/core` projects).
- [ ] `npm test` passes all 503 tests across 33 files.
- [ ] `npm run format:check` reports every file formatted.
- [ ] `npm run sim -- run --campaign demo --fixture apps/cli/fixtures/demo-session.json --campaigns-dir /tmp/cartyx-sim-2a-demo` still ends with `Session ended.`
- [ ] With a real model server running, `npm run sim -- bench --campaign <id>` reports every seat reachable (see `docs/running-a-session.md`).

## What Plans 2B and 2C Build On

- **2B (lore):** replace the empty `StaticLoreIndex` in `apps/cli/src/run.ts` `campaignSetup` with a LanceDB-backed `LoreIndex`; set `Campaign.loreCommit` from the lore repository instead of `campaign.yaml`; add entity ids to `LoreHit`.
- **2C (characters, prep, prompts):** replace `basicPrompts` with a production `PromptBuilder` that uses `PlayerView` for players; generate `characters/*.yaml` with `sim chargen`; tune `silentTurnPauseLimit`, `idleHandOffLimit`, and `maxDmToolCallsPerBeat` against real model runs.
