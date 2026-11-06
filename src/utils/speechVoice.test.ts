// src/utils/speechVoice.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isNaturalVoice, getBestSpeechVoice, speakText, stopSpeaking } from './speechVoice';

describe('speechVoice', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('filters out forbidden novelty and eloquence voices', () => {
    const albert = { name: 'Albert', lang: 'en-US', voiceURI: 'com.apple.speech.synthesis.voice.Albert' } as SpeechSynthesisVoice;
    const fred = { name: 'Fred', lang: 'en-US', voiceURI: 'com.apple.speech.synthesis.voice.Fred' } as SpeechSynthesisVoice;
    const eddy = { name: 'Eddy', lang: 'en-US', voiceURI: 'com.apple.eloquence.en-US.Eddy' } as SpeechSynthesisVoice;
    const zarvox = { name: 'Zarvox', lang: 'en-US', voiceURI: 'com.apple.speech.synthesis.voice.Zarvox' } as SpeechSynthesisVoice;
    const samantha = { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' } as SpeechSynthesisVoice;
    const daniel = { name: 'Daniel', lang: 'en-GB', voiceURI: 'com.apple.voice.compact.en-GB.Daniel' } as SpeechSynthesisVoice;

    expect(isNaturalVoice(albert)).toBe(false);
    expect(isNaturalVoice(fred)).toBe(false);
    expect(isNaturalVoice(eddy)).toBe(false);
    expect(isNaturalVoice(zarvox)).toBe(false);
    expect(isNaturalVoice(samantha)).toBe(true);
    expect(isNaturalVoice(daniel)).toBe(true);
  });

  it('selects Samantha or best natural voice for English instead of Albert', async () => {
    const mockVoices = [
      { name: 'Albert', lang: 'en-US', voiceURI: 'com.apple.speech.synthesis.voice.Albert' },
      { name: 'Bad News', lang: 'en-US', voiceURI: 'com.apple.speech.synthesis.voice.BadNews' },
      { name: 'Daniel', lang: 'en-GB', voiceURI: 'com.apple.voice.compact.en-GB.Daniel' },
      { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' },
      { name: 'Tingting', lang: 'zh-CN', voiceURI: 'com.apple.voice.compact.zh-CN.Tingting' },
    ] as SpeechSynthesisVoice[];

    (window as any).speechSynthesis = {
      getVoices: () => mockVoices,
      speak: vi.fn(),
      cancel: vi.fn(),
    };

    const bestEn = await getBestSpeechVoice('en');
    expect(bestEn).toBeDefined();
    expect(bestEn?.name).toBe('Samantha');

    const bestZh = await getBestSpeechVoice('zh');
    expect(bestZh).toBeDefined();
    expect(bestZh?.name).toBe('Tingting');
  });

  it('maps Ming voice names to their natural system voice counterparts', async () => {
    const mockVoices = [
      { name: 'Albert', lang: 'en-US', voiceURI: 'com.apple.speech.synthesis.voice.Albert' },
      { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' },
    ] as SpeechSynthesisVoice[];

    (window as any).speechSynthesis = {
      getVoices: () => mockVoices,
      speak: vi.fn(),
      cancel: vi.fn(),
    };

    const voice = await getBestSpeechVoice('en', 'ming:US_Emma');
    expect(voice?.name).toBe('Samantha');
  });

  it('speaks text with natural voice and cancels prior utterances', async () => {
    class MockUtterance {
      text: string;
      lang = '';
      rate = 1.0;
      pitch = 1.0;
      volume = 1.0;
      voice: any = null;
      onend: any = null;
      onerror: any = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    (globalThis as any).SpeechSynthesisUtterance = MockUtterance;

    const cancelMock = vi.fn();
    let spokenUtterance: any = null;
    const speakMock = vi.fn((u) => {
      spokenUtterance = u;
    });

    const mockVoices = [
      { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' },
    ] as SpeechSynthesisVoice[];

    (window as any).speechSynthesis = {
      getVoices: () => mockVoices,
      speak: speakMock,
      cancel: cancelMock,
    };

    const result = await speakText('Hello world', 'en');
    expect(result).toBe(true);
    expect(cancelMock).toHaveBeenCalled();
    expect(speakMock).toHaveBeenCalled();
    expect(spokenUtterance?.voice?.name).toBe('Samantha');
    expect(spokenUtterance?.rate).toBe(1.0);
    expect(spokenUtterance?.pitch).toBe(1.0);
  });

  it('uses native speak-local-audio IPC when running in Electron', async () => {
    const invokeMock = vi.fn().mockResolvedValue({ ok: true });
    (window as any).electron = { invoke: invokeMock };

    const endMock = vi.fn();
    const result = await speakText('Hello Electron', 'en', { onEnd: endMock });
    expect(result).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('speak-local-audio', {
      text: 'Hello Electron',
      lang: 'en',
      voice: 'Samantha',
    });
    expect(endMock).toHaveBeenCalled();

    delete (window as any).electron;
  });
});
