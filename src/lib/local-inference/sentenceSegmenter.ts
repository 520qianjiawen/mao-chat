/**
 * Generic sentence buffer + segmenter.
 *
 * Language rules live in languageRules.json. This engine only:
 *   1. holds Pending text
 *   2. decides when to Commit using the resolved language rule
 *
 *   Streaming ASR → Sentence Buffer → Commit → Translation
 *
 * Translation must not run on ASR finals. It only sees Committed text.
 */

import {
  cleanWord,
  countRuleUnits,
  getSegmentationPreset,
  isRuleComplete,
  isRuleFillerOnly,
  isRuleHardIncomplete,
  isRuleIncomplete,
  isRuleStrongComplete,
  lastLatinWord,
  latinWords,
  resolveLanguageRule,
  stripTrailingPunct,
  type ResolvedLanguageRule,
  type SegmentationMode,
  type SegmentationPreset,
} from './languageRules';
import {
  audioSpanFullyCommitted,
  leadingTokenOverlap,
  spanEndSample,
  stripOverlappingPrefix,
  tokensShareStem,
  type AsrAudioSpan,
} from './overlapDedup';

export type { SegmentationMode, SegmentationPreset };
export type { ResolvedLanguageRule } from './languageRules';
export {
  SEGMENTATION_PRESETS,
  getSegmentationPreset,
  isChineseLanguage,
  isJapaneseLanguage,
  isKoreanLanguage,
  looksChinese,
  looksJapanese,
  looksKorean,
  normalizeLangTag,
  normalizeSegmentationMode,
  resolveLanguageId,
  resolveLanguageRule,
  listConfiguredLanguages,
} from './languageRules';

export type CommitReason =
  | 'punctuation'
  | 'predicate'
  | 'soft-silence'
  | 'hard-silence'
  | 'short-hold'
  | 'preferred-duration'
  | 'max-words'
  | 'force-duration'
  | 'flush';

