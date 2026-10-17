/** YouTube caption-track helpers. Page fetch lives in the content script. */

export interface CaptionTrack {
  languageCode: string;
  baseUrl: string;
  kind?: string;
  name?: string;
}

export interface CaptionCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TimedTextEvent {
  tStartMs?: number;
  dDurationMs?: number;
  aAppend?: number;
  segs?: Array<{ utf8?: string; tOffsetMs?: number }>;
}

const CHAT_NAME = /chat|live chat|superchat/i;
const NOISE = /^\[(?:music|applause|laughter|cheers|silence|inaudible)\]$|^♪+$|^[\s♪\[\]【】（）()]+$/i;

function youtubeHost(hostname: string): string {
  return hostname.replace(/^www\./, '').toLowerCase();
}

/** YouTube line-wrapping only when the checkbox is on AND this tab is YouTube. */
export function shouldUseYouTubeCaptionTrack(
  enabled: boolean,
  url?: string | undefined | null,
): boolean {
  return Boolean(enabled) && isYouTubeWatchUrl(url);
}

/**
 * Only skip tab ASR when YouTube actually returned a caption track.
 * Live/empty fallback used to return ok and then emit nothing — Moonshine /
 * SenseVoice never started, so Japanese video looked "unable to recognize".
 */
export function shouldPreferYouTubeCaptionsOverAsr(started: {
  ok?: boolean;
  mode?: string;
  cueCount?: number;
} | null | undefined): boolean {
  return Boolean(started?.ok && started.mode === 'track' && (started.cueCount || 0) > 0);
}

export function isYouTubeWatchUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = youtubeHost(parsed.hostname);
    if (host === 'youtu.be') {
      return parsed.pathname.length > 1;
    }
    if (host === 'music.youtube.com') {
      return parsed.pathname === '/watch';
    }
    if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtube-nocookie.com') {
      return false;
    }
    return parsed.pathname === '/watch'
      || parsed.pathname.startsWith('/live/')
      || parsed.pathname.startsWith('/shorts/')
      || parsed.pathname.startsWith('/embed/');
  } catch {
    return false;
  }
}

