import { beforeAll, describe, expect, it } from 'vitest';

describe('smart live-caption segmentation (kiss-inspired)', () => {
  let segmenter: {
    findSmartCaptionSplit: (
      text: string,
      options?: Record<string, number>,
    ) => { head: string; tail: string; reason: string } | null;
    joinCaptionText: (prefix: string, current: string) => string;
  };

  beforeAll(async () => {
    await import('../../../public/workers/caption-segmentation.js');
    segmenter = (globalThis as any).CaptionSegmentation;
  });

  it('breaks before a clause opener like the reference subtitle algorithm', () => {
    const result = segmenter.findSmartCaptionSplit(
      "RUPERT MURDOCH'S WALL STREET JOURNAL WITH AN EXPOSÉ TODAY REPORTING ON WHAT MANY SEE AS DONALD",
      { maxWords: 16 },
    );
    expect(result).toMatchObject({
      head: "RUPERT MURDOCH'S WALL STREET JOURNAL WITH AN EXPOSÉ TODAY REPORTING ON WHAT MANY SEE",
      tail: 'AS DONALD',
      reason: 'pause-word',
    });
  });

  it('prefers comma punctuation over a mechanical word boundary', () => {
    const result = segmenter.findSmartCaptionSplit(
      "AS DONALD TRUMP'S SHAKEDOWN OF AMERICAN BUSINESS, WHAT YOU SEE IN A KLEPTOCRACY OR SOMETIMES IN",
      { maxWords: 16 },
    );
    expect(result).toMatchObject({
      head: "AS DONALD TRUMP'S SHAKEDOWN OF AMERICAN BUSINESS,",
      tail: 'WHAT YOU SEE IN A KLEPTOCRACY OR SOMETIMES IN',
      reason: 'clause-punctuation',
    });
  });

  it('uses the hard cap only when no semantic boundary exists', () => {
    const words = Array.from({ length: 18 }, (_, index) => `word${index + 1}`);
    const result = segmenter.findSmartCaptionSplit(words.join(' '), { maxWords: 16 });
    expect(result).toMatchObject({
      head: words.slice(0, 16).join(' '),
      tail: words.slice(16).join(' '),
      reason: 'hard-limit',
    });
  });

  it('prefers Chinese punctuation and joins a carried CJK tail without spaces', () => {
    const result = segmenter.findSmartCaptionSplit(
      '这是需要认真说明的第一句话，接下来继续说明一个很重要的问题所以我们需要讨论后面的具体安排。',
      { maxChars: 24 },
    );
    expect(result?.head.endsWith('，')).toBe(true);
    expect(segmenter.joinCaptionText('接下来继续说明', '一个问题')).toBe('接下来继续说明一个问题');
  });

  it('early-splits on sentence punctuation before the hard word cap (kiss-style)', () => {
    // 10 words with a period mid-way — should cut at the sentence end without
    // waiting for maxWords=16.
    const result = segmenter.findSmartCaptionSplit(
      'Police arrived at the scene. Witnesses described a chaotic situation downtown near city hall today',
      { maxWords: 16, preferredWords: 8, minWords: 4, forcePunctuationMinWords: 4 },
    );
    expect(result).not.toBeNull();
    expect(result!.head).toMatch(/scene\.$/);
    expect(result!.tail.toLowerCase()).toMatch(/^witnesses/);
    expect(result!.reason).toBe('sentence-punctuation');
  });

  it('hard-cap prefers an earlier pause-word boundary over the far edge', () => {
    // 20 words; a "but" sits before the 16-word hard edge — cut before "but".
    const text = [
      'the', 'team', 'worked', 'late', 'into', 'the', 'night', 'on', 'the', 'release',
      'notes', 'but', 'nobody', 'could', 'finish', 'the', 'final', 'section', 'before', 'dawn',
    ].join(' ');
    const result = segmenter.findSmartCaptionSplit(text, { maxWords: 16, minWords: 5, preferredWords: 12 });
    expect(result).not.toBeNull();
    expect(result!.head.toLowerCase().endsWith('notes')).toBe(true);
    expect(result!.tail.toLowerCase().startsWith('but')).toBe(true);
    expect(result!.reason).toBe('pause-word');
  });

  it('does not soft-split weak "so" after a dangling preposition (MT-friendly)', () => {
    // Classic live-caption tear: "...britain for | so very long". Soft path must
    // wait — "for" is dangling and "so" is only a weak pause word.
    const text =
      'the two party system that has strangled and suffocated britain for so very long it was';
    const result = segmenter.findSmartCaptionSplit(text, {
      maxWords: 24,
      preferredWords: 18,
      minWords: 8,
    });
    // Under the hard cap: either null (keep growing) or a non-dangling head.
    if (result) {
      expect(result.head.toLowerCase().endsWith(' for')).toBe(false);
      expect(result.tail.toLowerCase().startsWith('so ')).toBe(false);
    }
  });

  it('soft-splits before strong discourse openers like however', () => {
    const text =
      'and despite everything i still treasure it today however now in twenty twenty six we are elsewhere';
    const result = segmenter.findSmartCaptionSplit(text, {
      maxWords: 24,
      preferredWords: 12,
      minWords: 6,
    });
    expect(result).not.toBeNull();
    expect(result!.tail.toLowerCase().startsWith('however')).toBe(true);
    expect(result!.reason).toBe('pause-word');
  });

  it('hard-cap refuses to end a cue on a dangling preposition', () => {
    // 18 words ending mid-PP inside the window; walk back past "for".
    const text = [
      'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
      'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'for', 'so', 'long',
    ].join(' ');
    const result = segmenter.findSmartCaptionSplit(text, { maxWords: 16, minWords: 5, preferredWords: 12 });
    expect(result).not.toBeNull();
    expect(result!.head.toLowerCase().endsWith(' for')).toBe(false);
  });
});
