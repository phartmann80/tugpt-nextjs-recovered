import type { AIProviderAdapter } from '@tugpt/ai-providers';

export interface DraftConfig {
  businessInstructions: string;
  personality: string;
  responseRules: string;
  tone: string;
  maxDraftLength: number;
}

export interface DraftRequest {
  sourceMessageText: string;
  config: DraftConfig;
  organizationId: string;
  requestId: string;
}

export interface DraftResult {
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
}

export interface DraftError {
  category: string;
  provider: string;
  message?: string;
}

export interface DraftOutcome {
  success: boolean;
  result?: DraftResult;
  error?: DraftError;
}

/**
 * Orchestrator configuration: strict provider ordering.
 *
 * Per Paul's spec:
 * 1. Logicc = primary
 * 2. Langdock = secondary fallback
 * 3. Anymize = tertiary fallback
 *
 * No round-robin, random routing, or load balancing.
 * A provider may fall through to the next only for transient conditions.
 */
export interface OrchestratorConfig {
  primary: AIProviderAdapter;
  fallback: AIProviderAdapter;
  tertiary?: AIProviderAdapter;
}