const SENTENCE_END_RE = /[.!?。！？…]["'”’\)\]]*$/u;
const SENTENCE_END_SPLIT_RE = /.*?[.!?。！？…]["'”’\)\]]*(?=\s*[\p{L}\p{N}])/u;
const CONTINUATION_START = new Set([
  'the', 'a', 'an', 'and', 'but', 'or', 'nor', 'so',
  'because', 'if', 'when', 'while', 'although', 'though',
  'to', 'of', 'for', 'with', 'in', 'on', 'at', 'by', 'from', 'into', 'onto',
  'including', 'that', 'which', 'who', 'whose', 'whom', 'where',
  'as', 'than', 'then', 'also', 'just', 'even', 'still',
]);

export function hasSentencePunctuation(text: string): boolean {
  return SENTENCE_END_RE.test(String(text || '').trim());
}

export function isMostlyCjk(text: string): boolean {
  const visible = Array.from(String(text || '').replace(/\s/g, ''));
  if (!visible.length) return false;
  const cjk = (String(text || '').match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return cjk / visible.length >= 0.5;
}

export function countUnits(text: string): { words: number; cjkChars: number; cjk: boolean } {
  const value = String(text || '').trim();
  if (!value) return { words: 0, cjkChars: 0, cjk: false };
  const cjk = isMostlyCjk(value);
  return {
    words: latinWords(value).length,
    cjkChars: Array.from(value.replace(/\s+/g, '')).length,
    cjk,
  };
}

/** Next ASR chunk continues the previous clause rather than starting a sentence. */
export function isContinuationStart(text: string, language?: string): boolean {
  const value = String(text || '').trim();
  if (!value) return false;
  const rule = resolveLanguageRule(language, value);
  if (rule.unit !== 'words') return false;
  if (/^[\p{Ll}]/u.test(value)) return true;
  const first = cleanWord(latinWords(value)[0] || '');
  if (!first) return false;
  if (CONTINUATION_START.has(first)) return true;
  if (first.length > 5 && first.endsWith('ing')) return true;
  return false;
}

function isShortStreamingTail(text: string, language?: string): boolean {
  const value = String(text || '').trim();
  if (!value) return false;
  const rule = resolveLanguageRule(language, value);
  if (rule.unit !== 'words') return false;
  const n = latinWords(value).length;
  if (n === 0 || n > 10) return false;
  const first = cleanWord(latinWords(value)[0] || '');
  if (first.length > 5 && first.endsWith('ing')) return true;
  if (first === 'to' && n <= 8) return true;
  if (['and', 'or', 'but', 'nor', 'including'].includes(first) && n <= 10) return true;
  return false;
}

function lastCommitLooksOpen(
  text: string,
  language: string | undefined,
  preset: SegmentationPreset,
): boolean {
  const value = String(text || '').trim();
  if (!value) return false;
  if (isIncompleteEnding(value, { language })) return true;
  const rule = resolveLanguageRule(language, value);
  const n = countRuleUnits(value, rule);
  if (rule.unit === 'words' && preset.preferredMinWords && n < preset.preferredMinWords) return true;
  return false;
}

export function joinUtterance(prefix: string, next: string, language?: string): string {
  const left = String(prefix || '').trim();
  const right = String(next || '').trim();
  if (!left) return right;
  if (!right) return left;
  const delta = stripOverlappingPrefix(left, right);
  if (!delta) return left;
  const rule = resolveLanguageRule(language, left + delta);
  if (rule.glue === 'none') return stripTrailingPunct(left) + delta;
  const glueContinuation = isIncompleteEnding(left, { language })
    || isContinuationStart(delta, language)
    || latinWords(left).length < 5;
  let glueLeft = glueContinuation ? stripTrailingPunct(left) : left;
  const leftWords = latinWords(glueLeft);
  const deltaWords = latinWords(delta);
  if (leftWords.length && deltaWords.length) {
    const last = cleanWord(leftWords[leftWords.length - 1] || '');
    const first = cleanWord(deltaWords[0] || '');
    if (tokensShareStem(last, first)) {
      glueLeft = leftWords.slice(0, -1).join(' ');
    }
  }
  if (!glueLeft) return delta;
  return `${glueLeft} ${delta}`;
}

export function isFillerOnly(text: string, language?: string): boolean {
  return isRuleFillerOnly(text, resolveLanguageRule(language, text));
}

export function isIncompleteEnding(text: string, opts?: { hard?: boolean; language?: string }): boolean {
  const value = String(text || '').trim();
  if (!value) return true;
  const rule = resolveLanguageRule(opts?.language, value);
  return isRuleIncomplete(value, rule, { hard: opts?.hard });
}

export function isJapaneseConnectiveEnding(text: string): boolean {
  return isRuleHardIncomplete(text, resolveLanguageRule('ja', text));
}

export function isJapaneseComplete(text: string): boolean {
  return isRuleComplete(text, resolveLanguageRule('ja', text));
}

export function isJapaneseIncomplete(text: string): boolean {
  return isRuleIncomplete(text, resolveLanguageRule('ja', text));
}

export function isJapaneseStrongComplete(text: string): boolean {
  return isRuleStrongComplete(text, resolveLanguageRule('ja', text));
}

export function isChineseIncomplete(text: string, opts?: { hard?: boolean }): boolean {
  return isRuleIncomplete(text, resolveLanguageRule('zh', text), opts);
}

export function isKoreanComplete(text: string): boolean {
  return isRuleComplete(text, resolveLanguageRule('ko', text));
}

export function isKoreanIncomplete(text: string, opts?: { hard?: boolean }): boolean {
  return isRuleIncomplete(text, resolveLanguageRule('ko', text), opts);
}

/** Live MT waits for a sentence-buffer commit in every language. */
export function shouldTranslatePending(text: string, language?: string): boolean {
  const value = String(text || '').trim();
  if (!value || isFillerOnly(value, language)) return false;
  return false;
}

function ruleFor(language: string | undefined, text: string): ResolvedLanguageRule {
  return resolveLanguageRule(language, text);
}

function isShort(text: string, preset: SegmentationPreset, language?: string): boolean {
  const rule = ruleFor(language, text);
  if (isRuleStrongComplete(text, rule)) return false;
  const n = countRuleUnits(text, rule);
  const min = rule.unit === 'characters' ? preset.minCjkChars : preset.minWords;
  return n > 0 && n < min;
}

function meetsMinLength(text: string, preset: SegmentationPreset, language?: string): boolean {
  const rule = ruleFor(language, text);
  const n = countRuleUnits(text, rule);
  return rule.unit === 'characters' ? n >= preset.minCjkChars : n >= preset.minWords;
}

function exceedsMaxLength(text: string, preset: SegmentationPreset, language?: string): boolean {
  const rule = ruleFor(language, text);
  const n = countRuleUnits(text, rule);
  return rule.unit === 'characters' ? n >= preset.maxCjkChars : n >= preset.maxWords;
}

function isSemanticallyComplete(text: string, preset: SegmentationPreset, language?: string): boolean {
  const value = String(text || '').trim();
  const rule = ruleFor(language, value);
  if (!value || isRuleFillerOnly(value, rule)) return false;
  if (isRuleIncomplete(value, rule)) return false;
  if (isRuleComplete(value, rule)) return true;
  if (hasSentencePunctuation(value) && rule.commitPunctuation !== 'never') {
    // Video English: ASR puts "." on VAD cuts ("the Navy."). That is not a sentence.
    if (rule.unit === 'words' && preset.preferredMinWords
      && countRuleUnits(value, rule) < preset.preferredMinWords) {
      return false;
    }
    return true;
  }
  if (rule.unit === 'words' && preset.preferredMinWords) {
    return countRuleUnits(value, rule) >= preset.preferredMinWords;
  }
  return meetsMinLength(value, preset, language);
}

function splitOffCompleteSentence(text: string, minHeadUnits: number): { head: string; tail: string } | null {
  const value = String(text || '').trim();
  if (!value) return null;
  const match = value.match(SENTENCE_END_SPLIT_RE);
  if (!match) return null;
  const head = match[0].trim();
  const tail = value.slice(match[0].length).trim();
  if (!head || !tail) return null;
  const units = countUnits(head);
  const enough = units.cjk
    ? units.cjkChars >= Math.min(4, minHeadUnits)
    : units.words >= Math.min(5, minHeadUnits);
  if (!enough && !hasSentencePunctuation(head)) return null;
  if (!units.cjk && units.words < 5) return null;
  return { head, tail };
}

function splitOffFinishedHead(
  text: string,
  language: string | undefined,
  preset: SegmentationPreset,
): { head: string; tail: string } | null {
  const value = String(text || '').trim();
  if (!value) return null;
  const rule = ruleFor(language, value);
  const minUnits = rule.unit === 'characters' ? preset.minCjkChars : preset.minWords;

  const punct = splitOffCompleteSentence(value, 2);
  if (punct && !isRuleIncomplete(punct.head, rule)) {
    const tooTiny = isShort(punct.head, preset, language) && !hasSentencePunctuation(punct.head);
    const continuationTail = rule.unit === 'words' && isContinuationStart(punct.tail, language);
    if (
      !tooTiny
      && !continuationTail
      && !(rule.commitPunctuation === 'never' && !isRuleStrongComplete(punct.head, rule))
    ) {
      return punct;
    }
  }

  if (rule.unit !== 'characters' || !rule.completeEndings.length) return null;

  const chars = Array.from(value);
  const start = Math.max(4, Math.min(minUnits, 8));
  for (let i = start; i < chars.length; i++) {
    const head = chars.slice(0, i).join('');
    if (!isRuleStrongComplete(head, rule) || isRuleIncomplete(head, rule)) continue;
    const tail = chars.slice(i).join('').trim();
    if (!tail) continue;
    return { head: head.trim(), tail };
  }
  return null;
}

function findCharacterForceSplit(
  text: string,
  language: string | undefined,
  preset: SegmentationPreset,
): { head: string; tail: string } | null {
  const value = String(text || '').trim();
  if (!value) return null;
  const rule = ruleFor(language, value);
  const chars = Array.from(value);
  const min = Math.min(preset.minCjkChars, Math.max(1, chars.length - 1));
  const preferredMin = Math.min(
    preset.preferredMinCjkChars ?? Math.max(preset.minCjkChars, 20),
    chars.length - 1,
  );
  const max = Math.min(preset.maxCjkChars, chars.length);

  const tryWindow = (lo: number, hi: number): { head: string; tail: string } | null => {
    for (let i = Math.min(hi, chars.length - 1); i >= lo; i--) {
      const head = chars.slice(0, i).join('');
      if (isRuleStrongComplete(head, rule) && !isRuleIncomplete(head, rule)) {
        const tail = chars.slice(i).join('').trim();
        if (tail) return { head: head.trim(), tail };
      }
    }
    for (let i = Math.min(hi, chars.length - 1); i >= lo; i--) {
      if (/[。！？!?…]/.test(chars[i - 1] || '')) {
        const head = chars.slice(0, i).join('').trim();
        if (isRuleIncomplete(head, rule)) continue;
        return { head, tail: chars.slice(i).join('').trim() };
      }
    }
    for (let i = Math.min(hi, chars.length - 1); i >= lo; i--) {
      const tail = chars.slice(i).join('');
      if (rule.conjunctions.some((word) => tail.startsWith(word))) {
        const head = chars.slice(0, i).join('').trim();
        if (head && !isRuleIncomplete(head, rule)) {
          return { head, tail: tail.trim() };
        }
      }
    }
    return null;
  };

  return tryWindow(preferredMin, max) || tryWindow(min, max) || (() => {
    if (chars.length <= min) return null;
    let at = Math.max(min, Math.min(max, chars.length - 1));
    while (at > min && isRuleIncomplete(chars.slice(0, at).join(''), rule)) at -= 1;
    return {
      head: chars.slice(0, at).join('').trim(),
      tail: chars.slice(at).join('').trim(),
    };
  })();
}

function findForceSplit(
  text: string,
  preset: SegmentationPreset,
  language?: string,
): { head: string; tail: string } | null {
  const value = String(text || '').trim();
  if (!value) return null;
  const rule = ruleFor(language, value);

  if (rule.unit === 'characters') {
    return splitOffFinishedHead(value, language, preset) || findCharacterForceSplit(value, language, preset);
  }

  const punct = splitOffCompleteSentence(value, 2);
  if (
    punct
    && !isRuleIncomplete(punct.head, rule)
    && !(rule.unit === 'words' && isContinuationStart(punct.tail, language))
  ) {
    return punct;
  }

  const words = latinWords(value);
  if (words.length < 2) return null;
  const max = Math.min(preset.maxWords, words.length);
  const min = Math.min(preset.minWords, Math.max(1, max - 1));
  const incompleteWords = new Set(rule.hardIncomplete);
  const pauseWords = new Set(rule.strongPauseWords);

  for (let boundary = Math.min(max, words.length - 1); boundary >= min; boundary--) {
    if (SENTENCE_END_RE.test(words[boundary - 1] || '')) {
      return { head: words.slice(0, boundary).join(' '), tail: words.slice(boundary).join(' ') };
    }
  }

  for (let boundary = Math.min(max, words.length - 1); boundary >= min; boundary--) {
    const next = lastLatinWord(words[boundary] || '');
    const prev = lastLatinWord(words[boundary - 1] || '');
    if (pauseWords.has(next) && !incompleteWords.has(prev)) {
      return { head: words.slice(0, boundary).join(' '), tail: words.slice(boundary).join(' ') };
    }
  }

  for (let boundary = Math.min(max, words.length - 1); boundary >= min; boundary--) {
    if (/[,;:]["'”’\)\]]*$/u.test(words[boundary - 1] || '')) {
      const prev = lastLatinWord(words[boundary - 1] || '');
      if (!incompleteWords.has(prev)) {
        return { head: words.slice(0, boundary).join(' '), tail: words.slice(boundary).join(' ') };
      }
    }
  }

  let splitAt = Math.min(max, words.length - 1);
  while (splitAt > min && incompleteWords.has(lastLatinWord(words[splitAt - 1] || ''))) {
    splitAt -= 1;
  }
  if (splitAt < min || splitAt >= words.length) return null;
  return { head: words.slice(0, splitAt).join(' '), tail: words.slice(splitAt).join(' ') };
}

export interface SentenceSegmenterOptions {
  mode?: SegmentationMode;
  language?: string;
  onPending?: (text: string) => void;
  onCommit?: (text: string, reason: CommitReason, segmentId: number) => void;
}

export class SentenceSegmenter {
  private preset: SegmentationPreset;
  private mode: SegmentationMode;
  private language?: string;
  private stable = '';
  private live = '';
  private lastActivityAt = 0;
  private utteranceStartedAt = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private onPending: (text: string) => void;
  private onCommit: (text: string, reason: CommitReason, segmentId: number) => void;
  private nextSegmentId = 1;
  private lastCommitted = '';
  private lastCommittedAt = 0;
  private lastCommitId = 0;
  /** Text already committed to captions / translation — never re-ingested. */
  private lockedText = '';
  /** Sidecar 16 kHz sample cursor already covered by lockedText. */
  private lockedEndSample = 0;
  private pendingEndSample = 0;

  constructor(options: SentenceSegmenterOptions = {}) {
    this.mode = options.mode === 'video' ? 'video' : 'meeting';
    this.language = options.language;
    this.preset = getSegmentationPreset(this.mode, this.language);
    this.onPending = options.onPending ?? (() => {});
    this.onCommit = options.onCommit ?? (() => {});
  }

  setMode(mode: SegmentationMode): void {
    this.mode = mode === 'video' ? 'video' : 'meeting';
    this.preset = getSegmentationPreset(this.mode, this.language);
    if (this.hasPending()) this.reschedule();
  }

  setLanguage(language?: string): void {
    this.language = language;
    this.preset = getSegmentationPreset(this.mode, this.language);
    if (this.hasPending()) this.reschedule();
  }

  getMode(): SegmentationMode {
    return this.mode;
  }

  getPending(): string {
    return joinUtterance(this.stable, this.live, this.language);
  }

  ingestPartial(text: string, span?: AsrAudioSpan): void {
    const incoming = String(text || '').trim();
    if (this.reopenLastIfContinuation(incoming)) {
      this.noteSpan(span);
      this.live = '';
      this.markActivity(false);
      this.clearTimers();
      this.emitPending();
      return;
    }
    const next = this.novelText(text, span);
    if (!next) {
      // Duplicate of locked/stable text — keep the current pending caption.
      return;
    }
    this.noteSpan(span);
    if (this.reviseRollingHypothesis(incoming)) {
      this.live = '';
    } else {
      this.live = next;
    }
    this.markActivity(false);
    this.clearTimers();
    this.emitPending();
  }

  ingestFinal(text: string, span?: AsrAudioSpan): void {
    const incoming = String(text || '').trim();
    if (this.reopenLastIfContinuation(incoming)) {
      this.noteSpan(span);
      this.preset = getSegmentationPreset(this.mode, this.language, this.stable);
      this.live = '';
      this.markActivity(true);
      this.emitPending();
      this.drainComplete();
      if (this.hasPending()) {
        if (exceedsMaxLength(this.stable, this.preset, this.language)) {
          this.evaluate('max-words');
        }
        this.reschedule();
      }
      return;
    }
    const chunk = this.novelText(text, span);
    if (!chunk) return;
    if (chunk === this.lastCommitted && Date.now() - this.lastCommittedAt < 2000) return;
    this.noteSpan(span);
    this.preset = getSegmentationPreset(this.mode, this.language, chunk);
    if (!this.reviseRollingHypothesis(incoming)) {
      this.stable = joinUtterance(this.stable, chunk, this.language);
    }
    this.live = '';
    this.markActivity(true);
    this.emitPending();
    this.drainComplete();
    if (this.hasPending()) {
      if (exceedsMaxLength(this.stable, this.preset, this.language)) {
        this.evaluate('max-words');
      }
      this.reschedule();
    }
  }

  notifySpeechStart(): void {
    this.clearTimers();
    this.lastActivityAt = Date.now();
  }

  flush(): void {
    this.clearTimers();
    const text = this.getPending().trim();
    this.stable = '';
    this.live = '';
    this.utteranceStartedAt = 0;
    if (text && !isFillerOnly(text, this.language)) {
      this.emitCommit(text, 'flush');
    } else {
      this.emitPending();
    }
  }

  reset(): void {
    this.clearTimers();
    this.stable = '';
    this.live = '';
    this.utteranceStartedAt = 0;
    this.lastActivityAt = 0;
    this.lastCommitted = '';
    this.lastCommitId = 0;
    this.lockedText = '';
    this.lockedEndSample = 0;
    this.pendingEndSample = 0;
    this.nextSegmentId = 1;
    this.emitPending();
  }

  dispose(): void {
    this.reset();
    this.onPending = () => {};
    this.onCommit = () => {};
  }

  private hasPending(): boolean {
    return Boolean(this.stable.trim() || this.live.trim());
  }

  private markActivity(startsUtteranceClock: boolean): void {
    const now = Date.now();
    this.lastActivityAt = now;
    if (!this.utteranceStartedAt || startsUtteranceClock && !this.stable && !this.live) {
      this.utteranceStartedAt = now;
    }
    if (!this.utteranceStartedAt) this.utteranceStartedAt = now;
  }

  private emitPending(): void {
    this.onPending(this.getPending());
  }

  private reviseRollingHypothesis(incoming: string): boolean {
    if (!this.stable || !incoming) return false;
    if (incoming.length < this.stable.length) return false;
    if (leadingTokenOverlap(this.stable, incoming) < 4) return false;
    const revised = stripOverlappingPrefix(this.lockedText, incoming);
    if (!revised) return false;
    this.stable = revised;
    return true;
  }

  private shouldReopenLast(incoming: string): boolean {
    if (!this.lastCommitted || this.hasPending() || !incoming) return false;
    if (Date.now() - this.lastCommittedAt > 4000) return false;
    const lastCore = stripTrailingPunct(this.lastCommitted).toLocaleLowerCase();
    const incomingCmp = incoming.toLocaleLowerCase();
    const exactPrefix = incomingCmp.startsWith(lastCore)
      || incomingCmp.startsWith(this.lastCommitted.toLocaleLowerCase());
    if (
      !exactPrefix
      && leadingTokenOverlap(this.lastCommitted, incoming) >= 4
      && incoming.trim().length > this.lastCommitted.length
    ) {
      // Longer hypothesis that revises the last caption (Navy → naval blockade).
      return true;
    }
    if (isShortStreamingTail(incoming, this.language)) return true;
    if (
      lastCommitLooksOpen(this.lastCommitted, this.language, this.preset)
      && isContinuationStart(incoming, this.language)
      && latinWords(incoming).length <= 12
    ) {
      return true;
    }
    return false;
  }

  private reopenLastCommit(): string {
    const prev = this.lastCommitted.trim();
    if (!prev) return '';
    const locked = this.lockedText.trim();
    const lockedCmp = locked.toLocaleLowerCase();
    const prevCmp = prev.toLocaleLowerCase();
    if (lockedCmp.endsWith(prevCmp)) {
      this.lockedText = locked.slice(0, locked.length - prev.length).trim();
    }
    if (this.lastCommitId > 0) this.nextSegmentId = this.lastCommitId;
    this.lastCommitted = '';
    return prev;
  }

  private reopenLastIfContinuation(incoming: string): boolean {
    if (!this.shouldReopenLast(incoming)) return false;
    const prev = this.reopenLastCommit();
    if (!prev) return false;
    this.stable = joinUtterance(prev, incoming, this.language);
    this.live = '';
    return true;
  }

  private novelText(text: string, span?: AsrAudioSpan): string {
    const incoming = String(text || '').trim();
    if (!incoming) return '';
    if (audioSpanFullyCommitted(span, this.lockedEndSample)) return '';
    const seen = joinUtterance(this.lockedText, this.stable, this.language);
    return stripOverlappingPrefix(seen, incoming);
  }

  private noteSpan(span?: AsrAudioSpan): void {
    const end = spanEndSample(span);
    if (end != null && end > this.pendingEndSample) this.pendingEndSample = end;
  }

  private emitCommit(text: string, reason: CommitReason): void {
    const value = text.trim();
    if (!value) return;
    const now = Date.now();
    if (value === this.lastCommitted && now - this.lastCommittedAt < 800) return;
    this.lastCommitted = value;
    this.lastCommittedAt = now;
    this.lockedText = joinUtterance(this.lockedText, value, this.language);
    if (this.pendingEndSample > this.lockedEndSample) {
      this.lockedEndSample = this.pendingEndSample;
    }
    const segmentId = this.nextSegmentId++;
    this.lastCommitId = segmentId;
    this.onCommit(value, reason, segmentId);
  }

  private drainComplete(): void {
    while (this.stable.trim()) {
      const rule = ruleFor(this.language, this.stable);
      const finished = splitOffFinishedHead(this.stable, this.language, this.preset);
      if (finished) {
        this.emitCommit(finished.head, rule.completeEndings.length ? 'predicate' : 'punctuation');
        this.stable = finished.tail;
        this.utteranceStartedAt = Date.now();
        this.emitPending();
        continue;
      }
      if (rule.commitPunctuation === 'never') break;
      if (
        hasSentencePunctuation(this.stable)
        && !isFillerOnly(this.stable, this.language)
        && !isIncompleteEnding(this.stable, { language: this.language })
        && !isShort(this.stable, this.preset, this.language)
        && !(
          this.preset.preferredMinWords
          && countRuleUnits(this.stable, rule) < this.preset.preferredMinWords
        )
      ) {
        this.emitCommit(this.stable.trim(), 'punctuation');
        this.stable = '';
        this.utteranceStartedAt = 0;
        this.emitPending();
        continue;
      }
      break;
    }
  }

  private committableText(): string {
    return (this.stable.trim() || this.live.trim());
  }

  private evaluate(reason: CommitReason): void {
    const text = this.committableText();
    if (!text) return;
    const rule = ruleFor(this.language, text);
    if (isFillerOnly(text, this.language) && reason !== 'force-duration' && reason !== 'flush') return;

    const silenceMs = Date.now() - this.lastActivityAt;
    const durationMs = this.utteranceStartedAt ? Date.now() - this.utteranceStartedAt : 0;
    const incompleteHard = isIncompleteEnding(text, { hard: true, language: this.language });
    const incompleteSoft = isIncompleteEnding(text, { language: this.language });
    const complete = isSemanticallyComplete(text, this.preset, this.language);
    const short = isShort(text, this.preset, this.language);
    const minDelay = this.preset.minCommitDelayMs || 0;
    if (
      minDelay > 0 &&
      reason !== 'flush' &&
      reason !== 'max-words' &&
      reason !== 'force-duration' &&
      silenceMs < minDelay - 20
    ) {
      return;
    }

    const commitAll = (commitReason: CommitReason) => {
      this.clearTimers();
      this.stable = '';
      this.live = '';
      this.utteranceStartedAt = 0;
      this.emitCommit(text, commitReason);
      this.emitPending();
    };

    const commitSplit = (commitReason: CommitReason, force: boolean) => {
      const split = findForceSplit(text, this.preset, this.language);
      if (split?.head && split.tail) {
        this.clearTimers();
        this.emitCommit(split.head, commitReason);
        this.stable = split.tail;
        this.live = '';
        this.utteranceStartedAt = Date.now();
        this.emitPending();
        this.reschedule();
        return true;
      }
      if (force && !incompleteHard) {
        commitAll(commitReason);
        return true;
      }
      return false;
    };

    switch (reason) {
      case 'punctuation':
      case 'predicate':
        this.drainComplete();
        return;
      case 'soft-silence':
        if (silenceMs < this.preset.softSilenceMs - 20) return;
        if (short || incompleteSoft || !complete) return;
        commitAll('soft-silence');
        return;
      case 'hard-silence':
        if (silenceMs < this.preset.hardSilenceMs - 20) return;
        if (incompleteHard) return;
        if (short) return;
        if (
          this.preset.preferredMinWords
          && countRuleUnits(text, rule) < this.preset.preferredMinWords
          && hasSentencePunctuation(text)
        ) {
          return;
        }
        commitAll('hard-silence');
        return;
      case 'short-hold':
        if (silenceMs < this.preset.shortHoldMs - 20) return;
        if (!short) return;
        if (incompleteHard) return;
        if (rule.shortHoldRequires === 'complete-ending' && !isRuleStrongComplete(text, rule)) return;
        if (rule.shortHoldRequires === 'punctuation' && !hasSentencePunctuation(text)) return;
        // English video: do not commit "To restart talks." as its own caption.
        if (this.preset.preferredMinWords) return;
        commitAll('short-hold');
        return;
      case 'preferred-duration':
        if (durationMs < this.preset.preferredMaxDurationMs - 20) return;
        if (incompleteHard && !exceedsMaxLength(text, this.preset, this.language)) return;
        commitSplit('preferred-duration', false);
        return;
      case 'max-words':
        if (!exceedsMaxLength(text, this.preset, this.language)) return;
        commitSplit('max-words', true);
        return;
      case 'force-duration':
        if (durationMs < this.preset.forceDurationMs - 20) return;
        if (!commitSplit('force-duration', true) && text) {
          commitAll('force-duration');
        }
        return;
      case 'flush':
        commitAll('flush');
        return;
    }
  }

  private reschedule(): void {
    this.clearTimers();
    if (!this.hasPending()) return;
    const now = Date.now();
    const sinceActivity = now - this.lastActivityAt;
    const sinceStart = this.utteranceStartedAt ? now - this.utteranceStartedAt : 0;
    const later = (delay: number, reason: CommitReason) => {
      const wait = Math.max(0, delay);
      this.timers.push(setTimeout(() => this.evaluate(reason), wait));
    };
    const minDelay = this.preset.minCommitDelayMs || 0;
    later(Math.max(minDelay, this.preset.softSilenceMs) - sinceActivity, 'soft-silence');
    later(Math.max(minDelay, this.preset.hardSilenceMs) - sinceActivity, 'hard-silence');
    later(Math.max(minDelay, this.preset.shortHoldMs) - sinceActivity, 'short-hold');
    later(this.preset.preferredMaxDurationMs - sinceStart, 'preferred-duration');
    later(this.preset.forceDurationMs - sinceStart, 'force-duration');
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}
