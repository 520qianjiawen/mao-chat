import { describe, expect, it } from 'vitest';
import {
  captionTracksFromPlayerResponse,
  cleanCaptionText,
  eventsToCues,
  extractJsonAssignment,
  extractYouTubeVideoId,
  findActiveCue,
  findUpcomingCue,
  formatVideoTime,
  isYouTubeWatchUrl,
  isCaptionCrumb,
  shouldPreferYouTubeCaptionsOverAsr,
  shouldUseYouTubeCaptionTrack,
  mergeCaptionCues,
  packOnscreenCrumbs,
  visibleCuesAt,
  selectCaptionTrack,
  selectCaptionTrackOrFallback,
  shouldAppendLiveCrumb,
  splitCaptionText,
  timedTextUrl,
  timedTextUrlWithPot,
  wrapPlainTranscript,
  youtubeLangToAppLang,
} from './youtubeCaptions';

describe('YouTube URL helpers', () => {
  it('accepts watch / shorts / live URLs', () => {
    expect(isYouTubeWatchUrl('https://www.youtube.com/watch?v=abc123')).toBe(true);
    expect(isYouTubeWatchUrl('https://m.youtube.com/shorts/xyz')).toBe(true);
    expect(isYouTubeWatchUrl('https://www.youtube.com/live/abc')).toBe(true);
    expect(isYouTubeWatchUrl('https://youtu.be/dQw4w9wg')).toBe(true);
    expect(isYouTubeWatchUrl('https://www.youtube.com/embed/abc123')).toBe(true);
    expect(isYouTubeWatchUrl('https://meet.google.com/abc')).toBe(false);
  });

  it('uses YouTube caption wrapping only on YouTube when the checkbox is on', () => {
    expect(shouldUseYouTubeCaptionTrack(true, 'https://www.youtube.com/watch?v=abc')).toBe(true);
    expect(shouldUseYouTubeCaptionTrack(true, 'https://www.bilibili.com/video/BV1')).toBe(false);
    expect(shouldUseYouTubeCaptionTrack(true, 'https://www.netflix.com/watch/1')).toBe(false);
    expect(shouldUseYouTubeCaptionTrack(false, 'https://www.youtube.com/watch?v=abc')).toBe(false);
  });

  it('does not skip ASR for empty or live YouTube fallback', () => {
    expect(shouldPreferYouTubeCaptionsOverAsr({ ok: true, mode: 'track', cueCount: 12 })).toBe(true);
    expect(shouldPreferYouTubeCaptionsOverAsr({ ok: true, mode: 'live', cueCount: 0 })).toBe(false);
    expect(shouldPreferYouTubeCaptionsOverAsr({ ok: true, mode: 'track', cueCount: 0 })).toBe(false);
    expect(shouldPreferYouTubeCaptionsOverAsr({ ok: false })).toBe(false);
  });

  it('extracts the video id', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9wg')).toBe('dQw4w9wg');
    expect(extractYouTubeVideoId('https://www.youtube.com/shorts/shortid')).toBe('shortid');
    expect(extractYouTubeVideoId('https://youtu.be/dQw4w9wg')).toBe('dQw4w9wg');
    expect(extractYouTubeVideoId('https://www.youtube.com/embed/embedid')).toBe('embedid');
  });
});

