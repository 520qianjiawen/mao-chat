import { describe, expect, it } from 'vitest';
import {
  EXTENSION_OFFLINE_CAPTION_MAX_SPEECH_S,
  EXTENSION_OFFLINE_CAPTION_MIN_SILENCE_S,
  extensionOfflineVadOverrides,
} from './offlineCaptionVad';

describe('extensionOfflineVadOverrides', () => {
  it('caps silence and speech so Japanese offline ASR does not wait 12s', () => {
    const vad = extensionOfflineVadOverrides(1.4);
    expect(vad.minSilenceDuration).toBe(EXTENSION_OFFLINE_CAPTION_MIN_SILENCE_S);
    expect(vad.maxSpeechDuration).toBe(EXTENSION_OFFLINE_CAPTION_MAX_SPEECH_S);
    expect(vad.maxSpeechDuration).toBeLessThan(5);
  });
});
