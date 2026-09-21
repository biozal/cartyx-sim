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
      return (
        'The session is nearing its time limit: start steering toward a satisfying cliffhanger, ' +
        'and do not start a new fight.'
      );
    case 'end_at_scene_break':
    case 'hard_stop':
      return 'Time is up: end combat with end_combat if a fight is running, close the current scene now, and call scene_change to cut to the cliffhanger.';
  }
}

/** The DM's share of the words spoken so far, 0 when nothing has been spoken. */
export function dmShare(state: Pick<GameState, 'spokenWords' | 'wordsBySpeaker'>): number {
  if (state.spokenWords === 0) return 0;
  return (state.wordsBySpeaker['dm'] ?? 0) / state.spokenWords;
}

/**
 * Words that must be spoken before the DM's share is worth steering by: the DM opens a session
 * alone, so a floor below this reads the scene-setting as a habit.
 */
const SHARE_FLOOR_WORDS = 3000;
/**
 * The share above which the DM is told to give the table more room. Sessions 005–011 ended at
 * 64–72%, and replaying them word by word, this limit leaves six of the seven untouched; session
 * 012, which ended at 79%, trips it. A tighter limit nudges sessions that were fine.
 */
const SHARE_LIMIT = 0.78;

/**
 * An instruction to hand the table more of the session, or '' when the DM's share is fine. The
 * DM is the loudest voice by design — it describes the world — but session 012 spent 79% of the
 * words on narration averaging 187 words a beat, which leaves the players a fifth of their own
 * session.
 */
export function shareInstruction(state: Pick<GameState, 'spokenWords' | 'wordsBySpeaker'>): string {
  if (state.spokenWords < SHARE_FLOOR_WORDS) return '';
  const share = dmShare(state);
  if (share <= SHARE_LIMIT) return '';
  return (
    `You have spoken ${Math.round(share * 100)}% of this session's words; the players share the rest. ` +
    'Keep this beat to two or three sentences, end on something the players must answer, and hand off.'
  );
}