describe('selectCaptionTrack', () => {
  const tracks = [
    { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=1&lang=en', kind: 'asr', name: 'English (auto)' },
    { languageCode: 'ja', baseUrl: 'https://www.youtube.com/api/timedtext?v=1&lang=ja', name: '日本語' },
    { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=1&kind=asr&name=chat', name: 'Live chat' },
  ];

  it('prefers a same-language manual track over ASR', () => {
    const picked = selectCaptionTrack(tracks, 'ja');
    expect(picked?.languageCode).toBe('ja');
    expect(picked?.kind).toBeUndefined();
  });

  it('returns null when the requested language has no track', () => {
    expect(selectCaptionTrack(tracks, 'ko')).toBeNull();
  });

  it('accepts auto and skips chat tracks', () => {
    const picked = selectCaptionTrack(tracks, 'auto');
    expect(picked?.name).not.toMatch(/chat/i);
    expect(picked?.languageCode).toBe('ja');
  });

  it('falls back to any usable track when the preferred language is missing', () => {
    expect(selectCaptionTrackOrFallback(tracks, 'ko')?.languageCode).toBe('ja');
  });
});

describe('eventsToCues', () => {
  it('flattens json3 events and drops music tags', () => {
    const cues = eventsToCues([
      { tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: '[Music]' }] },
      { tStartMs: 1300, dDurationMs: 900, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
      { tStartMs: 2300, dDurationMs: 800, segs: [{ utf8: 'there.' }] },
    ]);
    expect(cues.some((cue) => cue.text.includes('Music'))).toBe(false);
    expect(cues.map((cue) => cue.text).join(' ')).toContain('Hello world');
    expect(cues.some((cue) => cue.text.includes('there'))).toBe(true);
  });

  it('does not glue full caption lines into one paragraph', () => {
    const merged = mergeCaptionCues([
      { startMs: 0, endMs: 800, text: 'This is the first line' },
      { startMs: 1100, endMs: 2000, text: 'and this is the next line.' },
    ]);
    expect(merged).toHaveLength(2);
  });

  it('still joins tiny word crumbs', () => {
    const merged = mergeCaptionCues([
      { startMs: 0, endMs: 80, text: 'Hel' },
      { startMs: 90, endMs: 180, text: 'lo' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('Hel lo');
  });

  it('keeps a finished official sentence as its own line', () => {
    const cues = eventsToCues([
      { tStartMs: 140000, dDurationMs: 2000, segs: [{ utf8: "that somehow we've lost the capacity for shock." }] },
      { tStartMs: 142000, dDurationMs: 7000, segs: [{ utf8: 'But in fact, to sit there and just sort of randomly almost cavalierly threatened war against a country' }] },
      { tStartMs: 149000, dDurationMs: 3000, segs: [{ utf8: 'with which we have friendly relations is in fact,' }] },
      { tStartMs: 152000, dDurationMs: 2000, segs: [{ utf8: 'you know, a striking moment.' }] },
    ]);
    expect(cues[0].text).toBe("that somehow we've lost the capacity for shock.");
    expect(cues[cues.length - 1].text).toBe('you know, a striking moment.');
    expect(cues.map((cue) => cue.text).join(' ')).toContain('friendly relations');
    expect(cues.length).toBeGreaterThanOrEqual(2);
    expect(cues.length).toBeLessThanOrEqual(4);
  });

  it('merges YouTube wrap newlines into one sentence when the first line is unfinished', () => {
    const cues = eventsToCues([
      { tStartMs: 0, dDurationMs: 1600, segs: [{ utf8: 'hello there' }, { utf8: ' friends', tOffsetMs: 400 }] },
      { tStartMs: 1600, aAppend: 1, segs: [{ utf8: '\n' }] },
      { tStartMs: 1600, dDurationMs: 1400, segs: [{ utf8: 'how are' }, { utf8: ' you', tOffsetMs: 350 }] },
    ]);
    expect(cues.map((cue) => cue.text)).toEqual(['hello there friends how are you']);
  });

  it('joins a caption that already contains a wrap newline', () => {
    const cues = eventsToCues([
      { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'first spoken line\nsecond spoken line' }] },
    ]);
    expect(cues.map((cue) => cue.text)).toEqual(['first spoken line second spoken line']);
  });

  it('joins YouTube two-line wraps the way kiss-translator does', () => {
    const cues = eventsToCues([
      { tStartMs: 38000, dDurationMs: 1800, segs: [{ utf8: 'WHAT hunger looks like.' }] },
      { tStartMs: 40000, dDurationMs: 900, segs: [{ utf8: 'He was not going' }] },
      { tStartMs: 41000, dDurationMs: 900, segs: [{ utf8: 'to give IT UP.' }] },
      { tStartMs: 42000, dDurationMs: 900, segs: [{ utf8: "WE'LL SEND IT TO TURN" }] },
      { tStartMs: 43000, dDurationMs: 900, segs: [{ utf8: 'SEVEN.' }] },
    ]);
    expect(cues.map((cue) => cue.text)).toEqual([
      'WHAT hunger looks like.',
      'He was not going to give IT UP.',
      "WE'LL SEND IT TO TURN SEVEN.",
    ]);
  });

  it('splits a long YouTube auto-caption event into short lines', () => {
    const words = 'and hamas after hamas launched a terrorist attack into southern israel on october seventh of twenty twenty three now president trump spoke about this saying the israelis should not be striking gaza'.split(' ');
    const cues = eventsToCues([{
      tStartMs: 0,
      dDurationMs: words.length * 280,
      segs: words.map((word, index) => ({ utf8: word, tOffsetMs: index * 280 })),
    }]);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.every((cue) => cue.text.split(' ').length <= 20)).toBe(true);
    expect(cues[0].text.split(' ')[0]).toBe('and');
    expect(cues.map((cue) => cue.text).join(' ')).toContain('striking gaza');
  });

  it('packs one-word auto-caption events into readable kiss-translator lines', () => {
    const cues = eventsToCues([
      { tStartMs: 2000, dDurationMs: 500, segs: [{ utf8: 'Messina,' }] },
      { tStartMs: 3000, dDurationMs: 400, segs: [{ utf8: 'manager' }] },
      { tStartMs: 4000, dDurationMs: 800, segs: [{ utf8: "Obama's 2012" }] },
      { tStartMs: 6000, dDurationMs: 900, segs: [{ utf8: 're-election campaign' }] },
      { tStartMs: 8000, dDurationMs: 1200, segs: [{ utf8: 'POLITICAL ANALYST' }] },
    ]);
    expect(cues.length).toBeGreaterThanOrEqual(1);
    expect(cues.length).toBeLessThanOrEqual(3);
    expect(cues.some((cue) => cue.text.includes('Messina,') && cue.text.includes('manager'))).toBe(true);
    expect(cues.map((cue) => cue.text).join(' ')).toBe(
      "Messina, manager Obama's 2012 re-election campaign POLITICAL ANALYST",
    );
  });
});

describe('live caption crumbs', () => {
  it('treats short ASR tokens as crumbs and official sentences as lines', () => {
    expect(isCaptionCrumb('Messina,')).toBe(true);
    expect(isCaptionCrumb("Obama's 2012")).toBe(true);
    expect(isCaptionCrumb("that somehow we've lost the capacity for shock.")).toBe(false);
  });

  it('joins simultaneous on-screen crumbs', () => {
    expect(packOnscreenCrumbs(['Messina,', 'manager', "Obama's 2012"])).toEqual([
      "Messina, manager Obama's 2012",
    ]);
    expect(packOnscreenCrumbs([
      "that somehow we've lost the capacity for shock.",
      'But in fact, to sit there and just sort of randomly almost cavalierly threatened war against a country',
    ])).toHaveLength(2);
  });

  it('appends a following crumb to the live window', () => {
    expect(shouldAppendLiveCrumb('Messina,', 'manager', 1000)).toBe(true);
    expect(shouldAppendLiveCrumb('He was not going', 'to give IT UP.', 1000)).toBe(true);
    expect(shouldAppendLiveCrumb(
      "that somehow we've lost the capacity for shock.",
      'But in fact, to sit there',
      800,
    )).toBe(false);
  });
});

describe('findActiveCue', () => {
  const cues = [
    { startMs: 1000, endMs: 2000, text: 'one' },
    { startMs: 2500, endMs: 3500, text: 'two' },
  ];
  it('holds the cue briefly after it ends', () => {
    expect(findActiveCue(cues, 2100)?.text).toBe('one');
    expect(findActiveCue(cues, 2600)?.text).toBe('two');
    expect(findActiveCue(cues, 500)).toBeNull();
  });

  it('surfaces the next cue just before it starts', () => {
    expect(findUpcomingCue(cues, 1900)?.text).toBe('two');
    expect(visibleCuesAt(cues, 1900).map((cue) => cue.text)).toEqual(['one', 'two']);
    expect(visibleCuesAt(cues, 100).map((cue) => cue.text)).toEqual([]);
  });
});

describe('player-response parsing', () => {
  it('extracts a JSON assignment from a script blob', () => {
    const player = extractJsonAssignment(
      'var x = 1; ytInitialPlayerResponse = {"captions":{"ok":true}}; more();',
      'ytInitialPlayerResponse',
    );
    expect(player).toEqual({ captions: { ok: true } });
  });

  it('reads caption tracks from the player payload', () => {
    const tracks = captionTracksFromPlayerResponse({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { languageCode: 'en', baseUrl: '/api/timedtext?lang=en', name: { simpleText: 'English' } },
          ],
        },
      },
    });
    expect(tracks).toEqual([
      { languageCode: 'en', baseUrl: '/api/timedtext?lang=en', kind: undefined, name: 'English' },
    ]);
  });

  it('forces json3 on timedtext URLs', () => {
    const url = timedTextUrl('https://www.youtube.com/api/timedtext?v=1&lang=en&tlang=zh');
    expect(url).toContain('fmt=json3');
    expect(url).not.toContain('tlang=');
  });

  it('copies pot params onto the selected track URL', () => {
    const url = timedTextUrlWithPot(
      'https://www.youtube.com/api/timedtext?v=1&lang=en',
      'https://www.youtube.com/api/timedtext?v=1&lang=fr&pot=TOKEN&c=WEB',
    );
    expect(url).toContain('fmt=json3');
    expect(url).toContain('pot=TOKEN');
    expect(url).toContain('lang=en');
    expect(url).toContain('c=WEB');
  });
});

