import { describe, expect, it } from 'vitest';
import {
  getLanguageDisplayName,
  getLanguageOption,
  getLanguageShortName,
} from './languages';

describe('getLanguageDisplayName', () => {
  it('uses Chinese names for zh UI instead of native-script / raw codes', () => {
    expect(getLanguageDisplayName('en', 'zh_CN')).toBe('英语');
    expect(getLanguageDisplayName('ja', 'zh-CN')).toBe('日语');
    expect(getLanguageDisplayName('ko', 'zh-CN')).toBe('韩语');
    expect(getLanguageDisplayName('zh', 'zh-CN')).toBe('中文');
    expect(getLanguageDisplayName('es', 'zh-CN')).toBe('西班牙语');
  });

  it('does not show zh_CN / cantonese as raw codes', () => {
    expect(getLanguageDisplayName('zh_CN', 'zh-CN')).toBe('中文（简体）');
    expect(getLanguageDisplayName('zh-TW', 'zh-CN')).toBe('中文（繁体）');
    expect(getLanguageDisplayName('cantonese', 'zh-CN')).toBe('粤语');
    expect(getLanguageDisplayName('yue', 'zh-CN')).toBe('粤语');
    expect(getLanguageDisplayName('cmn-CN', 'zh-CN')).toBe('中文（简体）');
  });

  it('keeps English names when the UI language is English', () => {
    expect(getLanguageDisplayName('ja', 'en')).toBe('Japanese');
    expect(getLanguageDisplayName('zh', 'en')).toBe('Chinese');
    expect(getLanguageDisplayName('cantonese', 'en')).toBe('Cantonese');
    expect(getLanguageDisplayName('auto', 'en')).toBe('Auto Detect');
  });

  it('maps auto-detect', () => {
    expect(getLanguageDisplayName('auto', 'zh-CN')).toBe('自动检测');
  });
});

describe('getLanguageShortName', () => {
  it('uses Chinese short labels instead of slicing ISO codes', () => {
    expect(getLanguageShortName('en', 'zh-CN')).toBe('英');
    expect(getLanguageShortName('zh', 'zh-CN')).toBe('中');
    expect(getLanguageShortName('zh_CN', 'zh-CN')).toBe('中');
    expect(getLanguageShortName('ja', 'zh-CN')).toBe('日');
    expect(getLanguageShortName('cantonese', 'zh-CN')).toBe('粤');
  });

  it('does not turn cantonese into CA', () => {
    expect(getLanguageShortName('cantonese', 'en')).toBe('YUE');
    expect(getLanguageShortName('yue', 'en')).toBe('YUE');
  });
});

describe('getLanguageOption', () => {
  it('resolves regional aliases instead of echoing the raw code', () => {
    expect(getLanguageOption('zh_CN').englishName).toBe('Chinese');
    expect(getLanguageOption('en-US').englishName).toBe('English');
    expect(getLanguageOption('yue').value).toBe('cantonese');
  });
});
