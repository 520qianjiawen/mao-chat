import { describe, expect, it } from 'vitest';
import { transcriptLooksForeign } from './transcriptScript';

describe('transcriptLooksForeign', () => {
  it('rejects English when the speaker language is Chinese', () => {
    expect(transcriptLooksForeign('Hello. How are you?', 'zh')).toBe(true);
    expect(transcriptLooksForeign('The.', 'zh-CN')).toBe(true);
  });

  it('keeps Chinese when the speaker language is Chinese', () => {
    expect(transcriptLooksForeign('你好吗', 'zh')).toBe(false);
    expect(transcriptLooksForeign('Hello 你好', 'zh')).toBe(false);
  });

  it('rejects Chinese when the speaker language is English', () => {
    expect(transcriptLooksForeign('你好吗', 'en')).toBe(true);
  });

  it('ignores empty text and unknown languages', () => {
    expect(transcriptLooksForeign('', 'zh')).toBe(false);
    expect(transcriptLooksForeign('Hello', 'ar')).toBe(false);
  });
});
