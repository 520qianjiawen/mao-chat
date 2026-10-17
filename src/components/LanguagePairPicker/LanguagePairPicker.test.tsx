import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (_k: string, def?: string) => def ?? _k,
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('../../lib/analytics', () => ({
  useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock('../../services/ServiceFactory', () => ({
  ServiceFactory: {
    getSettingsService: () => ({
      getSetting: async (_k: string, d: unknown) => d,
      setSetting: async () => undefined,
    }),
  },
}));

const { default: useSettingsStore } = await import('../../stores/settingsStore');
const { Provider } = await import('../../types/Provider');
const { default: LanguagePairPicker } = await import('./LanguagePairPicker');

describe('LanguagePairPicker', () => {
  beforeEach(() => {
    useSettingsStore.setState((s: any) => ({
      provider: Provider.SONIOX,
      soniox: { ...s.soniox, apiKey: '', sourceLanguage: 'auto', targetLanguage: 'en' },
    }));
  });

  it('changes source and target languages without opening settings', () => {
    render(<LanguagePairPicker showSettingsButton={false} />);
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'zh' } });
    fireEvent.change(selects[1], { target: { value: 'ja' } });
    expect(useSettingsStore.getState().soniox.sourceLanguage).toBe('zh');
    expect(useSettingsStore.getState().soniox.targetLanguage).toBe('ja');
  });

  it('swaps the pair from the on-page control', () => {
    useSettingsStore.setState((s: any) => ({
      soniox: { ...s.soniox, sourceLanguage: 'zh', targetLanguage: 'en' },
    }));
    render(<LanguagePairPicker showSettingsButton={false} />);
    fireEvent.click(screen.getByRole('button', { name: '交换左右语言' }));
    expect(useSettingsStore.getState().soniox.sourceLanguage).toBe('en');
    expect(useSettingsStore.getState().soniox.targetLanguage).toBe('zh');
  });

  it('swaps even when the left side is auto-detect', () => {
    render(<LanguagePairPicker showSettingsButton={false} />);
    fireEvent.click(screen.getByRole('button', { name: '交换左右语言' }));
    expect(useSettingsStore.getState().soniox.sourceLanguage).toBe('en');
    expect(useSettingsStore.getState().soniox.targetLanguage).not.toBe('en');
  });
});
