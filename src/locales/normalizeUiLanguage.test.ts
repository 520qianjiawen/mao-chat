import { describe, expect, it } from 'vitest';
import { normalizeUiLanguage } from './index';

describe('normalizeUiLanguage', () => {
  it('maps browser Chinese codes onto catalog ids', () => {
    expect(normalizeUiLanguage('zh-CN')).toBe('zh_CN');
    expect(normalizeUiLanguage('zh')).toBe('zh_CN');
    expect(normalizeUiLanguage('zh-TW')).toBe('zh_TW');
    expect(normalizeUiLanguage('zh-HK')).toBe('zh_TW');
  });

  it('keeps supported catalog ids', () => {
    expect(normalizeUiLanguage('en')).toBe('en');
    expect(normalizeUiLanguage('ja')).toBe('ja');
    expect(normalizeUiLanguage('pt-BR')).toBe('pt_BR');
  });
});
