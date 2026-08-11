/**
 * @file factory.ts
 * @description Provider factory for creating AI provider adapters from
 * environment variables. Supports Logicc (primary), Langdock (secondary),
 * and Anymize (tertiary) providers.
 */

import { AnymizeAdapter } from './anymize.js';
import { LangdockAdapter } from './langdock.js';
import { LogiccAdapter } from './logicc.js';
import type { AIProviderAdapter } from './adapter.js';

export type ProviderType = 'logicc' | 'langdock' | 'anymize';

export function createProviderFromEnv(provider: ProviderType): AIProviderAdapter {
  switch (provider) {
    case 'logicc': {
      const apiKey = process.env.LOGICC_API_KEY;
      const endpointUrl = process.env.LOGICC_ENDPOINT_URL;
      const defaultModel = process.env.LOGICC_DEFAULT_MODEL;
      if (!apiKey || !endpointUrl) {
        throw new Error(`Missing Logicc configuration: LOGICC_API_KEY and LOGICC_ENDPOINT_URL are required`);
      }
      return new LogiccAdapter({ apiKey, endpointUrl, defaultModel });
    }
    case 'langdock': {
      const apiKey = process.env.LANGDOCK_API_CODE;
      const endpointUrl = process.env.LANGDOCK_ENDPOINT_URL;
      const defaultModel = process.env.MODEL;
      if (!apiKey) {
        throw new Error(`Missing Langdock configuration: LANGDOCK_API_CODE is required`);
      }
      return new LangdockAdapter({ apiKey, endpointUrl, defaultModel });
    }
    case 'anymize': {
      const apiKey = process.env.ANYMIZE_API_KEY;
      const endpointUrl = process.env.ANYMIZE_ENDPOINT_URL;
      const defaultModel = process.env.ANYMIZE_DEFAULT_MODEL || 'openai/gpt-5-mini';
      if (!apiKey || !endpointUrl) {
        throw new Error(`Missing Anymize configuration: ANYMIZE_API_KEY and ANYMIZE_ENDPOINT_URL are required`);
      }
      return new AnymizeAdapter({ apiKey, endpointUrl, defaultModel });
    }
    default:
      throw new Error(`Unknown provider type: ${provider}`);
  }
}