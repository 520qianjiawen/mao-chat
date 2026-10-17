import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key,
      i18n: { language: 'zh_CN' },
    }),
  };
});

vi.mock('../../../lib/analytics', () => ({
  useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock('../../../services/ServiceFactory', () => ({
  ServiceFactory: {
    getSettingsService: () => ({
      getSetting: async (_key: string, fallback: unknown) => fallback,
      setSetting: async () => undefined,
    }),
  },
}));

const { default: useSettingsStore } = await import('../../../stores/settingsStore');
const { useModelStore } = await import('../../../stores/modelStore');
const { Provider } = await import('../../../types/Provider');
const { default: LanguageSection } = await import('./LanguageSection');

describe('LanguageSection — online translation readiness', () => {
  beforeEach(() => {
    useSettingsStore.setState((state: any) => ({
      provider: Provider.LOCAL_INFERENCE,
      textOnly: true,
      localInference: {
        ...state.localInference,
        sourceLanguage: 'zh',
        targetLanguage: 'en',
        asrModel: 'stream-zh-int8',
        translationModel: 'bing-translator',
        ttsModel: 'edge-tts',
      },
    }));
    useModelStore.setState({
      initialized: true,
      modelStatuses: {
        'stream-zh-int8': 'downloaded',
        'bing-translator': 'not_downloaded',
      },
    });
  });

  it('does not show a missing-translation warning for a compatible cloud model', () => {
    const { container } = render(
      <LanguageSection
        isSessionActive={false}
        showInterfaceLanguage={false}
        showTranslationLanguages
      />,
    );

    expect(container.querySelector('.language-model-warning')).toBeNull();
  });
});
