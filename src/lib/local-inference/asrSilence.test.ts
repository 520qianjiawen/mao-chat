import { describe, expect, it } from 'vitest';
import { cleanOfflineAsrText } from './asrSilence';

describe('cleanOfflineAsrText', () => {
  it('keeps real Japanese speech', () => {
    expect(cleanOfflineAsrText('今日はいい天気ですね')).toBe('今日はいい天気ですね');
  });

  it('drops SenseVoice tags and silence hallucinations', () => {
    expect(cleanOfflineAsrText('<|ja|><|NEUTRAL|><|nospeech|>')).toBe('');
    expect(cleanOfflineAsrText('えー')).toBe('えー');
    expect(cleanOfflineAsrText('えー', { dropFillers: true })).toBe('');
    expect(cleanOfflineAsrText('ご視聴ありがとうございました')).toBe('');
    expect(cleanOfflineAsrText('...')).toBe('');
  });
});
