// src/services/providers/AntLingProviderConfig.ts
import { ProviderConfig } from './ProviderConfig';
import { Provider } from '../../types/Provider';
import { BaseProviderDescriptor, Credentials, CredentialCtx, ClientOptions } from './ProviderDescriptor';
import { IClient, FilteredModel } from '../interfaces/IClient';
import { ApiKeyValidationResult } from '../interfaces/ISettingsService';
import { AntLingClient, AntLingSessionConfig } from '../clients/AntLingClient';
import i18n from '../../locales';

export interface AntLingSettings {
  apiKey: string;
  customEndpoint: string;
  asrModel: string;
  chatModel: string;
  ttsModel: string;
  voice: string;
  sourceLanguage: string;
  targetLanguage: string;
  temperature: number;
  turnDetectionMode?: 'Auto' | 'Push-to-Talk' | 'Push-to-Translate';
}

export const defaultAntLingSettings: AntLingSettings = {
  apiKey: 'sk-studio-8e6cffe1bce9454cafde670c526822d4',
  customEndpoint: 'https://api.ant-ling.com/v1',
  asrModel: 'Ming-3.0-asr-tiny',
  chatModel: 'Ling-3.1-flash',
  ttsModel: 'Ming-3.0-tts-0.5B',
  voice: '灵小雅',
  sourceLanguage: 'auto',
  targetLanguage: 'zh',
  temperature: 0.2,
  turnDetectionMode: 'Auto',
};

export class AntLingProviderConfig extends BaseProviderDescriptor {
  readonly settingsSliceKey = 'antLing';
  readonly i18nKey = 'antLing';
  readonly supportsWebRTC = false;

  async extractCredentials(slice: unknown, _ctx: CredentialCtx): Promise<Credentials> {
    const s = slice as AntLingSettings;
    if (!s?.apiKey) {
      return { ok: false, missing: 'Ant-Ling API Key is required' };
    }
    return { ok: true, primary: s.apiKey, endpoint: s.customEndpoint || 'https://api.ant-ling.com/v1' };
  }

  createClient(creds: Credentials & { ok: true }, _options: ClientOptions): IClient {
    return new AntLingClient(creds.primary, creds.endpoint || 'https://api.ant-ling.com/v1');
  }

  async validateAndFetchModels(creds: Credentials): Promise<{
    validation: ApiKeyValidationResult;
    models: FilteredModel[];
  }> {
    if (!creds.ok) {
      return { validation: { valid: false, message: creds.missing, validating: false }, models: [] };
    }

    const host = (creds.endpoint || 'https://api.ant-ling.com/v1').replace(/\/+$/, '');
    const endpoint = host.endsWith('/v1') ? `${host}/models` : `${host}/v1/models`;

    try {
      let res: { ok: boolean; status: number; json: () => Promise<any> };

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        // In extension, proxy through background worker to guarantee CORS bypass with Ant-Ling Spanner gateway
        const bgRes = await new Promise<any>((resolve) => {
          try {
            chrome.runtime.sendMessage(
              {
                type: 'ANT_LING_FETCH',
                url: endpoint,
                options: {
                  headers: {
                    Authorization: `Bearer ${creds.primary}`,
                  },
                },
              },
              (response: any) => resolve(response)
            );
          } catch {
            resolve(null);
          }
        });

        if (bgRes && typeof bgRes.ok === 'boolean') {
          res = {
            ok: bgRes.ok,
            status: bgRes.status,
            json: async () => JSON.parse(bgRes.text || '{}'),
          };
        } else {
          res = await fetch(endpoint, {
            headers: {
              Authorization: `Bearer ${creds.primary}`,
            },
          });
        }
      } else {
        res = await fetch(endpoint, {
          headers: {
            Authorization: `Bearer ${creds.primary}`,
          },
        });
      }

      if (!res.ok) {
        return {
          validation: {
            valid: false,
            message: `API Key 验证失败 (${res.status})`,
            validating: false,
          },
          models: [],
        };
      }

      const data = await res.json();
      const modelsList = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);

      const filteredModels: FilteredModel[] = modelsList.map((m: any) => ({
        id: typeof m === 'string' ? m : (m.id || m.name),
        type: 'realtime' as const,
        created: m.created || Date.now(),
      }));

      // If no models returned from API, provide defaults
      if (filteredModels.length === 0) {
        filteredModels.push({
          id: 'Ling-3.1-flash',
          type: 'realtime' as const,
          created: Date.now(),
        });
      }

