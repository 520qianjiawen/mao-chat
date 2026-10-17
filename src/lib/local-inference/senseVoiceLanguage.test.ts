import { describe, expect, it } from 'vitest';
import { mapSenseVoiceLanguage } from './senseVoiceLanguage';

describe('mapSenseVoiceLanguage', () => {
  it('maps Japanese and Chinese variants onto SenseVoice tokens', () => {
    expect(mapSenseVoiceLanguage('ja')).toBe('ja');
    expect(mapSenseVoiceLanguage('ja-JP')).toBe('ja');
    expect(mapSenseVoiceLanguage('zh-CN')).toBe('zh');
    expect(mapSenseVoiceLanguage('cantonese')).toBe('yue');
  });

  it('falls back to auto when the UI language is unset or unsupported', () => {
    expect(mapSenseVoiceLanguage(undefined)).toBe('auto');
    expect(mapSenseVoiceLanguage('auto')).toBe('auto');
    expect(mapSenseVoiceLanguage('fr')).toBe('auto');
  });
});
