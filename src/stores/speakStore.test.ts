// src/stores/speakStore.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSpeakStore, getVoiceOptionsForLanguage, SUPPORTED_SPEAK_LANGUAGES } from './speakStore';

describe('speakStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useSpeakStore.setState({
      speakShortcut: 'RightOption',
      speakTo: 'room',
      speakVoices: {
        en: 'ming:US_Emma',
        zh: 'ming:灵小雅',
        ja: 'ming:US_Emma',
        ko: 'ming:US_Emma',
      },
      voiceClone: null,
      previewingVoiceId: null,
      activeLanguageTab: 'en',
    });
  });

  it('provides voice options for supported languages', () => {
    const enVoices = getVoiceOptionsForLanguage('en');
    expect(enVoices.length).toBeGreaterThan(0);
    expect(enVoices.some((v) => v.name === 'Emma')).toBe(true);
    expect(enVoices.some((v) => v.name === 'George')).toBe(true);
    expect(enVoices.some((v) => v.name === 'Samantha')).toBe(true);

    const zhVoices = getVoiceOptionsForLanguage('zh');
    expect(zhVoices.some((v) => v.name === '小雅')).toBe(true);
    expect(zhVoices.some((v) => v.name === '小锋')).toBe(true);
  });

  it('updates speak shortcut and persists to localStorage', () => {
    useSpeakStore.getState().setSpeakShortcut('Space');
    expect(useSpeakStore.getState().speakShortcut).toBe('Space');
    expect(localStorage.getItem('mao_speak_shortcut')).toBe('Space');
  });

  it('updates speakTo target language', () => {
    useSpeakStore.getState().setSpeakTo('ja');
    expect(useSpeakStore.getState().speakTo).toBe('ja');
    expect(localStorage.getItem('mao_speak_to')).toBe('ja');
  });

  it('updates voice for a specific language', () => {
    useSpeakStore.getState().setVoiceForLanguage('en', 'ming:UK_George');
    expect(useSpeakStore.getState().speakVoices.en).toBe('ming:UK_George');
  });

  it('manages voice clone lifecycle', () => {
    useSpeakStore.getState().setVoiceClone({
      durationSeconds: 15,
      recordedText: 'Hello world',
      createdAt: Date.now(),
      audioBlobUrl: 'blob:test',
    });
    expect(useSpeakStore.getState().voiceClone?.durationSeconds).toBe(15);

    // Set voice to clone
    useSpeakStore.getState().setVoiceForLanguage('en', 'clone');
    expect(useSpeakStore.getState().speakVoices.en).toBe('clone');

    // Delete clone resets voice
    useSpeakStore.getState().deleteVoiceClone();
    expect(useSpeakStore.getState().voiceClone).toBeNull();
    expect(useSpeakStore.getState().speakVoices.en).not.toBe('clone');
  });
});
