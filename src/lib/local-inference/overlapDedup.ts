/**
 * Overlap dedup for streaming ASR.
 *
 * Rolling-window recognizers re-emit the whole hypothesis on every chunk.
 * Committed text and audio must never re-enter captions or translation.
 */

const TRAILING_PUNCT = /[.!?。！？…、,;；]+$/u;
const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;

function stripTrailingPunct(text: string): string {
  return String(text || '').trim().replace(TRAILING_PUNCT, '');
}

function isMostlyCjk(text: string): boolean {
  const visible = Array.from(String(text || '').replace(/\s/g, ''));
  if (!visible.length) return false;
  const cjk = visible.filter((ch) => CJK_RE.test(ch)).length;
  return cjk / visible.length >= 0.5;
}

function tokens(text: string): { raw: string[]; cmp: string[]; cjk: boolean } {
  const value = stripTrailingPunct(text);
  if (!value) return { raw: [], cmp: [], cjk: false };
  const cjk = isMostlyCjk(value);
  if (cjk) {
    const parts = Array.from(value.replace(/\s+/g, ''));
    return { raw: parts, cmp: parts, cjk: true };
  }
  const raw = value.split(/\s+/).filter(Boolean);
  const cmp = raw.map((word) =>
    word.toLocaleLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ''),
  );
  return { raw, cmp, cjk: false };
}

function detokenize(parts: string[], cjk: boolean): string {
  return cjk ? parts.join('') : parts.join(' ');
}

const CLOSED_CLASS = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'by', 'for',
  'and', 'or', 'but', 'is', 'are', 'was', 'be', 'it', 'as',
]);

/** ASR often revises the last word of a cut: Navy/naval, block/blockade. */
export function tokensShareStem(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (CLOSED_CLASS.has(a) || CLOSED_CLASS.has(b)) return false;
  if (a.length < 4 || b.length < 4) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (longer.startsWith(shorter)) return true;
  let n = 0;
  while (n < shorter.length && shorter[n] === longer[n]) n += 1;
  return n >= 3 && Math.abs(a.length - b.length) <= 2;
}

function tokensEqual(a: string, b: string): boolean {
  return a === b || tokensShareStem(a, b);
}

/** How many leading tokens of `incoming` match the start of `published`. */
export function leadingTokenOverlap(published: string, incoming: string): number {
  const a = tokens(published).cmp.filter(Boolean);
  const b = tokens(incoming).cmp.filter(Boolean);
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && tokensEqual(a[i], b[i])) i += 1;
  return i;
}

/**
 * Return the suffix of `incoming` that is not already present as a suffix of
 * `published`. Empty string means the incoming span is fully covered.
 */
export function stripOverlappingPrefix(published: string, incoming: string): string {
  const prev = String(published || '').trim();
  const next = String(incoming || '').trim();
  if (!next) return '';
  if (!prev) return next;
  if (next === prev) return '';

  const prevCore = stripTrailingPunct(prev);
  if (next === prevCore) return '';
  const nextCmp = next.toLocaleLowerCase();
  const prevCmp = prevCore.toLocaleLowerCase();
  if (nextCmp === prevCmp) return '';
  if (nextCmp.startsWith(prevCmp)) return next.slice(prevCore.length).trim();
  if (prevCmp.endsWith(nextCmp) && prevCore.length >= next.length) return '';

  const a = tokens(prev);
  const b = tokens(next);
  const cjk = a.cjk || b.cjk;
  const maxK = Math.min(a.cmp.length, b.cmp.length);
  const minK = cjk ? 2 : 1;
  for (let k = maxK; k >= minK; k--) {
    let match = true;
    let stemAt = -1;
    for (let i = 0; i < k; i++) {
      const pa = a.cmp[a.cmp.length - k + i];
      const pb = b.cmp[i];
      if (pa === pb) continue;
      if (!cjk && i === k - 1 && tokensShareStem(pa, pb)) {
        stemAt = i;
        continue;
      }
      match = false;
      break;
    }
    if (match) {
      // Keep the incoming form of a revised last token (Navy → naval).
      const from = stemAt >= 0 ? stemAt : k;
      let tail = detokenize(b.raw.slice(from), cjk).trim();
      const punct = next.match(TRAILING_PUNCT)?.[0] || '';
      if (tail && punct && !TRAILING_PUNCT.test(tail)) tail += punct;
      return tail;
    }
  }
  return next;
}

export interface AsrAudioSpan {
  startSample?: number;
  durationMs?: number;
}

/** 16 kHz sidecar PCM: 16 samples per millisecond. */
export function spanEndSample(span?: AsrAudioSpan): number | undefined {
  if (!span || span.startSample == null || span.durationMs == null || span.durationMs <= 0) {
    return undefined;
  }
  return span.startSample + Math.round(span.durationMs * 16);
}

export function audioSpanFullyCommitted(span: AsrAudioSpan | undefined, lockedEndSample: number): boolean {
  const end = spanEndSample(span);
  if (end == null || lockedEndSample <= 0) return false;
  const start = span?.startSample ?? 0;
  // Many engines report startSample=0 on every chunk. After the first commit
  // that would make every later span look "already covered" and captions die.
  if (start === 0 && lockedEndSample > 0) return false;
  return end <= lockedEndSample;
}
