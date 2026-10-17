import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../../utils/environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/environment')>();
  return {
    ...actual,
    isElectron: () => true,
    isExtension: () => false,
    isLocalNativeEnabled: () => true,
  };
});

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
    Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('../../../lib/analytics', () => ({
  useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock('../../../lib/auth/hooks', () => ({
  useAuth: () => ({ isSignedIn: false, getToken: undefined }),
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
const { useNativeModelStore } = await import('../../../stores/nativeModelStore');
const { Provider } = await import('../../../types/Provider');
const { default: ProviderSection } = await import('./ProviderSection');

describe('ProviderSection — native online translation summary', () => {
  beforeEach(() => {
    useSettingsStore.setState((state: any) => ({
      provider: Provider.LOCAL_NATIVE,
      localNative: {
        ...state.localNative,
        sourceLanguage: 'ja',
        targetLanguage: 'zh',
        asrModel: 'sherpa-zipformer-multi-8lang',
        translationModel: 'google-translator',
        ttsModel: '',
      },
    }));
    useNativeModelStore.setState({
      sidecarStatus: 'ready',
      catalog: {},
      statuses: {},
    });
  });

  it('shows Google as selected even though online translators have no download status', () => {
    render(<ProviderSection isSessionActive={false} />);

    expect(screen.getByText('Google Translator (Online)')).toHaveClass('model-ok');
  });

  it('shows Bing as selected under the same no-download rule', () => {
    useSettingsStore.setState((state: any) => ({
      localNative: { ...state.localNative, translationModel: 'bing-translator' },
    }));

    render(<ProviderSection isSessionActive={false} />);

    expect(screen.getByText('Bing Translator (Online)')).toHaveClass('model-ok');
  });
});
