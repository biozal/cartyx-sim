import { describeSlots, slotsRemaining } from '@cartyx-sim/rules';
import { z } from 'zod';
import { Emotion } from '../events';
import { countWords } from '../text';
import { defineTool, getCombatant, SpokenText, ToolError } from './types';

export const INTERJECTION_MAX_WORDS = 12;

export const speak = defineTool({
  name: 'speak',
  description: 'Say something out loud, in character, as your own character.',
  parameters: z.object({
    text: SpokenText,
    emotion: Emotion.default('neutral'),
  }),
  narrativeText: (args) => args.text,
  run(args, { recorder, actorId }) {
    recorder.emit({
      type: 'dialogue',
      speaker: actorId,
      speakerKind: 'pc',
      text: args.text,
      emotion: args.emotion,
    });
    return { result: 'Said.' };
  },
});

export const act = defineTool({
  name: 'act',
  description:
    'Declare what your character attempts. Describe the attempt only; the DM decides what happens.',
  parameters: z.object({
    intent: z.string().trim().min(1).max(2000),
    targetId: z.string().min(1).max(200).optional(),
  }),
  narrativeText: (args) => args.intent,
  run(args, { recorder, actorId }) {
    recorder.emit({ type: 'action', actor: actorId, intent: args.intent, target: args.targetId });
    return { result: 'Declared.' };
  },
});

export const interject = defineTool({
  name: 'interject',
  description: `A short reaction (at most ${INTERJECTION_MAX_WORDS} words) that overlaps the most recent line, like "Wait—!" or a laugh. Does not use up your turn.`,
  parameters: z.object({
    text: SpokenText,
    emotion: Emotion.default('surprised'),
  }),
  narrativeText: (args) => args.text,
  run(args, { recorder, history, actorId }) {
    if (countWords(args.text) > INTERJECTION_MAX_WORDS) {
      throw new ToolError(`Interjections must be ${INTERJECTION_MAX_WORDS} words or fewer.`);
    }
    const spoken = [...history, ...recorder.events]
      .reverse()
      .find(
        (event) =>
          (event.type === 'narration' || event.type === 'dialogue') && event.speaker !== actorId
      );
    if (!spoken) throw new ToolError('There is no line to interject over yet.');
    recorder.emit({
      type: 'dialogue',
      speaker: actorId,
      speakerKind: 'pc',
      text: args.text,
      emotion: args.emotion,
      overlaps: spoken.seq,
    });
    return { result: 'Interjected.' };
  },
});

export const declareSpell = defineTool({
  name: 'declare_spell',
  description:
    'Declare that you cast a spell (slotLevel 0 for cantrips) at optional targets. The DM resolves the effect.',
  parameters: z.object({
    spell: z.string().trim().min(1).max(200),
    slotLevel: z.number().int().min(0).max(9),
    targetIds: z.array(z.string().min(1).max(200)).default([]),
  }),
  run(args, { recorder, actorId }) {
    const caster = getCombatant(recorder.state, actorId);
    if (args.slotLevel > 0 && slotsRemaining(caster, args.slotLevel) < 1) {
      throw new ToolError(
        `You have no level ${args.slotLevel} spell slots left (slots: ${describeSlots(caster) || 'none'}).`
      );
    }
    const level = args.slotLevel > 0 ? ` at level ${args.slotLevel}` : '';
    const targets = args.targetIds.length > 0 ? ` targeting ${args.targetIds.join(', ')}` : '';
    recorder.emit({
      type: 'action',
      actor: actorId,
      intent: `casts ${args.spell}${level}${targets}`,
      target: args.targetIds[0],
    });
    return { result: 'Spell declared; the DM will resolve it.' };
  },
});

export const pass = defineTool({
  name: 'pass',
  description: 'Do nothing this turn.',
  parameters: z.object({}),
  run(_args, { recorder, actorId }) {
    recorder.emit({ type: 'pass', actor: actorId });
    return { result: 'Passed.' };
  },
});
