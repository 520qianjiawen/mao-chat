import { describe, expect, it } from 'vitest';
import { Provider } from '../../types/Provider';
import { shouldKeepCapturedAudioDirection } from './participantDirection';

describe('shouldKeepCapturedAudioDirection', () => {
  it('keeps source -> subtitle direction for macOS system audio', () => {
    expect(shouldKeepCapturedAudioDirection(
      Provider.LOCAL_NATIVE,
      'participant',
      { electron: true, extension: false },
    )).toBe(true);
  });

  it('keeps source -> subtitle direction for current-tab audio', () => {
    expect(shouldKeepCapturedAudioDirection(
      Provider.LOCAL_INFERENCE,
      'participant',
      { electron: false, extension: true },
    )).toBe(true);
  });

  it('retains meeting reversal for non-media local web sessions', () => {
    expect(shouldKeepCapturedAudioDirection(
      Provider.LOCAL_INFERENCE,
      'both',
      { electron: false, extension: false },
    )).toBe(false);
  });

  it('Others keeps source → target for every provider', () => {
    expect(shouldKeepCapturedAudioDirection(
      Provider.OPENAI,
      'participant',
      { electron: true, extension: false },
    )).toBe(true);
  });

  it('keeps source -> subtitle direction for OpenAI Translate tab audio', () => {
    expect(shouldKeepCapturedAudioDirection(
      Provider.OPENAI_TRANSLATE,
      'participant',
      { electron: false, extension: true },
    )).toBe(true);
  });

  it('still reverses OpenAI Translate in a meeting Both session', () => {
    expect(shouldKeepCapturedAudioDirection(
      Provider.OPENAI_TRANSLATE,
      'both',
      { electron: false, extension: true },
    )).toBe(false);
  });

  it('still reverses Local Native in a meeting Both session', () => {
    expect(shouldKeepCapturedAudioDirection(
      Provider.LOCAL_NATIVE,
      'both',
      { electron: true, extension: false },
    )).toBe(false);
  });

  it('still reverses Local Inference in a meeting Both session on desktop', () => {
    expect(shouldKeepCapturedAudioDirection(
      Provider.LOCAL_INFERENCE,
      'both',
      { electron: true, extension: false },
    )).toBe(false);
  });
});
