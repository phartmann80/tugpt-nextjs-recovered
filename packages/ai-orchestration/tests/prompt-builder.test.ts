import { describe, it, expect } from 'vitest';
import { buildPromptMessages } from '../src/prompt-builder';
import type { DraftConfig } from '../src/types';

const defaultConfig: DraftConfig = {
  businessInstructions: 'Always be helpful and answer customer questions.',
  personality: 'Professional, warm, and concise.',
  responseRules: 'Never make up information. Always greet the customer.',
  tone: 'Friendly',
  maxDraftLength: 500,
};

describe('prompt-builder', () => {
  // T26: System prompt includes business_instructions, personality, response_rules, tone
  it('includes all config fields in the system message', () => {
    const messages = buildPromptMessages('Hello', defaultConfig);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Always be helpful and answer customer questions.');
    expect(messages[0].content).toContain('Professional, warm, and concise.');
    expect(messages[0].content).toContain('Never make up information. Always greet the customer.');
    expect(messages[0].content).toContain('Friendly');
  });

  // T27: User message is the source message text
  it('sets the user message to the source text', () => {
    const sourceText = 'Hi, I need help with my order #12345.';
    const messages = buildPromptMessages(sourceText, defaultConfig);

    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toBe(sourceText);
  });

  // T28: max_draft_length is included as a character constraint, not as maxTokens
  it('includes max_draft_length as a character constraint in the system message', () => {
    const messages = buildPromptMessages('Hello', defaultConfig);

    expect(messages[0].content).toContain('500 characters');
    expect(messages[0].content).not.toContain('maxTokens');
    expect(messages[0].content).not.toContain('max_tokens');
  });

  // T29: Handles empty config fields gracefully
  it('handles empty config fields without adding empty sections', () => {
    const emptyConfig: DraftConfig = {
      businessInstructions: '',
      personality: '',
      responseRules: '',
      tone: '',
      maxDraftLength: 1000,
    };

    const messages = buildPromptMessages('Hello', emptyConfig);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    // Should still include the character constraint
    expect(messages[0].content).toContain('1000 characters');
    // Should not include empty section headers
    expect(messages[0].content).not.toContain('Business Instructions:\n\n');
  });
});