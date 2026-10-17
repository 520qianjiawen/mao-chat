/**
 * OpenAI Translate source language is auto-detected by the API. The
 * extension copy tells users they can pick “自动检测”, so the dropdown
 * must include that option and persist it on the translate slice.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

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
const { Provider } = await import('../../../types/Provider');
const { default: LanguageSection } = await import('./LanguageSection');

describe('LanguageSection — OpenAI Translate auto-detect', () => {
  beforeEach(() => {
    useSettingsStore.setState((state: any) => ({
      provider: Provider.OPENAI_TRANSLATE,
      openaiTranslate: {
        ...state.openaiTranslate,
        sourceLanguage: 'en',
        targetLanguage: 'zh',
      },
    }));
  });

  it('offers Auto Detect for the video/source language', () => {
    render(
      <LanguageSection
        isSessionActive={false}
        showInterfaceLanguage={false}
        showTranslationLanguages
      />,
    );

    expect(screen.getByRole('option', { name: 'common.autoDetect' })).toBeTruthy();
  });

  it('writes auto to the openaiTranslate slice', () => {
    render(
      <LanguageSection
        isSessionActive={false}
        showInterfaceLanguage={false}
        showTranslationLanguages
      />,
    );

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'auto' } });
    expect(useSettingsStore.getState().openaiTranslate.sourceLanguage).toBe('auto');
  });
});