describe('youtubeLangToAppLang', () => {
  it('maps YouTube Chinese variants onto app codes', () => {
    expect(youtubeLangToAppLang('zh-Hans')).toBe('zh');
    expect(youtubeLangToAppLang('zh-Hant')).toBe('zh-tw');
    expect(youtubeLangToAppLang('en-US')).toBe('en');
  });
});

describe('cleanCaptionText', () => {
  it('strips tags and zero-width spaces', () => {
    expect(cleanCaptionText('  <b>Hi\u200B</b>  there ')).toBe('Hi there');
  });
});

describe('splitCaptionText', () => {
  it('keeps YouTube newlines as separate lines', () => {
    expect(splitCaptionText('first line\nsecond line')).toEqual(['first line', 'second line']);
  });
});

describe('formatVideoTime', () => {
  it('formats kiss-translator style timestamps', () => {
    expect(formatVideoTime(140000)).toBe('2:20');
    expect(formatVideoTime(3723000)).toBe('1:02:03');
  });
});

describe('wrapPlainTranscript', () => {
  it('leaves short captions alone', () => {
    expect(wrapPlainTranscript('you know, a striking moment.')).toBe('you know, a striking moment.');
  });

  it('breaks a run-on ASR paragraph on sentence and clause boundaries', () => {
    const wrapped = wrapPlainTranscript(
      "a comfortablell to all get together now rebecca that's different yet it is different and dana the iranians haven't backed off their original demands and in fact they're making more audacious demands publicly now saying that they want the united states to remove the blockade",
    );
    const lines = wrapped.split('\n');
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => line.split(' ').length <= 14)).toBe(true);
    expect(wrapped).toContain('get together');
    expect(wrapped).toContain('remove the blockade');
  });
});