      return {
        validation: {
          valid: true,
          message: i18n.t('settings.apiKeyValidationCompleted', 'API Key 验证成功') + ` (灵动可用模型: ${filteredModels.length})`,
          validating: false,
          hasRealtimeModel: true,
        },
        models: filteredModels,
      };
    } catch (err: any) {
      return {
        validation: {
          valid: false,
          message: err.message || '网络连接失败',
          validating: false,
        },
        models: [],
      };
    }
  }

  buildSessionConfig(slice: unknown, systemInstructions: string): AntLingSessionConfig {
    const s = (slice as AntLingSettings) || defaultAntLingSettings;
    const targetBase = (s.targetLanguage || 'zh').split('-')[0].toLowerCase();
    let effectiveVoice = s.voice || '灵小雅';
    try {
      if (typeof localStorage !== 'undefined') {
        const storedVoices = localStorage.getItem('mao_speak_voices');
        if (storedVoices) {
          const map = JSON.parse(storedVoices);
          if (map[targetBase]) {
            effectiveVoice = map[targetBase].replace(/^(system|ming):/, '');
          }
        }
      }
    } catch {}

    return {
      provider: 'ant_ling',
      apiKey: s.apiKey,
      apiHost: s.customEndpoint,
      asrModel: s.asrModel || 'Ming-3.0-asr-tiny',
      chatModel: s.chatModel || 'Ling-3.1-flash',
      ttsModel: s.ttsModel || 'Ming-3.0-tts-0.5B',
      voice: effectiveVoice,
      instructions: systemInstructions,
      sourceLanguage: s.sourceLanguage || 'auto',
      targetLanguage: s.targetLanguage || 'zh',
      temperature: s.temperature ?? 0.2,
      turnDetectionMode: s.turnDetectionMode || 'Auto',
    };
  }

  latestRealtimeModel(models: FilteredModel[]): string {
    return 'Ming-3.0-audio-flash';
  }

  getConfig(): ProviderConfig {
    return {
      id: Provider.ANT_LING,
      displayName: 'Ant-Ling (灵动)',
      apiKeyLabel: 'Ant-Ling API Key',
      apiKeyPlaceholder: 'sk-studio-...',
      supportsCustomEndpoint: true,
      customEndpointLabel: 'API Endpoint',
      customEndpointPlaceholder: 'https://api.ant-ling.com/v1',
      languages: [
        { name: '自动识别 (Auto)', value: 'auto', englishName: 'Auto Detect' },
        { name: '中文 (Chinese)', value: 'zh', englishName: 'Chinese' },
        { name: '英语 (English)', value: 'en', englishName: 'English' },
        { name: '日语 (Japanese)', value: 'ja', englishName: 'Japanese' },
        { name: '韩语 (Korean)', value: 'ko', englishName: 'Korean' },
        { name: '法语 (French)', value: 'fr', englishName: 'French' },
        { name: '德语 (German)', value: 'de', englishName: 'German' },
        { name: '西班牙语 (Spanish)', value: 'es', englishName: 'Spanish' },
        { name: '俄语 (Russian)', value: 'ru', englishName: 'Russian' },
      ],
      voices: [
        { name: '灵小雅 (女声 · 清亮 · 中文)', value: '灵小雅' },
        { name: '灵小棠 (女声 · 温和 · 中文)', value: '灵小棠' },
        { name: '灵小锋 (男声 · 温暖 · 中文)', value: '灵小锋' },
        { name: '灵卓然 (男声 · 沉着 · 中文)', value: '灵卓然' },
        { name: '灵小萌 (女声 · 活泼 · 中文)', value: '灵小萌' },
        { name: '灵小曦 (女声 · 知性 · 中文)', value: '灵小曦' },
        { name: '灵小美 (女声 · 甜美 · 中文)', value: '灵小美' },
        { name: '灵志明 (男声 · 播音 · 中文)', value: '灵志明' },
        { name: '灵云逸 (男声 · 儒雅 · 中文)', value: '灵云逸' },
        { name: 'Emma (女声 · 美式 · 英语)', value: 'Emma' },
        { name: 'George (男声 · 英式 · 英语)', value: 'George' },
        { name: 'Charlotte (女声 · 英式 · 英语)', value: 'Charlotte' },
      ],
      models: [
        { id: 'Ling-3.1-flash', type: 'realtime' },
        { id: 'Ming-3.0-audio-flash', type: 'realtime' },
        { id: 'Ming-3.0-asr-tiny', type: 'realtime' },
      ],
      noiseReductionModes: ['None'],
      transcriptModels: ['Ming-3.0-asr-tiny'],
      capabilities: {
        hasTemplateMode: true,
        hasTurnDetection: true,
        hasVoiceSettings: true,
        hasNoiseReduction: false,
        hasModelConfiguration: true,
        textOnlyCapability: 'optional',
        turnDetection: {
          modes: ['Auto', 'Push-to-Talk', 'Push-to-Translate'],
          hasThreshold: false,
          hasPrefixPadding: false,
          hasSilenceDuration: false,
          hasSemanticEagerness: false,
        },
        temperatureRange: { min: 0, max: 1, step: 0.05 },
        maxTokensRange: { min: 64, max: 4096, step: 64 },
      },
    };
  }
}
