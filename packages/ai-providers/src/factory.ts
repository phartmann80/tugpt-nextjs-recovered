import type { AIProviderAdapter } from './adapter';
import { LangdockAdapter, type LangdockConfig } from './langdock';
import { MastraAdapter, type MastraConfig } from './mastra';
import { OpenAIAdapter, type OpenAIConfig } from './openai';

export type ProviderType = 'langdock' | 'mastra' | 'openai';

export interface ProviderFactoryConfig {
  langdock?: LangdockConfig;
  mastra?: MastraConfig;
  openai?: OpenAIConfig;
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
  }
}

export const aiProviderFactory = AIProviderFactory.getInstance();