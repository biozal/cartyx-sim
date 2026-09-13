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
