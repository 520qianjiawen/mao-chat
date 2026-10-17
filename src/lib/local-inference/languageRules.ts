/**
 * Language-level sentence-segmentation config.
 *
 * Add a language by editing languageRules.json — the segmenter engine is generic.
 * ASR and translation must not import these rules; they only consume committed text
 * or ASR-specific knobs derived in asrTuning.ts.
 */

import rawRules from './languageRules.json';

export type SegmentationMode = 'meeting' | 'video';
export type SegmentationUnit = 'words' | 'characters';
export type SegmentationGlue = 'space' | 'none';
export type CommitPunctuation = 'never' | 'if-complete' | 'if-long';
export type ShortHoldRequires = 'none' | 'punctuation' | 'complete-ending';
export type LanguageScript = 'latin' | 'han' | 'kana' | 'hangul';

export interface LanguageModeConfig {
  softSilenceMs: number;
  hardSilenceMs: number;
  shortHoldMs: number;
  minCommitDelayMs: number;
  min: number;
  max: number;
  preferredMin?: number;
  preferredMaxDurationMs: number;
  forceDurationMs: number;
}

export interface LanguageRuleJson {
  extends?: string;
  aliases?: string[];
  script?: LanguageScript;
  unit?: SegmentationUnit;
  glue?: SegmentationGlue;
  commitPunctuation?: CommitPunctuation;
  shortHoldRequires?: ShortHoldRequires;
  hardIncomplete?: string[];
  softIncomplete?: string[];
  completeEndings?: string[];
  completeEndingMinStem?: Record<string, number>;
  greetings?: string[];
  conjunctions?: string[];
  fillers?: string[];
  fillerTokens?: string[];
  strongPauseWords?: string[];
  meeting?: Partial<LanguageModeConfig>;
  video?: Partial<LanguageModeConfig>;
}

export interface ResolvedLanguageRule {
  id: string;
  script: LanguageScript;
  unit: SegmentationUnit;
  glue: SegmentationGlue;
  commitPunctuation: CommitPunctuation;
  shortHoldRequires: ShortHoldRequires;
  hardIncomplete: string[];
  softIncomplete: string[];
  completeEndings: string[];
  completeEndingMinStem: Record<string, number>;
  greetings: string[];
  conjunctions: string[];
  fillers: string[];
  fillerTokens: string[];
  strongPauseWords: string[];
  meeting: LanguageModeConfig;
  video: LanguageModeConfig;
}

export interface SegmentationPreset {
  softSilenceMs: number;
  hardSilenceMs: number;
  shortHoldMs: number;
  minCommitDelayMs: number;
  minWords: number;
  maxWords: number;
  minCjkChars: number;
  maxCjkChars: number;
  preferredMinWords?: number;
  preferredMinCjkChars?: number;
  preferredMaxDurationMs: number;
  forceDurationMs: number;
}

interface LanguageRulesFile {
  defaultLanguage: string;
  languages: Record<string, LanguageRuleJson>;
}

const FILE = rawRules as LanguageRulesFile;

const SCRIPT_DETECT_ORDER: LanguageScript[] = ['kana', 'hangul', 'han', 'latin'];

const SCRIPT_RE: Record<LanguageScript, RegExp> = {
  kana: /[\u3040-\u30ff]/,
  hangul: /[\uac00-\ud7af]/,
  han: /[\u3400-\u9fff]/,
  latin: /[A-Za-z]/,
};