export function extractYouTubeVideoId(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = youtubeHost(parsed.hostname);
    const v = parsed.searchParams.get('v');
    if (v) return v;
    if (host === 'youtu.be') {
      const id = parsed.pathname.replace(/^\//, '').split('/')[0];
      return id || null;
    }
    const shorts = parsed.pathname.match(/^\/shorts\/([^/?#]+)/);
    if (shorts) return shorts[1];
    const live = parsed.pathname.match(/^\/live\/([^/?#]+)/);
    if (live) return live[1];
    const embed = parsed.pathname.match(/^\/embed\/([^/?#]+)/);
    if (embed) return embed[1];
    return null;
  } catch {
    return null;
  }
}

/** Video-clock label like kiss-translator: `2:20` or `1:02:20`. */
export function formatVideoTime(ms: number | undefined | null): string {
  if (!Number.isFinite(ms) || (ms as number) < 0) return '';
  const totalSec = Math.floor((ms as number) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function trackDisplayName(track: CaptionTrack): string {
  return track.name || track.languageCode;
}

export function isChatCaptionTrack(track: CaptionTrack): boolean {
  return CHAT_NAME.test(track.name || '');
}

export function cleanCaptionText(raw: string | undefined): string {
  return String(raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\u200B/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Collapse spaces but keep YouTube's own `\n` wrap points. */
function cleanCaptionPreservingBreaks(raw: string | undefined): string {
  return String(raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\u200B/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

const SOFT_LINE_CHARS = 110;

function lastBreakIndex(text: string, limit: number): number {
  const window = text.slice(0, limit + 1);
  const marks = ['. ', '? ', '! ', '。', '！', '？', ', ', '，', '; ', '、'];
  let cut = -1;
  for (const mark of marks) {
    cut = Math.max(cut, window.lastIndexOf(mark));
  }
  if (cut >= 24) return cut + 1;
  const space = window.lastIndexOf(' ');
  return space >= 24 ? space : -1;
}

/** Split a long official-caption blob the way kiss-translator wraps lines. */
export function splitOverlongCaption(text: string): string[] {
  const value = text.replace(/\s+/g, ' ').trim();
  if (!value) return [];
  if (value.length <= SOFT_LINE_CHARS) return [value];
  const parts: string[] = [];
  let rest = value;
  while (rest.length > SOFT_LINE_CHARS) {
    const cut = lastBreakIndex(rest, SOFT_LINE_CHARS);
    const take = (cut >= 24 ? rest.slice(0, cut) : rest.slice(0, SOFT_LINE_CHARS)).trim();
    if (!take) break;
    parts.push(take);
    rest = rest.slice(take.length).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Honor YouTube `\n`, then wrap leftover run-on lines. */
export function splitCaptionText(raw: string | undefined): string[] {
  const cleaned = cleanCaptionPreservingBreaks(raw);
  if (!cleaned) return [];
  const lines: string[] = [];
  for (const line of cleaned.split('\n')) {
    const piece = line.replace(/\s+/g, ' ').trim();
    if (piece) lines.push(...splitOverlongCaption(piece));
  }
  return lines;
}

export function isNonSpeechCaption(text: string): boolean {
  return !text || NOISE.test(text);
}

function captionWordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function isMostlyCjk(text: string): boolean {
  return (text.match(/[\u3400-\u9fff]/g)?.length ?? 0) > text.length / 3;
}

/** One or two short ASR tokens, not a finished on-screen caption line. */
export function isCaptionCrumb(text: string): boolean {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return true;
  if (isMostlyCjk(value)) return value.length <= 8;
  return captionWordCount(value) <= 3 && value.length <= 24;
}

/** Grow the live window instead of committing each ASR crumb as its own row. */
export function shouldAppendLiveCrumb(prevText: string, nextText: string, gapMs: number): boolean {
  const prev = String(prevText || '').replace(/\s+/g, ' ').trim();
  const next = String(nextText || '').replace(/\s+/g, ' ').trim();
  if (!prev || !next || prev === next) return false;
  if (next.startsWith(prev) || (prev.includes(next) && next.length >= 4)) return true;
  if (gapMs > 2200) return false;
  if (/[.!?。！？…]$/.test(prev) && !isCaptionCrumb(prev)) return false;
  return isCaptionCrumb(prev) || !/[.!?。！？…]$/.test(prev);
}

/** Join simultaneous on-screen crumbs so a 2-segment window is one line. */
export function packOnscreenCrumbs(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const prev = out[out.length - 1];
    if (prev && (!/[.!?。！？…]$/.test(prev) || (isCaptionCrumb(prev) && isCaptionCrumb(line)))) {
      out[out.length - 1] = `${prev} ${line}`.replace(/\s+/g, ' ').trim();
    } else {
      out.push(line);
    }
  }
  return out;
}

function languagePrimary(code: string | undefined): string {
  return (code || '').toLowerCase().replace(/_/g, '-').split('-')[0];
}

/** Map a YouTube track language (zh-Hans, en-US) onto an app/Bing code. */
export function youtubeLangToAppLang(code: string | undefined): string {
  const lower = (code || '').toLowerCase().replace(/_/g, '-');
  if (!lower) return 'en';
  if (lower === 'zh' || lower.startsWith('zh-hans') || lower === 'zh-cn') return 'zh';
  if (lower.startsWith('zh-hant') || lower === 'zh-tw' || lower === 'zh-hk') return 'zh-tw';
  return lower.split('-')[0];
}

/** Prefer a same-language manual track, then same-language ASR. No match → null. */
export function selectCaptionTrack(
  tracks: CaptionTrack[],
  preferredLang: string | undefined,
): CaptionTrack | null {
  const usable = tracks.filter((track) => track.baseUrl && !isChatCaptionTrack(track));
  if (usable.length === 0) return null;

  const want = languagePrimary(preferredLang);
  const requireMatch = Boolean(want && want !== 'auto' && want !== 'mul');

  const scored = usable.map((track) => {
    const primary = languagePrimary(track.languageCode);
    const langMatch = !requireMatch || primary === want;
    const manual = track.kind !== 'asr';
    return { track, langMatch, score: (langMatch ? 10 : 0) + (manual ? 2 : 0) };
  });
  scored.sort((a, b) => b.score - a.score);
  if (requireMatch && !scored[0].langMatch) return null;
  return scored[0].track;
}

/** Prefer the requested language, then any usable track — never drop to ASR just because the UI language missed. */
export function selectCaptionTrackOrFallback(
  tracks: CaptionTrack[],
  preferredLang: string | undefined,
): CaptionTrack | null {
  return selectCaptionTrack(tracks, preferredLang) || selectCaptionTrack(tracks, 'auto');
}

interface TimedWord {
  startMs: number;
  endMs: number;
  text: string;
  /** YouTube's own wrap (`\n` / aAppend). */
  hardBreakAfter?: boolean;
}

function joinCaptionWords(parts: string[]): string {
  const raw = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (isMostlyCjk(raw)) return parts.join('').replace(/\s+/g, '').trim();
  return raw;
}

/**
 * Flatten json3 events the way kiss-translator does: one timed token per
 * visible segment. YouTube `\n` is only a wrap, not a new sentence.
 */
export function flattenTimedWords(events: TimedTextEvent[] | undefined | null): TimedWord[] {
  if (!Array.isArray(events)) return [];
  const words: TimedWord[] = [];

  for (const event of events) {
    const segs = Array.isArray(event.segs) ? event.segs : [];
    const isBreak = event.aAppend === 1 && segs.length === 1 && segs[0]?.utf8 === '\n';
    if (isBreak) continue;

    const eventStart = Number(event.tStartMs) || 0;
    const eventEnd = eventStart + Math.max(Number(event.dDurationMs) || 0, 0);
    const pieces: Array<{ text: string; startMs: number }> = [];

    for (const seg of segs) {
      const raw = String(seg?.utf8 ?? '');
      const startMs = eventStart + (Number(seg?.tOffsetMs) || 0);
      const lines = splitCaptionText(raw);
      if (lines.length === 0) continue;
      for (const text of lines) {
        if (isNonSpeechCaption(text)) continue;
        pieces.push({ text, startMs });
      }
    }

    for (let i = 0; i < pieces.length; i++) {
      const startMs = pieces[i].startMs;
      const nextStart = pieces[i + 1]?.startMs;
      const endMs = nextStart && nextStart > startMs
        ? nextStart
        : (i === pieces.length - 1 ? Math.max(eventEnd, startMs + 420) : startMs + 420);
      words.push({ startMs, endMs, text: pieces[i].text });
    }
  }

  // Close the 0.5–1.5s holes YouTube leaves between wrapped on-screen lines
  // so "He was not going" + "to give IT UP." stay one sentence.
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].startMs - words[i].endMs;
    if (gap > 0 && gap <= 1800) words[i].endMs = words[i + 1].startMs;
  }

  return words;
}

// kiss-translator processSubtitles defaults.
const KISS_GAP_MS = 1000;
const KISS_MAX_WORDS = 15;
const KISS_MAX_MS = 10000;
const KISS_LONG_CHARS = 120;
const KISS_CJK_CHARS = 30;
const KISS_PAUSE_WORDS = new Set([
  'actually', 'also', 'although', 'and', 'anyway', 'as', 'because', 'but',
  'eventually', 'however', 'if', 'instead', 'meanwhile', 'nevertheless',
  'nonetheless', 'now', 'okay', 'or', 'otherwise', 'perhaps', 'right',
  'since', 'so', 'then', 'therefore', 'though', 'thus', 'unless', 'until',
  'well', 'while',
]);

/** Pack tokens into sentences the way kiss-translator's rule breaker does. */
export function packCaptionLines(words: TimedWord[], usePause = false): CaptionCue[] {
  if (words.length === 0) return [];
  const cues: CaptionCue[] = [];
  let bucket: TimedWord[] = [];
  let wordCount = 0;

  const flush = () => {
    if (bucket.length === 0) return;
    const text = joinCaptionWords(bucket.map((word) => word.text));
    if (text) {
      cues.push({
        startMs: bucket[0].startMs,
        endMs: Math.max(bucket[bucket.length - 1].endMs, bucket[0].startMs + 700),
        text,
      });
    }
    bucket = [];
    wordCount = 0;
  };

  for (const word of words) {
    if (bucket.length === 0) {
      bucket.push(word);
      wordCount += captionWordCount(word.text);
      continue;
    }
    const prev = bucket[bucket.length - 1];
    const gap = word.startMs - prev.endMs;
    const duration = word.startMs - bucket[0].startMs;
    const firstWord = word.text.toLowerCase().split(/\s+/)[0] || '';
    const shouldBreak =
      Boolean(prev.hardBreakAfter)
      || /[.?!。！？…\])]$/.test(prev.text)
      || gap > KISS_GAP_MS
      || duration >= KISS_MAX_MS
      || ((usePause || /[,，]$/.test(prev.text)) && wordCount >= KISS_MAX_WORDS)
      || /^[[(♪]/.test(word.text)
      || (usePause && KISS_PAUSE_WORDS.has(firstWord) && bucket.length > 1);

    if (shouldBreak) flush();
    bucket.push(word);
    wordCount += captionWordCount(word.text);
  }
  flush();
  return cues;
}

function formatKissSubtitles(words: TimedWord[], lang?: string): CaptionCue[] {
  if (words.length === 0) return [];
  const primary = languagePrimary(lang);
  const cjk = ['zh', 'ja', 'ko', 'th'].includes(primary)
    || isMostlyCjk(words.map((word) => word.text).join(''));

  if (cjk) {
    const cues: CaptionCue[] = [];
    let bucket: TimedWord[] = [];
    const flush = () => {
      if (bucket.length === 0) return;
      const text = joinCaptionWords(bucket.map((word) => word.text));
      if (text) {
        cues.push({
          startMs: bucket[0].startMs,
          endMs: Math.max(bucket[bucket.length - 1].endMs, bucket[0].startMs + 700),
          text,
        });
      }
      bucket = [];
    };
    for (const word of words) {
      if (bucket.length === 0) {
        bucket.push(word);
        continue;
      }
      const prev = bucket[bucket.length - 1];
      const nextText = joinCaptionWords([...bucket.map((item) => item.text), word.text]);
      if (
        prev.hardBreakAfter
        || word.startMs - prev.endMs > KISS_GAP_MS
        || /[。！？.!?…][”’"'」』】）》）\]]*$/.test(prev.text)
        || nextText.length >= KISS_CJK_CHARS
      ) {
        flush();
      }
      bucket.push(word);
    }
    flush();
    return cues;
  }

  const firstPass = packCaptionLines(words, false);
  const out: CaptionCue[] = [];
  for (const cue of firstPass) {
    if (cue.text.length <= KISS_LONG_CHARS) {
      out.push(cue);
      continue;
    }
    const slice = words.filter((word) => word.startMs >= cue.startMs && word.startMs < cue.endMs);
    out.push(...(slice.length > 1 ? packCaptionLines(slice, true) : [cue]));
  }
  return out;
}

export function eventsToCues(
  events: TimedTextEvent[] | undefined | null,
  lang?: string,
): CaptionCue[] {
  return formatKissSubtitles(flattenTimedWords(events), lang);
}

/** Only glue word-level crumbs YouTube split mid-line. Keep real cues separate. */
export function mergeCaptionCues(cues: CaptionCue[]): CaptionCue[] {
  if (cues.length <= 1) return cues;
  const merged: CaptionCue[] = [];
  let current = { ...cues[0] };

  for (let i = 1; i < cues.length; i++) {
    const next = cues[i];
    const gap = next.startMs - current.endMs;
    const combined = `${current.text} ${next.text}`.replace(/\s+/g, ' ').trim();
    const crumb =
      gap <= 80
      && current.text.length <= 16
      && next.text.length <= 16
      && !/[.!?。！？…]$/.test(current.text);

    if (crumb) {
      current = { startMs: current.startMs, endMs: Math.max(current.endMs, next.endMs), text: combined };
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  return merged;
}

export const CAPTION_LOOKAHEAD_MS = 800;

export function findActiveCue(cues: CaptionCue[], timeMs: number): CaptionCue | null {
  if (cues.length === 0) return null;
  let hit: CaptionCue | null = null;
  for (const cue of cues) {
    if (timeMs >= cue.startMs && timeMs < cue.endMs) hit = cue;
  }
  if (hit) return hit;
  for (let i = cues.length - 1; i >= 0; i--) {
    if (timeMs >= cues[i].endMs && timeMs < cues[i].endMs + 280) return cues[i];
  }
  return null;
}

export function findUpcomingCue(
  cues: CaptionCue[],
  timeMs: number,
  lookaheadMs = CAPTION_LOOKAHEAD_MS,
): CaptionCue | null {
  const next = cues.find((cue) => cue.startMs > timeMs);
  if (!next) return null;
  return next.startMs - timeMs <= lookaheadMs ? next : null;
}

/** Current line, plus the next line if it is about to start. */
export function visibleCuesAt(
  cues: CaptionCue[],
  timeMs: number,
  lookaheadMs = CAPTION_LOOKAHEAD_MS,
): CaptionCue[] {
  const active = findActiveCue(cues, timeMs);
  const upcoming = findUpcomingCue(cues, timeMs, lookaheadMs);
  const out: CaptionCue[] = [];
  if (active) out.push(active);
  if (upcoming && upcoming.startMs !== active?.startMs) out.push(upcoming);
  return out;
}

export function extractJsonAssignment(source: string, name: string): unknown | null {
  const key = `${name} = `;
  const idx = source.indexOf(key);
  if (idx < 0) return null;
  const start = source.indexOf('{', idx);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function captionTracksFromPlayerResponse(player: any): CaptionTrack[] {
  const raw = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((track: any) => ({
      languageCode: String(track?.languageCode || ''),
      baseUrl: String(track?.baseUrl || ''),
      kind: track?.kind ? String(track.kind) : undefined,
      name: track?.name?.simpleText
        || track?.name?.runs?.[0]?.text
        || undefined,
    }))
    .filter((track: CaptionTrack) => track.baseUrl && track.languageCode);
}

export function timedTextUrl(baseUrl: string): string {
  const url = new URL(baseUrl, 'https://www.youtube.com/');
  url.searchParams.delete('tlang');
  url.searchParams.set('fmt', 'json3');
  return url.toString();
}

/** Reuse the player's pot-bearing timedtext URL, pointed at the chosen track. */
export function timedTextUrlWithPot(baseUrl: string, potUrl?: string | null): string {
  const json3 = timedTextUrl(baseUrl);
  if (!potUrl) return json3;
  try {
    const cap = new URL(json3);
    const pot = new URL(potUrl, 'https://www.youtube.com/');
    pot.searchParams.delete('tlang');
    pot.searchParams.delete('name');
    pot.searchParams.set('fmt', 'json3');
    const lang = cap.searchParams.get('lang');
    const kind = cap.searchParams.get('kind');
    if (lang) pot.searchParams.set('lang', lang);
    if (kind) pot.searchParams.set('kind', kind);
    else pot.searchParams.delete('kind');
    return pot.toString();
  } catch {
    return json3;
  }
}

const WRAP_WORDS = 14;
const WRAP_CHARS = 90;
const WRAP_MIN_BEFORE_CONJ = 6;
const WRAP_CONJ = /^(and|but|so|because|however|meanwhile|now|then|yet)$/i;

/** Split a run-on ASR paragraph into kiss-translator-sized lines. */
export function wrapPlainTranscript(text: string): string {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (value.length <= WRAP_CHARS && value.split(' ').length <= WRAP_WORDS) return value;

  const words = value.split(' ');
  const lines: string[] = [];
  let bucket: string[] = [];

  const flush = () => {
    if (bucket.length === 0) return;
    lines.push(bucket.join(' '));
    bucket = [];
  };

  for (const word of words) {
    if (bucket.length === 0) {
      bucket.push(word);
      continue;
    }
    const next = `${bucket.join(' ')} ${word}`;
    const prev = bucket[bucket.length - 1];
    const shouldBreak =
      /[.!?。！？…]$/.test(prev)
      || bucket.length >= WRAP_WORDS
      || next.length > WRAP_CHARS
      || (bucket.length >= WRAP_MIN_BEFORE_CONJ && WRAP_CONJ.test(word));
    if (shouldBreak) flush();
    bucket.push(word);
  }
  flush();
  return lines.join('\n');
}
