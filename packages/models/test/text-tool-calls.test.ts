import { describe, expect, it } from 'vitest';
import { recoverTextToolCalls } from '../src/text-tool-calls';

const TOOLS = ['speak', 'act', 'pass'];
const Q = '<|"|>';

describe('recoverTextToolCalls', () => {
  it('recovers a call Gemma wrote as text, as LM Studio passed it through in session 015', () => {
    const text = `speak{emotion:${Q}determined${Q},text:${Q}We can't leave her stuck here, Z.${Q}}`;
    expect(recoverTextToolCalls(text, TOOLS)).toEqual([
      {
        id: 'text-call-0',
        name: 'speak',
        args: { emotion: 'determined', text: "We can't leave her stuck here, Z." },
      },
    ]);
  });

  it('accepts the call: prefix, leftover call markers and several calls in a row', () => {
    const text =
      `<|tool_call>call:speak{text:${Q}Go.${Q}}<tool_call|>\n` +
      `call:act{intent:${Q}Follow it.${Q},targetId:null}`;
    expect(recoverTextToolCalls(text, TOOLS)).toEqual([
      { id: 'text-call-0', name: 'speak', args: { text: 'Go.' } },
      { id: 'text-call-1', name: 'act', args: { intent: 'Follow it.', targetId: null } },
    ]);
  });

  it('reads numbers, booleans, arrays, nested objects and JSON strings', () => {
    const text = `act{n:3,ratio:-1.5e2,ok:true,tags:[${Q}a${Q},"b"],where:{x:1},"quoted key":"v\\"q"}`;
    expect(recoverTextToolCalls(text, TOOLS)[0]!.args).toEqual({
      n: 3,
      ratio: -150,
      ok: true,
      tags: ['a', 'b'],
      where: { x: 1 },
      'quoted key': 'v"q',
    });
  });

  it('keeps a "__proto__" key as data', () => {
    const [call] = recoverTextToolCalls(`act{__proto__:{polluted:true}}`, TOOLS);
    expect(Object.getPrototypeOf(call!.args)).toBe(Object.prototype);
    expect(Object.keys(call!.args)).toEqual(['__proto__']);
  });

  it.each([
    ['prose', 'Tomas Reed: "Hold on, Z. If those stakes are feeding data into the bot\'s core."'],
    ['prose naming a tool', 'I speak{softly} to the automaton.'],
    ['a tool that was not offered', `declare_spell{name:${Q}Light${Q}}`],
    ['trailing prose after a call', `speak{text:${Q}Go.${Q}} And then he runs.`],
    ['an unterminated string', `speak{text:${Q}Go.}`],
    ['a bare name', 'pass'],
    ['empty text', '   '],
  ])('recovers nothing from %s', (_, text) => {
    expect(recoverTextToolCalls(text, TOOLS)).toEqual([]);
  });
});