const EMPTY_MODE: LanguageModeConfig = {
  softSilenceMs: 700,
  hardSilenceMs: 1200,
  shortHoldMs: 2400,
  minCommitDelayMs: 0,
  min: 5,
  max: 25,
  preferredMaxDurationMs: 9000,
  forceDurationMs: 11000,
};

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function longestFirst(values: string[]): string[] {
  return uniqueStrings(values).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function mergeMode(
  base: LanguageModeConfig | undefined,
  overlay: Partial<LanguageModeConfig> | undefined,
): LanguageModeConfig {
  return { ...EMPTY_MODE, ...base, ...overlay };
}

function mergeRule(base: ResolvedLanguageRule | undefined, id: string, raw: LanguageRuleJson): ResolvedLanguageRule {
  const hardIncomplete = longestFirst([...(raw.hardIncomplete || []), ...(base?.hardIncomplete || [])]);
  const softIncomplete = longestFirst([...(raw.softIncomplete || []), ...(base?.softIncomplete || [])]);
  const completeEndings = longestFirst([...(raw.completeEndings || []), ...(base?.completeEndings || [])]);
  return {
    id,
    script: raw.script || base?.script || 'latin',
    unit: raw.unit || base?.unit || 'words',
    glue: raw.glue || base?.glue || 'space',
    commitPunctuation: raw.commitPunctuation || base?.commitPunctuation || 'if-long',
    shortHoldRequires: raw.shortHoldRequires || base?.shortHoldRequires || 'none',
    hardIncomplete,
    softIncomplete,
    completeEndings,
    completeEndingMinStem: { ...(base?.completeEndingMinStem || {}), ...(raw.completeEndingMinStem || {}) },
    greetings: uniqueStrings([...(raw.greetings || []), ...(base?.greetings || [])]),
    conjunctions: longestFirst([...(raw.conjunctions || []), ...(base?.conjunctions || [])]),
    fillers: uniqueStrings([...(raw.fillers || []), ...(base?.fillers || [])]),
    fillerTokens: uniqueStrings([...(raw.fillerTokens || []), ...(base?.fillerTokens || [])]),
    strongPauseWords: uniqueStrings([...(raw.strongPauseWords || []), ...(base?.strongPauseWords || [])]),
    meeting: mergeMode(base?.meeting, raw.meeting),
    video: mergeMode(base?.video, raw.video),
  };
}

function resolveRaw(id: string, stack: string[] = []): ResolvedLanguageRule {
  if (!FILE.languages[id]) {
    throw new Error(`Unknown language rule: ${id}`);
  }
  if (stack.includes(id)) {
    throw new Error(`Language rule cycle: ${[...stack, id].join(' -> ')}`);
  }
  const raw = FILE.languages[id];
  const parent = raw.extends ? resolveRaw(raw.extends, [...stack, id]) : undefined;
  return mergeRule(parent, id, raw);
}

const RESOLVED: Record<string, ResolvedLanguageRule> = {};
const ALIAS_TO_ID = new Map<string, string>();

for (const id of Object.keys(FILE.languages)) {
  RESOLVED[id] = resolveRaw(id);
  ALIAS_TO_ID.set(id, id);
  for (const alias of FILE.languages[id].aliases || []) {
    ALIAS_TO_ID.set(alias.toLowerCase(), id);
  }
}

const DEFAULT_ID = FILE.defaultLanguage in RESOLVED ? FILE.defaultLanguage : 'en';

export function normalizeSegmentationMode(value: unknown): SegmentationMode {
  return value === 'video' ? 'video' : 'meeting';
}

export function normalizeLangTag(language?: string | null): string {
  return String(language || '').toLowerCase().replace('_', '-');
}

function idFromTag(language?: string | null): string | undefined {
  const value = normalizeLangTag(language);
  if (!value || value === 'auto') return undefined;
  const primary = value.split('-')[0] || value;
  return ALIAS_TO_ID.get(value) || ALIAS_TO_ID.get(primary);
}

function idFromScript(text: string): string | undefined {
  const sample = String(text || '');
  if (!sample) return undefined;
  for (const script of SCRIPT_DETECT_ORDER) {
    if (!SCRIPT_RE[script].test(sample)) continue;
    const match = Object.values(RESOLVED).find((rule) => rule.script === script);
    if (match) return match.id;
  }
  return undefined;
}

export function looksJapanese(text: string): boolean {
  return SCRIPT_RE.kana.test(String(text || ''));
}

export function looksKorean(text: string): boolean {
  return SCRIPT_RE.hangul.test(String(text || ''));
}

export function looksChinese(text: string): boolean {
  return SCRIPT_RE.han.test(String(text || ''));
}

export function isJapaneseLanguage(language?: string | null): boolean {
  return idFromTag(language) === 'ja';
}

export function isChineseLanguage(language?: string | null): boolean {
  return idFromTag(language) === 'zh';
}

export function isKoreanLanguage(language?: string | null): boolean {
  return idFromTag(language) === 'ko';
}

export function resolveLanguageId(language?: string | null, text?: string): string {
  return idFromTag(language) || idFromScript(String(text || '')) || DEFAULT_ID;
}

export function resolveLanguageRule(language?: string | null, text?: string): ResolvedLanguageRule {
  const id = resolveLanguageId(language, text);
  return RESOLVED[id] || RESOLVED[DEFAULT_ID];
}

export function listConfiguredLanguages(): string[] {
  return Object.keys(RESOLVED);
}

export function modeConfig(rule: ResolvedLanguageRule, mode: SegmentationMode): LanguageModeConfig {
  return rule[normalizeSegmentationMode(mode)];
}

export function getSegmentationPreset(
  mode: SegmentationMode,
  language?: string | null,
  text?: string,
): SegmentationPreset {
  const rule = resolveLanguageRule(language, text);
  const cfg = modeConfig(rule, mode);
  const charMin = rule.unit === 'characters' ? cfg.min : Math.min(cfg.min, 8);
  const charMax = rule.unit === 'characters' ? cfg.max : 50;
  const wordMin = rule.unit === 'words' ? cfg.min : 4;
  const wordMax = rule.unit === 'words' ? cfg.max : 22;
  return {
    softSilenceMs: cfg.softSilenceMs,
    hardSilenceMs: cfg.hardSilenceMs,
    shortHoldMs: cfg.shortHoldMs,
    minCommitDelayMs: cfg.minCommitDelayMs,
    minWords: wordMin,
    maxWords: wordMax,
    minCjkChars: charMin,
    maxCjkChars: charMax,
    preferredMinWords: rule.unit === 'words' ? cfg.preferredMin : undefined,
    preferredMinCjkChars: rule.unit === 'characters' ? cfg.preferredMin : undefined,
    preferredMaxDurationMs: cfg.preferredMaxDurationMs,
    forceDurationMs: cfg.forceDurationMs,
  };
}

export const SEGMENTATION_PRESETS: Record<SegmentationMode, SegmentationPreset> = {
  meeting: getSegmentationPreset('meeting', 'en'),
  video: getSegmentationPreset('video', 'en'),
};

export function latinWords(text: string): string[] {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

export function cleanWord(word: string): string {
  return String(word || '')
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
}

export function stripTrailingPunct(text: string): string {
  return String(text || '').trim().replace(/[.!?。！？…、,;；]+$/u, '');
}

export function visibleCharCount(text: string): number {
  return Array.from(stripTrailingPunct(text).replace(/\s+/g, '')).length;
}

export function countRuleUnits(text: string, rule: ResolvedLanguageRule): number {
  if (rule.unit === 'characters') return visibleCharCount(text);
  return latinWords(text).length;
}

export function lastLatinWord(text: string): string {
  const words = latinWords(text);
  return cleanWord(words[words.length - 1] || '');
}

function matchesList(value: string, list: string[], kind: 'word' | 'suffix'): boolean {
  if (!value || !list.length) return false;
  if (kind === 'word') {
    const lower = stripTrailingPunct(value).toLocaleLowerCase();
    for (const item of list) {
      if (!item) continue;
      if (item.includes(' ')) {
        if (lower === item || lower.endsWith(` ${item}`)) return true;
      } else if (lastLatinWord(value) === item) {
        return true;
      }
    }
    return false;
  }
  return list.some((item) => value === item || value.endsWith(item));
}

export function isGreeting(text: string, rule: ResolvedLanguageRule): boolean {
  const stripped = stripTrailingPunct(text).replace(/\s+/g, '');
  return rule.greetings.some((item) => item === stripped || item === stripTrailingPunct(text));
}

export function isRuleHardIncomplete(text: string, rule: ResolvedLanguageRule): boolean {
  const value = String(text || '').trim();
  if (!value) return true;
  if (isGreeting(value, rule)) return false;
  const stripped = stripTrailingPunct(value);
  const kind = rule.unit === 'words' ? 'word' : 'suffix';
  if (matchesList(stripped, rule.conjunctions, kind) || rule.conjunctions.some((word) => stripped === word)) {
    return true;
  }
  return matchesList(stripped, rule.hardIncomplete, kind);
}

export function isRuleSoftIncomplete(text: string, rule: ResolvedLanguageRule): boolean {
  if (isRuleHardIncomplete(text, rule)) return false;
  const stripped = stripTrailingPunct(text);
  const kind = rule.unit === 'words' ? 'word' : 'suffix';
  return matchesList(stripped, rule.softIncomplete, kind);
}

export function isRuleIncomplete(text: string, rule: ResolvedLanguageRule, opts?: { hard?: boolean }): boolean {
  const value = String(text || '').trim();
  if (!value) return true;
  if (rule.unit === 'words') {
    // Comma / colon / dangling quote is an unfinished clause, even with a later pause.
    if (/[,:;]\s*$/u.test(value) || /(?:^|\s)quote,$/iu.test(value) || /["“]\s*$/u.test(value)) {
      return true;
    }
  }
  // ASR often appends "." at a VAD cut ("allies by."). Prepositions still mean unfinished.
  if (isRuleHardIncomplete(value, rule)) return true;
  if (rule.unit === 'words' && /[.!?。！？…]["'”’\)\]]*$/u.test(value)) return false;
  if (!opts?.hard && isRuleSoftIncomplete(value, rule)) return true;
  return false;
}

export function isRuleCompleteEnding(text: string, rule: ResolvedLanguageRule): boolean {
  const stripped = stripTrailingPunct(text);
  if (!stripped || !rule.completeEndings.length) return false;
  if (isRuleHardIncomplete(text, rule)) return false;
  for (const suffix of rule.completeEndings) {
    if (!stripped.endsWith(suffix)) continue;
    const stemLen = stripped.length - suffix.length;
    const minStem = rule.completeEndingMinStem[suffix] ?? 0;
    if (stemLen < minStem) continue;
    return true;
  }
  return false;
}

export function isRuleStrongComplete(text: string, rule: ResolvedLanguageRule): boolean {
  const value = String(text || '').trim();
  if (!value) return false;
  if (isGreeting(value, rule)) return true;
  return isRuleCompleteEnding(value, rule);
}

export function isRuleComplete(text: string, rule: ResolvedLanguageRule): boolean {
  const value = String(text || '').trim();
  if (!value) return false;
  if (isGreeting(value, rule)) return true;
  if (isRuleIncomplete(value, rule)) return false;
  return isRuleStrongComplete(value, rule);
}

const STRETCHED_FILLER = /^(uh+|um+|er+|ah+|hmm+|嗯+|啊+|呃+|额+|唔+|えー+)$/iu;

export function isRuleFillerOnly(text: string, rule: ResolvedLanguageRule): boolean {
  const value = String(text || '').trim();
  if (!value) return true;
  if (STRETCHED_FILLER.test(value)) return true;
  const lower = stripTrailingPunct(value).toLocaleLowerCase();
  const compact = lower.replace(/\s+/g, '');
  if (rule.fillers.some((filler) => filler === lower || filler === compact)) return true;

  if (rule.unit === 'characters' && rule.fillers.length) {
    let rest = compact;
    let changed = true;
    while (changed && rest) {
      changed = false;
      for (const filler of rule.fillers) {
        if (rest === filler || rest.startsWith(filler)) {
          rest = rest.slice(filler.length);
          changed = true;
          break;
        }
      }
    }
    if (!rest) return true;
  }

  if (rule.unit === 'words') {
    const words = latinWords(lower).map(cleanWord).filter(Boolean);
    if (!words.length) return true;
    if (words.every((word) => rule.fillerTokens.includes(word) || rule.fillers.includes(word))) return true;
  }
  return false;
}
