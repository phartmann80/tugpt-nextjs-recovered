import type { AIProviderAdapter } from './adapter';
import { AnymizeAdapter, type AnymizeConfig } from './anymize';
import { LangdockAdapter, type LangdockConfig } from './langdock';
import { LogiccAdapter, type LogiccConfig } from './logicc';
import { MastraAdapter, type MastraConfig } from './mastra';
import { OpenAIAdapter, type OpenAIConfig } from './openai';

export type ProviderType = 'logicc' | 'langdock' | 'mastra' | 'openai' | 'anymize';

export interface ProviderFactoryConfig {
  logicc?: LogiccConfig;
  langdock?: LangdockConfig;
  mastra?: MastraConfig;
  openai?: OpenAIConfig;
  anymize?: AnymizeConfig;
}

export class AIProviderFactory {
  private static instance: AIProviderFactory;
  private adapters: Map<string, AIProviderAdapter> = new Map();

  public static getInstance(): AIProviderFactory {
    if (!AIProviderFactory.instance) {
      AIProviderFactory.instance = new AIProviderFactory();
    }
    return AIProviderFactory.instance;
  }

  public registerAdapter(adapter: AIProviderAdapter): void {
    this.adapters.set(adapter.providerName.toLowerCase(), adapter);
  }

  public getAdapter(providerName: ProviderType | string): AIProviderAdapter {
    const key = providerName.toLowerCase();
    const adapter = this.adapters.get(key);

    if (!adapter) {
      throw new Error(`AI Provider Adapter '${providerName}' is not registered.`);
    }

    return adapter;
  }

  public initializeFromEnv(): void {
    const langdockKey = process.env.LANGDOCK_API_CODE;
    if (langdockKey) {
      this.registerAdapter(
        new LangdockAdapter({
          apiKey: langdockKey,
          endpointUrl: process.env.LANGDOCK_ENDPOINT_URL,
          defaultModel: process.env.MODEL || 'gpt-5.2',
        })
      );
    }

    const mastraKey = process.env.GATEWAY_API_MASTRA_KEY;
    if (mastraKey) {
      this.registerAdapter(
        new MastraAdapter({
          apiKey: mastraKey,
          gatewayUrl: process.env.GATEWAY_API_URL,
        })
      );
    }

    const openAIKey = process.env.OPENAI_API_KEY;
    if (openAIKey) {
      this.registerAdapter(
        new OpenAIAdapter({
          apiKey: openAIKey,
        })
      );
    }

    const logiccKey = process.env.LOGICC_API_KEY;
    if (logiccKey) {
      this.registerAdapter(
        new LogiccAdapter({
          apiKey: logiccKey,
          endpointUrl: process.env.LOGICC_ENDPOINT_URL || '',
          defaultModel: process.env.LOGICC_DEFAULT_MODEL,
        })
      );
    }

    const anymizeKey = process.env.ANYMIZE_API_KEY;
    if (anymizeKey) {
      this.registerAdapter(
        new AnymizeAdapter({
          apiKey: anymizeKey,
          endpointUrl: process.env.ANYMIZE_ENDPOINT_URL,
          defaultModel: process.env.ANYMIZE_DEFAULT_MODEL,
        })
      );
    }
  }
}

export const aiProviderFactory = AIProviderFactory.getInstance();