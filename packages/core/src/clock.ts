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
