import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SentenceSegmenter,
  getSegmentationPreset,
  isChineseIncomplete,
  isFillerOnly,
  isIncompleteEnding,
  isJapaneseComplete,
  isJapaneseConnectiveEnding,
  isJapaneseIncomplete,
  isKoreanComplete,
  isKoreanIncomplete,
  joinUtterance,
  normalizeSegmentationMode,
  shouldTranslatePending,
} from './sentenceSegmenter';

describe('sentence helpers', () => {
  it('treats ASR finals as joinable rather than replacements when they do not overlap', () => {
    expect(joinUtterance('there is something', 'we need to discuss')).toBe(
      'there is something we need to discuss',
    );
    expect(joinUtterance('there is', 'there is something')).toBe('there is something');
    expect(joinUtterance('接下来继续说明', '一个问题')).toBe('接下来继续说明一个问题');
    expect(joinUtterance('旅行を連れて。', '来てもらって文句ばっかり。')).toBe(
      '旅行を連れて来てもらって文句ばっかり。',
    );
    expect(joinUtterance('I think.', 'we should consider this option')).toBe(
      'I think we should consider this option',
    );
    expect(joinUtterance(
      'Regional officials say For now, the Navy.',
      'the naval blockade and economic pressure will continue.',
    )).toMatch(/the naval blockade and economic pressure will continue/i);
    expect(joinUtterance(
      'Regional officials say For now, the Navy.',
      'the naval blockade and economic pressure will continue.',
    )).not.toMatch(/navy the naval/i);
    expect(joinUtterance('我觉得。', '这个问题需要进一步讨论。')).toBe(
      '我觉得这个问题需要进一步讨论。',
    );
    expect(joinUtterance('旅行を連れて。', '旅行を連れてきてもらって文句ばっかり')).toBe(
      '旅行を連れてきてもらって文句ばっかり',
    );
  });

  it('blocks commit on incomplete endings and fillers', () => {
    expect(isIncompleteEnding('maybe we should')).toBe(true);
    expect(isIncompleteEnding('because of the')).toBe(true);
    expect(isIncompleteEnding('even though')).toBe(true);
    expect(isIncompleteEnding('the helipad this afternoon, including')).toBe(true);
    expect(isIncompleteEnding('the situation right now is, quote,')).toBe(true);
    expect(isIncompleteEnding('according to')).toBe(true);
    expect(isIncompleteEnding('the president is going to')).toBe(true);
    expect(isIncompleteEnding('this afternoon,')).toBe(true);
    expect(isIncompleteEnding('the United States and our allies by.')).toBe(true);
    expect(isIncompleteEnding('We should consider another option.')).toBe(false);
    expect(isIncompleteEnding('I think so')).toBe(true);
    expect(isIncompleteEnding('I think so', { hard: true })).toBe(false);
    expect(isIncompleteEnding('there is something')).toBe(false);
    expect(isIncompleteEnding('We should consider another option.')).toBe(false);
    expect(isIncompleteEnding('wir müssen und', { language: 'de' })).toBe(true);
    expect(isIncompleteEnding('nous devons et', { language: 'fr' })).toBe(true);
    expect(isIncompleteEnding('creo que pero', { language: 'es' })).toBe(true);
    expect(isIncompleteEnding('viene da', { language: 'it' })).toBe(true);
    expect(isIncompleteEnding('falamos de', { language: 'pt' })).toBe(true);
    expect(isFillerOnly('uh')).toBe(true);
    expect(isFillerOnly('you know')).toBe(true);
    expect(isFillerOnly('well')).toBe(true);
    expect(isFillerOnly('I think')).toBe(false);
  });

  it('normalizes unknown modes to meeting', () => {
    expect(normalizeSegmentationMode('video')).toBe('video');
    expect(normalizeSegmentationMode('nope')).toBe('meeting');
  });

  it('uses Japanese predicates, particles, and fillers instead of word count', () => {
    expect(isJapaneseComplete('この問題について説明します')).toBe(true);
    expect(isJapaneseComplete('発表しました。')).toBe(true);
    expect(isJapaneseComplete('こんにちは')).toBe(true);
    expect(isJapaneseComplete('この問題について')).toBe(false);
    expect(isJapaneseComplete('旅行を連れて。')).toBe(false);
    expect(isJapaneseComplete('来てもらって。')).toBe(false);
    expect(isJapaneseComplete('来てもらって文句ばっかり。')).toBe(false);
    expect(isJapaneseComplete('やっぱり言わないの。')).toBe(false);
    expect(isJapaneseIncomplete('これは')).toBe(true);
    expect(isJapaneseIncomplete('現在政府は')).toBe(true);
    expect(isJapaneseIncomplete('新しい政策を')).toBe(true);
    expect(isJapaneseIncomplete('しかし')).toBe(true);
    expect(isJapaneseIncomplete('旅行を連れて。')).toBe(true);
    expect(isJapaneseIncomplete('来てもらって。')).toBe(true);
    expect(isJapaneseIncomplete('やっぱり言わないの。')).toBe(true);
    expect(isJapaneseIncomplete('この問題について説明します')).toBe(false);
    expect(isJapaneseConnectiveEnding('旅行を連れて。')).toBe(true);
    expect(isJapaneseConnectiveEnding('来てもらって。')).toBe(true);
    expect(isFillerOnly('えっと', 'ja')).toBe(true);
    expect(isFillerOnly('あの', 'ja')).toBe(true);
    expect(isFillerOnly('その問題について説明します', 'ja')).toBe(false);
    expect(shouldTranslatePending('現在政府は', 'ja')).toBe(false);
    expect(shouldTranslatePending('現在政府は新しい政策を発表しました', 'ja')).toBe(false);
    expect(shouldTranslatePending('この問題について説明します', 'ja')).toBe(false);
    expect(shouldTranslatePending('I think we should consider this option')).toBe(false);
    expect(shouldTranslatePending('我觉得这个问题需要进一步讨论', 'zh')).toBe(false);
    expect(shouldTranslatePending('이 문제를 설명합니다', 'ko')).toBe(false);
  });

  it('uses Chinese character count, punctuation, and incomplete suffixes', () => {
    expect(isChineseIncomplete('因为')).toBe(true);
    expect(isChineseIncomplete('所以')).toBe(true);
    expect(isChineseIncomplete('如果')).toBe(true);
    expect(isChineseIncomplete('我和')).toBe(true);
    expect(isChineseIncomplete('新的')).toBe(true);
    expect(isChineseIncomplete('新的', { hard: true })).toBe(false);
    expect(isChineseIncomplete('我觉得这个问题需要进一步讨论')).toBe(false);
    const video = getSegmentationPreset('video', 'zh');
    expect(video.softSilenceMs).toBe(500);
    expect(video.hardSilenceMs).toBe(1000);
    expect(video.minCjkChars).toBe(8);
  });

  it('uses Korean particles and predicate endings instead of word count', () => {
    expect(isKoreanIncomplete('저는')).toBe(true);
    expect(isKoreanIncomplete('학교가')).toBe(true);
    expect(isKoreanIncomplete('이것을')).toBe(true);
    expect(isKoreanIncomplete('학교에서')).toBe(true);
    expect(isKoreanIncomplete('가고')).toBe(true);
    expect(isKoreanIncomplete('했지만')).toBe(true);
    expect(isKoreanComplete('설명합니다')).toBe(true);
    expect(isKoreanComplete('좋습니다')).toBe(true);
    expect(isKoreanComplete('좋아요')).toBe(true);
    expect(isKoreanComplete('저는')).toBe(false);
    const video = getSegmentationPreset('video', 'ko');
    expect(video.softSilenceMs).toBe(600);
    expect(video.hardSilenceMs).toBe(1200);
    expect(video.minCjkChars).toBe(12);
  });

  it('uses English meeting/video word floors from the spec', () => {
    expect(getSegmentationPreset('meeting', 'en').minWords).toBe(6);
    expect(getSegmentationPreset('meeting', 'en').softSilenceMs).toBe(700);
    expect(getSegmentationPreset('meeting', 'en').hardSilenceMs).toBe(1200);
    expect(getSegmentationPreset('video', 'en').minWords).toBe(6);
    expect(getSegmentationPreset('video', 'en').preferredMinWords).toBe(12);
    expect(getSegmentationPreset('video', 'en').softSilenceMs).toBe(650);
    expect(getSegmentationPreset('video', 'en').hardSilenceMs).toBe(1200);
    expect(getSegmentationPreset('video', 'en').forceDurationMs).toBe(10000);
  });

  it('uses an 800ms floor and 15-character minimum for Japanese video', () => {
    const preset = getSegmentationPreset('video', 'ja');
    expect(preset.minCommitDelayMs).toBe(800);
    expect(preset.softSilenceMs).toBe(700);
    expect(preset.hardSilenceMs).toBe(1200);
    expect(preset.minCjkChars).toBe(15);
  });
});

