import { describe, expect, it } from 'vitest';
import {
  getSegmentationPreset,
  listConfiguredLanguages,
  resolveLanguageRule,
} from './languageRules';

describe('languageRules.json', () => {
  it('declares unit and min per language without engine code', () => {
    const en = resolveLanguageRule('en');
    const ja = resolveLanguageRule('ja');
    const zh = resolveLanguageRule('zh');
    expect(en.unit).toBe('words');
    expect(en.video.min).toBe(6);
    expect(en.video.preferredMin).toBe(12);
    expect(ja.unit).toBe('characters');
    expect(ja.video.min).toBe(15);
    expect(zh.unit).toBe('characters');
    expect(zh.video.min).toBe(8);
  });

  it('lets a new European language inherit English timings and add connectives', () => {
    const de = resolveLanguageRule('de');
    expect(de.unit).toBe('words');
    expect(de.hardIncomplete).toContain('und');
    expect(de.hardIncomplete).toContain('should');
    expect(de.video.min).toBe(6);
    expect(listConfiguredLanguages()).toEqual(
      expect.arrayContaining(['en', 'ja', 'zh', 'ko', 'de', 'fr', 'es', 'it', 'pt']),
    );
  });

  it('resolves aliases and script samples onto configured languages', () => {
    expect(resolveLanguageRule('japanese').id).toBe('ja');
    expect(resolveLanguageRule('zh-CN').id).toBe('zh');
    expect(resolveLanguageRule('korean').id).toBe('ko');
    expect(resolveLanguageRule('auto', 'こんにちは世界').id).toBe('ja');
    expect(resolveLanguageRule('auto', '안녕하세요').id).toBe('ko');
    expect(resolveLanguageRule('auto', '我觉得这个问题').id).toBe('zh');
  });

  it('maps meeting/video presets from the same config', () => {
    expect(getSegmentationPreset('video', 'en').minWords).toBe(6);
    expect(getSegmentationPreset('video', 'en').preferredMinWords).toBe(12);
    expect(getSegmentationPreset('video', 'en').softSilenceMs).toBe(650);
    expect(getSegmentationPreset('meeting', 'en').minWords).toBe(6);
    expect(getSegmentationPreset('video', 'ja').minCjkChars).toBe(15);
    expect(getSegmentationPreset('video', 'zh').minCjkChars).toBe(8);
    expect(getSegmentationPreset('video', 'ko').softSilenceMs).toBe(600);
  });
});
