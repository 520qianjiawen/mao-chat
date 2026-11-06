import i18n from '../../locales';
import { ProviderConfig } from './ProviderConfig';
import { OpenAIProviderConfig, OpenAICompatibleSettingsBase, defaultOpenAICompatibleSettingsBase } from './OpenAIProviderConfig';
import { Provider } from '../../types/Provider';
import { Credentials, CredentialCtx, ClientOptions } from './ProviderDescriptor';
import { IClient, FilteredModel } from '../interfaces/IClient';
import { ApiKeyValidationResult } from '../interfaces/ISettingsService';
import { OpenAIClient } from '../clients/OpenAIClient';
import { OpenAIWebRTCClient } from '../clients/OpenAIWebRTCClient';

// OpenAI Compatible Settings (with custom endpoint support)
export interface OpenAICompatibleSettings extends OpenAICompatibleSettingsBase {
  customEndpoint: string;
}

export const defaultOpenAICompatibleSettings: OpenAICompatibleSettings = {
  ...defaultOpenAICompatibleSettingsBase,
  customEndpoint: '',
};

/**
 * OpenAI Compatible Provider Configuration
 * Allows users to specify custom API endpoints that are OpenAI-compatible
 */
export class OpenAICompatibleProviderConfig extends OpenAIProviderConfig {
  readonly settingsSliceKey = 'openaiCompatible';
  readonly i18nKey = 'openaiCompatible';
  readonly supportsWebRTC = true;

  async extractCredentials(slice: unknown, _ctx: CredentialCtx): Promise<Credentials> {
    const s = slice as OpenAICompatibleSettings;
    if (!s?.apiKey) return { ok: false, missing: 'API key is required for openai_compatible' };
    return { ok: true, primary: s.apiKey, endpoint: s.customEndpoint };
  }

  createClient(creds: Credentials & { ok: true }, options: ClientOptions): IClient {
    if (!creds.endpoint) throw new Error('Custom endpoint is required for openai_compatible provider');
    if (options.transport === 'webrtc') {
      return new OpenAIWebRTCClient({
        apiKey: creds.primary,
        apiHost: creds.endpoint,
        inputDeviceId: options.webrtcOptions?.inputDeviceId,
        outputDeviceId: options.webrtcOptions?.outputDeviceId,
      });
    }
    return new OpenAIClient(creds.primary, creds.endpoint);
  }

  async validateAndFetchModels(creds: Credentials): Promise<{
    validation: ApiKeyValidationResult; models: FilteredModel[];
  }> {
    if (!creds.ok) {
      return { validation: { valid: false, message: creds.missing, validating: false }, models: [] };
    }
    if (!creds.endpoint) {
      return {
        validation: { valid: false, message: 'Custom API endpoint is required for OpenAI Compatible provider', validating: false },
        models: [],
      };
    }

    const host = OpenAIClient.normalizeApiHost(creds.endpoint);
    const { models, error } = await OpenAIClient.fetchOpenAIModelsList(creds.primary, host);
    if (error) {
      return { validation: error, models: [] };
    }

    // Map all models returned by the OpenAI-compatible endpoint (e.g. Ling-3.1-flash, DeepSeek, etc.)
    const filteredModels: FilteredModel[] = models.map((m: any) => ({
      id: m.id,
      type: (m.id.toLowerCase().includes('realtime') || m.id.toLowerCase().includes('audio')) ? 'realtime' : 'chat',
      created: m.created,
    }));

    const message = i18n.t('settings.apiKeyValidationCompleted', 'API Key 验证成功') +
      (filteredModels.length > 0 ? ` (发现 ${filteredModels.length} 个可用模型)` : '');

    return {
      validation: {
        valid: true,
        message,
        validating: false,
        hasRealtimeModel: filteredModels.some(m => m.type === 'realtime'),
      },
      models: filteredModels,
    };
  }

  latestRealtimeModel(models: FilteredModel[]): string {
    if (models.length === 0) return 'Ling-3.1-flash';
    const rt = models.find(m => m.type === 'realtime');
    if (rt) return rt.id;
    const flash = models.find(m => m.id.toLowerCase().includes('flash'));
    if (flash) return flash.id;
    return models[0].id;
  }

  getConfig(): ProviderConfig {
    // Get the base OpenAI configuration
    const baseConfig = super.getConfig();

    // Override fields specific to OpenAI Compatible provider
    return {
      ...baseConfig,
      id: Provider.OPENAI_COMPATIBLE,
      displayName: 'OpenAI Compatible API',
      apiKeyLabel: 'API Key',
      apiKeyPlaceholder: 'Enter your API key...',
      supportsCustomEndpoint: true,
      customEndpointLabel: 'API Endpoint',
      customEndpointPlaceholder: 'https://your-api-endpoint.com',
    };
  }
}
