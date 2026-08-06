/**
 * @file prompt-builder.ts
 * @description Builds ChatMessage[] from source message text and ai_draft_config fields.
 *
 * Constructs a system message from business_instructions, personality,
 * response_rules, and tone. The user message is the source message text.
 *
 * maxDraftLength is an output-length constraint measured in characters against
 * the final draft text. It is NOT passed as maxTokens (which is a token limit).
 * A separate conservative provider-token limit may be used by the orchestrator.
 */

import type { ChatMessage } from '@tugpt/ai-providers';
import type { DraftConfig } from './types';

/**
 * Build the chat messages for draft generation.
 *
 * @param sourceText - The inbound message text from the customer
 * @param config - The ai_draft_config fields (business_instructions, personality, response_rules, tone, max_draft_length)
 * @returns ChatMessage[] with a system message and a user message
 */
export function buildPromptMessages(sourceText: string, config: DraftConfig): ChatMessage[] {
  const systemParts: string[] = [];

  if (config.businessInstructions) {
    systemParts.push(`Business Instructions:\n${config.businessInstructions}`);
  }

  if (config.personality) {
    systemParts.push(`Personality:\n${config.personality}`);
  }

  if (config.responseRules) {
    systemParts.push(`Response Rules:\n${config.responseRules}`);
  }

  if (config.tone) {
    systemParts.push(`Tone:\n${config.tone}`);
  }

  // Add output length constraint as guidance (character limit, not token limit)
  systemParts.push(`Keep your response under ${config.maxDraftLength} characters.`);

  const systemContent = systemParts.join('\n\n');

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: sourceText },
  ];
}