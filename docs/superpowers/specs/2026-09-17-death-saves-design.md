# Death saves for downed player characters — Design

**Date:** 2026-09-17
**Status:** Approved design
**Related:** v1 design §5 (rules and combat) (`2026-09-13-cartyx-sim-v1-design.md`); the 1-hour run findings in `docs/status.md` ("1-hour run (session 005)")

## 1. Why

In session 005 Kira dropped to 0 HP in round 2 of a five-round fight and never acted again. `isUp` is false at 0 HP, so `advanceCombat` skips her, and nothing else in the engine touches a downed PC. Her seat was silent for the last 40% of the session, and the fight had no stakes for her beyond that point: she could neither die nor recover.

5e death saving throws fix both: a downed PC's turn has an outcome every round, and the character can stabilize, wake on a natural 20, or die.

## 2. Scope

**In:** death saving throws, stabilization, death at three failures, a natural 20 waking the PC at 1 HP, a natural 1 counting twice, damage at 0 HP adding failures, and healing clearing the state. The engine rolls them; no model call is involved.

**Out:** the `stabilize` action a character can take on someone else (Medicine check), death saves for NPCs and monsters (they die at 0 HP, as today), exhaustion on revival, and resurrection.

## 3. Data model

`Combatant` (in `packages/rules/src/schemas.ts`) gains two fields, both with defaults, so existing logs and character files parse unchanged:

```ts
deathSaves: z.object({ successes: z.number().int().min(0).max(3), failures: z.number().int().min(0).max(3) })
  .default({ successes: 0, failures: 0 }),
stable: z.boolean().default(false),
```

`StateField` (in `packages/core/src/events.ts`) gains `'deathSaves'` and `'stable'`. This is additive: `EVENT_SCHEMA_VERSION` stays 1, so sessions 001–005 still load. New logs are unreadable by older builds, which is acceptable since nothing outside this repo reads them.

Invariants, enforced by the rules functions rather than the schema:

- `stable` is true only while `hp === 0 && !dead`.
- `deathSaves` is `{0, 0}` whenever `hp > 0`, when `dead`, or when `stable`.

## 4. Rules (`packages/rules/src/hp.ts`)

```ts
export type DeathSaveOutcome = 'success' | 'failure' | 'stable' | 'dead' | 'revived';
export function rollDeathSave(
  combatant: Combatant,
  roll: number
): { combatant: Combatant; outcome: DeathSaveOutcome };
export function failDeathSaves(
  combatant: Combatant,
  count: number
): { combatant: Combatant; dead: boolean };
```

`rollDeathSave` takes the d20 result (the caller rolls, so dice stay in one place) and throws a `RulesError` if the combatant is not a downed PC (`hp > 0`, `dead`, `stable`, or `kind !== 'pc'`):

| Roll       | Result                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------ |
| 20         | `revived`: `hp` 1, `unconscious` removed, saves reset                                            |
| 1          | two failures; a third or more means `dead`                                                       |
| 10 or more | one success; the third gives `stable`: saves reset, `stable` true, still unconscious and at 0 HP |
| 9 or less  | one failure; the third means `dead` (saves stay at 3 for the record)                             |

`failDeathSaves` is what damage at 0 HP uses: one failure for a hit, two for a critical. It is also where a `stable` PC struck again becomes unstable (`stable` false) with that many failures.

`applyDamage` changes: a PC already at 0 HP takes no HP loss but gains failures through `failDeathSaves` (one, or two when the caller says the hit was critical — a new optional `options: { critical?: boolean }`). Massive damage still kills outright, as it does today.

`applyHealing` changes: healing a PC above 0 HP also resets `deathSaves` and clears `stable` (it already removes `unconscious`).

## 5. Turn flow (`packages/core/src/state.ts`, `director.ts`)

A downed PC needs a turn without being able to act. `isUp` keeps its meaning (can act), and a separate predicate decides who gets a turn:

```ts
/** A PC at 0 HP who is neither dead nor stable: their turn is a death saving throw. */
export function isDying(combatant: Combatant | undefined): boolean;
/** Who takes the next turn in initiative: anyone who can act, plus dying PCs. */
function takesTurn(combatant: Combatant | undefined): boolean; // isUp || isDying
```

`advanceCombat` uses `takesTurn` instead of `isUp`, so a dying PC keeps its place in the order. `nextActor` gains one case: when the current combatant is dying, it returns `{ kind: 'death_save', combatantId }`.

The director handles that case without any model call, in one recorded turn:

1. Roll `1d20` through the same `Rng` as every other roll, and emit a `roll` event (`kind: 'save'`, `label: "<name> death saving throw"`, `target: 10`, `outcome: 'success' | 'failure'`, `visibility: 'public'`).
2. Apply `rollDeathSave` and emit a `state_change` for `deathSaves`, then for `stable` or `dead` or `hp` when those change, each with `cause: 'death_save'`.
3. Emit `turn_end` with the PC as the actor, then advance the combat turn as any other turn does.

The engine writes no prose for a death save: it never does. The DM sees the roll in its transcript and narrates it on its next beat.

A natural 20 leaves the PC at 1 HP, so their next turn is a normal PC turn.

Stable PCs stay in the order but are skipped (`takesTurn` is false), exactly as today, until healed.

## 6. What the seats see

- `describeEvent` renders a death save for the DM and the players as `[roll] Kira Vale death saving throw: 12 vs 10 — success (successes 2, failures 1)`, built from the roll event plus the `state_change` that follows it. To keep it to one line, the `state_change` for `deathSaves` renders as `[state] Kira Vale death saves: 2 successes, 1 failure`, and the transcript shows both lines.
- `PlayerView` shows a downed PC's death-save counts to every player, since the table can see a dying friend's state in play.
- The DM prompt's party block marks a dying PC: `- Kira Vale (id: kira) DYING (death saves 2/1), AC 15`, and a stable one `STABLE at 0 HP`. It already prints `DEAD`.
- The clock and hand-off logic are unchanged. `selectResponders` already filters by `isUp`, so a dying PC is not asked to speak.

## 7. Script stage

`packages/script` needs no schema change. `state_change` cues for `deathSaves` and `stable` are silent lines like the others:

- `deathSaves` renders as `*Kira Vale: 2 death save successes, 1 failure.*`
- `stable` becoming true renders as `*Kira Vale is stable.*`
- A roll line already covers the save itself.

Death saves for a non-PC never happen, so the hidden-stat rule (§5.5 of the v1 design) is unaffected.

## 8. Testing

- **Rules unit tests**: each row of the table in §4; a natural 20 from two failures; a natural 1 at two failures killing; damage at 0 HP adding one failure, a critical adding two, the third killing; damage to a stable PC making them unstable; healing clearing both fields; and `RulesError` for every non-dying input.
- **State tests**: `advanceCombat` gives a dying PC a turn and skips a stable one; `nextActor` returns `death_save`; a dying PC is not a responder.
- **Director test** (fixture model): a PC brought to 0 HP gets a death-save turn each round, with the roll and state events in order, and the fight continues; a scripted RNG drives success, stabilization, revival, and death.
- **Script test**: the two new `state_change` cues render.
- **Transcript and view tests**: the new lines, and the DM party block markers.

## 9. Known cost

A dying PC's turn has no model call, so a seat that is unconscious still says nothing. That is correct for 5e (an unconscious character cannot speak), and the stakes now change every round instead of nothing happening at all. Reviving someone else (a Medicine check to stabilize, or healing) is the DM's and the other players' business, and both already work.
