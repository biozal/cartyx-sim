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