describe('SentenceSegmenter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function make(mode: 'meeting' | 'video' = 'meeting') {
    const pending: string[] = [];
    const commits: Array<{ text: string; reason: string }> = [];
    const segmenter = new SentenceSegmenter({
      mode,
      onPending: (text) => pending.push(text),
      onCommit: (text, reason) => commits.push({ text, reason }),
    });
    return { segmenter, pending, commits };
  }

  it('does not re-commit a rolling ASR window that overlaps already committed text', async () => {
    const { segmenter, commits } = make('meeting');
    const first = 'the speaker explained the next chapter today';
    segmenter.ingestFinal(first);
    await vi.advanceTimersByTimeAsync(700);
    expect(commits.map((c) => c.text)).toEqual([first]);

    segmenter.ingestFinal(first);
    expect(commits).toHaveLength(1);
    expect(segmenter.getPending()).toBe('');

    segmenter.ingestFinal(`${first} after that`);
    expect(commits).toHaveLength(1);
    expect(segmenter.getPending()).toBe('after that');
    segmenter.flush();
    expect(commits.map((c) => c.text)).toEqual([first, 'after that']);
  });

  it('drops an ASR final whose audio span is already committed', () => {
    const { segmenter, commits } = make('meeting');
    segmenter.ingestFinal('hello world today everyone', { startSample: 0, durationMs: 1000 });
    segmenter.flush();
    expect(commits[0]?.text).toBe('hello world today everyone');
    segmenter.ingestFinal('a totally new sentence about weather today', { startSample: 16000, durationMs: 500 });
    expect(segmenter.getPending()).toContain('weather');
    segmenter.ingestFinal('hello world today everyone', { startSample: 2000, durationMs: 400 });
    expect(commits).toHaveLength(1);
  });

  it('keeps showing new English after a commit even if ASR still reports startSample 0', () => {
    const { segmenter, commits } = make('video');
    segmenter.setLanguage('en');
    segmenter.ingestFinal('the speaker explained the next chapter today after lunch ended well', {
      startSample: 0,
      durationMs: 2000,
    });
    segmenter.flush();
    expect(commits).toHaveLength(1);
    segmenter.ingestPartial('and then the weather turned suddenly colder than before');
    expect(segmenter.getPending().toLowerCase()).toContain('weather');
  });

  it('does not treat an ASR final as a translation commit', () => {
    const { segmenter, commits } = make();
    segmenter.ingestFinal('there is something');
    expect(commits).toEqual([]);
    expect(segmenter.getPending()).toBe('there is something');
  });

  it('holds a 3-word fragment through soft and hard silence in meeting mode', async () => {
    const { segmenter, commits } = make('meeting');
    segmenter.ingestFinal('there is something');
    await vi.advanceTimersByTimeAsync(1200);
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(commits).toEqual([
      { text: 'there is something', reason: 'short-hold' },
    ]);
  });

  it('joins a continuation that arrives before the hold expires', async () => {
    const { segmenter, commits } = make('meeting');
    segmenter.ingestFinal('there is something');
    await vi.advanceTimersByTimeAsync(800);
    segmenter.ingestFinal('we need to discuss another option');
    expect(segmenter.getPending()).toBe('there is something we need to discuss another option');
    await vi.advanceTimersByTimeAsync(700);
    expect(commits).toEqual([
      {
        text: 'there is something we need to discuss another option',
        reason: 'soft-silence',
      },
    ]);
  });

  it('commits a complete meeting phrase after soft silence', async () => {
    const { segmenter, commits } = make('meeting');
    segmenter.ingestFinal('maybe we should consider another option');
    await vi.advanceTimersByTimeAsync(700);
    expect(commits).toEqual([
      { text: 'maybe we should consider another option', reason: 'soft-silence' },
    ]);
  });

  it('does not commit on an incomplete ending even after hard silence', async () => {
    const { segmenter, commits } = make('meeting');
    segmenter.ingestFinal('maybe we should');
    await vi.advanceTimersByTimeAsync(2000);
    expect(commits).toEqual([]);
    expect(segmenter.getPending()).toBe('maybe we should');
  });

  it('commits immediately on clear sentence punctuation', () => {
    const { segmenter, commits } = make('meeting');
    segmenter.ingestFinal('I think we should consider another option.');
    expect(commits).toEqual([
      { text: 'I think we should consider another option.', reason: 'punctuation' },
    ]);
    expect(segmenter.getPending()).toBe('');
  });

  it('commits the finished sentence and keeps the tail', () => {
    const { segmenter, commits } = make('video');
    segmenter.ingestFinal('Police arrived at the scene. Witnesses described a chaotic situation');
    expect(commits).toEqual([
      { text: 'Police arrived at the scene.', reason: 'punctuation' },
    ]);
    expect(segmenter.getPending()).toBe('Witnesses described a chaotic situation');
  });

  it('does not let fillers alone trigger a commit', async () => {
    const { segmenter, commits } = make('meeting');
    segmenter.ingestFinal('uh');
    await vi.advanceTimersByTimeAsync(3000);
    expect(commits).toEqual([]);
    segmenter.ingestFinal('maybe we should consider another option');
    expect(segmenter.getPending()).toMatch(/maybe we should consider another option/);
  });

  it('cancels silence when a partial continues the utterance', async () => {
    const { segmenter, commits } = make('video');
    segmenter.ingestFinal('the speaker explained the next chapter');
    segmenter.ingestPartial('the speaker explained the next chapter in detail');
    await vi.advanceTimersByTimeAsync(900);
    expect(commits).toEqual([]);
    expect(segmenter.getPending()).toBe('the speaker explained the next chapter in detail');
  });

  it('video mode waits for a longer complete clause than a short ASR final', async () => {
    const meeting = make('meeting');
    const video = make('video');
    const phrase = 'the speaker explained the next chapter today after the meeting ended successfully';
    meeting.segmenter.ingestFinal(phrase);
    video.segmenter.ingestFinal(phrase);
    await vi.advanceTimersByTimeAsync(650);
    expect(video.commits).toEqual([{ text: phrase, reason: 'soft-silence' }]);
    expect(meeting.commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(meeting.commits).toEqual([{ text: phrase, reason: 'soft-silence' }]);
  });

  it('force-splits a run-on at a clause opener instead of a fixed word count', async () => {
    const { segmenter, commits } = make('video');
    const words = [
      'the', 'team', 'worked', 'late', 'into', 'the', 'night', 'on', 'the', 'release',
      'notes', 'but', 'nobody', 'could', 'finish', 'the', 'final', 'section', 'before',
      'dawn', 'today', 'after', 'everything', 'else', 'happened', 'outside',
    ];
    segmenter.ingestFinal(words.join(' '));
    expect(commits[0]?.reason).toBe('max-words');
    expect(commits[0]?.text.toLowerCase().endsWith('notes')).toBe(true);
    expect(segmenter.getPending().toLowerCase().startsWith('but')).toBe(true);
  });

  it('flush commits leftover pending text for PTT / session end', () => {
    const { segmenter, commits } = make();
    segmenter.ingestFinal('hola');
    segmenter.flush();
    expect(commits).toEqual([{ text: 'hola', reason: 'flush' }]);
    expect(segmenter.getPending()).toBe('');
  });

  it('flush skips filler-only leftovers', () => {
    const { segmenter, commits } = make();
    segmenter.ingestFinal('um');
    segmenter.flush();
    expect(commits).toEqual([]);
  });

  it('Japanese video: shows pending Japanese without committing particle fragments', async () => {
    const pending: string[] = [];
    const commits: Array<{ text: string; reason: string }> = [];
    const segmenter = new SentenceSegmenter({
      mode: 'video',
      language: 'ja',
      onPending: (text) => pending.push(text),
      onCommit: (text, reason) => commits.push({ text, reason }),
    });

    segmenter.ingestFinal('現在政府は');
    expect(segmenter.getPending()).toBe('現在政府は');
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(commits).toEqual([]);

    segmenter.ingestFinal('新しい政策を');
    expect(segmenter.getPending()).toBe('現在政府は新しい政策を');
    expect(commits).toEqual([]);

    segmenter.ingestFinal('発表しました');
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(800);
    expect(commits).toEqual([
      { text: '現在政府は新しい政策を発表しました', reason: 'soft-silence' },
    ]);
    expect(segmenter.getPending()).toBe('');
  });

  it('Japanese video: does not commit a です/ます sentence until the min delay', async () => {
    const { segmenter, commits } = make('video');
    segmenter.setLanguage('ja');
    segmenter.ingestFinal('この問題について説明します');
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(799);
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(commits).toEqual([
      { text: 'この問題について説明します', reason: 'soft-silence' },
    ]);
  });

  it('Japanese video: merges phrase-final ASR chunks before committing', async () => {
    const pending: string[] = [];
    const commits: Array<{ text: string; reason: string }> = [];
    const segmenter = new SentenceSegmenter({
      mode: 'video',
      language: 'ja',
      onPending: (text) => pending.push(text),
      onCommit: (text, reason) => commits.push({ text, reason }),
    });

    segmenter.ingestFinal('旅行を連れて。');
    expect(segmenter.getPending()).toBe('旅行を連れて。');
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(commits).toEqual([]);

    segmenter.ingestFinal('来てもらって文句ばっかり。');
    expect(commits).toEqual([]);
    expect(segmenter.getPending()).toBe('旅行を連れて来てもらって文句ばっかり。');

    segmenter.ingestFinal('やっぱり言わないの。');
    expect(commits).toEqual([]);
    expect(segmenter.getPending()).toBe('旅行を連れて来てもらって文句ばっかりやっぱり言わないの。');

    await vi.advanceTimersByTimeAsync(800);
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(commits).toEqual([
      { text: '旅行を連れて来てもらって文句ばっかりやっぱり言わないの。', reason: 'hard-silence' },
    ]);
    expect(segmenter.getPending()).toBe('');
  });

  it('Japanese video: does not commit a て-ending phrase on hard silence', async () => {
    const commits: string[] = [];
    const segmenter = new SentenceSegmenter({
      mode: 'video',
      language: 'ja',
      onCommit: (text) => commits.push(text),
    });
    segmenter.ingestFinal('来てもらって。');
    await vi.advanceTimersByTimeAsync(1200);
    expect(commits).toEqual([]);
    expect(segmenter.getPending()).toBe('来てもらって。');
  });

  it('Japanese video: does not commit fillers or conjunctions alone', async () => {
    const commits: string[] = [];
    const segmenter = new SentenceSegmenter({
      mode: 'video',
      language: 'ja',
      onCommit: (text) => commits.push(text),
    });
    segmenter.ingestFinal('えっと');
    await vi.advanceTimersByTimeAsync(3000);
    expect(commits).toEqual([]);
    segmenter.ingestFinal('しかし');
    await vi.advanceTimersByTimeAsync(1000);
    expect(commits).toEqual([]);
    expect(segmenter.getPending()).toContain('しかし');
  });

  it('Japanese video: splits after a finished predicate and keeps the next clause', () => {
    const { segmenter, commits } = make('video');
    segmenter.setLanguage('ja');
    segmenter.ingestFinal('この問題について説明します現在政府は新しい政策を');
    expect(commits).toEqual([
      { text: 'この問題について説明します', reason: 'predicate' },
    ]);
    expect(segmenter.getPending()).toBe('現在政府は新しい政策を');
  });

  it('English video: merges I think / we should / consider this option', async () => {
    const { segmenter, commits } = make('video');
    segmenter.setLanguage('en');
    segmenter.ingestFinal('I think');
    expect(commits).toEqual([]);
    segmenter.ingestFinal('we should');
    expect(commits).toEqual([]);
    expect(segmenter.getPending()).toBe('I think we should');
    segmenter.ingestFinal('consider this option');
    expect(commits).toEqual([]);
    expect(segmenter.getPending()).toBe('I think we should consider this option');
    await vi.advanceTimersByTimeAsync(650);
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(550);
    expect(commits).toEqual([
      { text: 'I think we should consider this option', reason: 'hard-silence' },
    ]);
  });

  it('English video: does not commit an ASR-period fragment like "the Navy."', async () => {
    const { segmenter, commits } = make('video');
    segmenter.setLanguage('en');
    segmenter.ingestFinal('Regional officials say For now, the Navy.');
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(650);
    expect(commits).toEqual([]);
    segmenter.ingestFinal('Regional officials say for now the naval blockade and economic pressure will continue.');
    expect(commits).toHaveLength(1);
    expect(commits[0]?.text.toLowerCase()).toContain('naval blockade');
    expect(commits[0]?.text.toLowerCase()).toContain('economic pressure');
    expect(commits[0]?.text.toLowerCase()).not.toMatch(/navy naval/i);
  });

  it('English video: merges a streaming tail after a fake Navy period', async () => {
    const { segmenter, commits } = make('video');
    segmenter.setLanguage('en');
    segmenter.ingestFinal('Regional officials say For now, the Navy.');
    expect(commits).toEqual([]);
    segmenter.ingestFinal('the naval blockade and economic pressure will continue.');
    expect(commits).toHaveLength(1);
    expect(commits[0]?.text.toLowerCase()).toContain('regional officials');
    expect(commits[0]?.text.toLowerCase()).toContain('naval blockade');
    expect(commits[0]?.text.toLowerCase()).toContain('economic pressure');
    expect(commits[0]?.text.toLowerCase()).not.toMatch(/navy the naval/i);
    expect(commits[0]?.text.toLowerCase()).not.toMatch(/navy naval/i);
  });

  it('English video: keeps a "by." clause open until the next chunk', async () => {
    const { segmenter, commits } = make('video');
    segmenter.setLanguage('en');
    segmenter.ingestFinal('Iran is trying to drive up the cost for the United States and our allies by.');
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(commits).toEqual([]);
    segmenter.ingestFinal('Disrupting trade and The Strait of Hormuz.');
    expect(commits).toHaveLength(1);
    expect(commits[0]?.text.toLowerCase()).toMatch(/allies by/i);
    expect(commits[0]?.text.toLowerCase()).toMatch(/disrupting trade/i);
    expect(commits[0]?.text.toLowerCase()).toMatch(/hormuz/i);
  });

  it('English video: attaches "To restart talks." to the Hormuz clause', async () => {
    const { segmenter, commits } = make('video');
    segmenter.setLanguage('en');
    segmenter.ingestFinal('Iran is trying to drive up the cost for the United States and our allies by.');
    segmenter.ingestFinal('Disrupting trade and The Strait of Hormuz.');
    expect(commits).toHaveLength(1);
    segmenter.ingestFinal('To restart talks.');
    const last = commits[commits.length - 1]?.text.toLowerCase() || '';
    expect(last).toMatch(/hormuz/i);
    expect(last).toMatch(/restart talks/i);
    expect(segmenter.getPending()).toBe('');
  });

  it('English video: keeps the Hormuz/restart news clip as one caption', async () => {
    const { segmenter, commits } = make('video');
    segmenter.setLanguage('en');
    segmenter.ingestFinal('Regional officials say For now, the Navy.');
    segmenter.ingestFinal('the naval blockade and economic pressure will continue.');
    segmenter.ingestFinal("It's a question of who blinks first, they say.");
    segmenter.ingestFinal('Iran is trying to drive up the cost for the United States and our allies by.');
    segmenter.ingestFinal('Disrupting trade and The Strait of Hormuz.');
    segmenter.ingestFinal('To restart talks.');
    const texts = commits.map((c) => c.text.toLowerCase());
    expect(texts.some((t) => t.includes('naval blockade') && t.includes('economic pressure'))).toBe(true);
    expect(texts.some((t) => /the navy\.$/.test(t))).toBe(false);
    expect(texts.filter((t) => t.includes('restart talks'))).toHaveLength(1);
    expect(texts.some((t) => t.includes('allies by') && t.includes('disrupting trade') && t.includes('restart talks'))).toBe(true);
  });

  it('English video: holds an unfinished news clause across an ASR final', async () => {
    const { segmenter, commits } = make('video');
    segmenter.setLanguage('en');
    segmenter.ingestFinal('The president had Beijing on his mind when he toured');
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(650);
    expect(commits).toEqual([]);
    segmenter.ingestFinal('the new White House helipad this afternoon, including');
    expect(commits).toEqual([]);
    expect(segmenter.getPending()).toContain('helipad');
    expect(segmenter.getPending()).toContain('including');
    await vi.advanceTimersByTimeAsync(1200);
    expect(commits).toEqual([]);
    segmenter.ingestFinal('the granite along with construction workers and members of the military.');
    expect(commits[0]?.text).toMatch(/White House helipad/i);
    expect(commits[0]?.text).toMatch(/military/i);
  });

  it('English: does not commit a short punctuated fragment immediately', () => {
    const { segmenter, commits } = make('video');
    segmenter.setLanguage('en');
    segmenter.ingestFinal('I think.');
    expect(commits).toEqual([]);
    expect(segmenter.getPending()).toBe('I think.');
  });

  it('Chinese video: merges short clauses and commits on 。', async () => {
    const { segmenter, commits } = make('video');
    segmenter.setLanguage('zh');
    segmenter.ingestFinal('我觉得');
    expect(commits).toEqual([]);
    segmenter.ingestFinal('这个问题');
    expect(commits).toEqual([]);
    expect(segmenter.getPending()).toBe('我觉得这个问题');
    segmenter.ingestFinal('需要进一步讨论。');
    expect(commits).toEqual([
      { text: '我觉得这个问题需要进一步讨论。', reason: 'punctuation' },
    ]);
  });

  it('Chinese: does not commit 因为 / 的 endings', async () => {
    const { segmenter, commits } = make('video');
    segmenter.setLanguage('zh');
    segmenter.ingestFinal('这个问题因为');
    await vi.advanceTimersByTimeAsync(1000);
    expect(commits).toEqual([]);
    segmenter.ingestFinal('新的');
    await vi.advanceTimersByTimeAsync(500);
    expect(commits).toEqual([]);
    expect(segmenter.getPending()).toContain('新的');
  });

  it('Korean video: holds particle fragments and commits a 합니다 sentence', async () => {
    const { segmenter, commits } = make('video');
    segmenter.setLanguage('ko');
    segmenter.ingestFinal('저는');
    expect(commits).toEqual([]);
    segmenter.ingestFinal('이 문제를');
    expect(commits).toEqual([]);
    segmenter.ingestFinal('설명합니다');
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    expect(commits).toEqual([
      { text: '저는이 문제를설명합니다', reason: 'soft-silence' },
    ]);
  });
});
