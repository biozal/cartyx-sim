import { describe, expect, it } from 'vitest';
import { clockInstruction, clockPhase, spokenMinutes } from '../src/clock';

describe('session clock', () => {
  it('converts spoken words to minutes at 150 words per minute', () => {
    expect(spokenMinutes({ spokenWords: 1500 })).toBe(10);
  });

  it.each([
    [0, 'running'],
    [1199, 'running'],
    [1200, 'wrap_up'],
    [1499, 'wrap_up'],
    [1500, 'end_at_scene_break'],
    [1724, 'end_at_scene_break'],
    [1800, 'hard_stop'],
  ])('%i words of a 10-minute target is %s', (spokenWords, phase) => {
    expect(clockPhase({ spokenWords }, 10)).toBe(phase);
  });

  it('only instructs the DM once wrap-up begins', () => {
    expect(clockInstruction('running')).toBe('');
    expect(clockInstruction('wrap_up')).toContain('nearing its time limit');
    expect(clockInstruction('end_at_scene_break')).toContain('call scene_change');
  });

  it('tells the DM not to start a new fight once wrap-up begins', () => {
    expect(clockInstruction('wrap_up')).toContain('do not start a new fight');
    expect(clockInstruction('running')).not.toContain('do not start a new fight');
  });

  it.each(['end_at_scene_break', 'hard_stop'] as const)(
    'tells the DM to close combat before the scene cut in %s',
    (phase) => {
      expect(clockInstruction(phase)).toContain('end_combat');
      expect(clockInstruction(phase)).toContain('call scene_change');
    }
  );
});
