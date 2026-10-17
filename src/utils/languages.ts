import { LanguageOption } from '../services/providers/ProviderConfig';

/** Shared language display name registry — single source of truth for code → display name */
export const LANGUAGE_OPTIONS: Record<string, LanguageOption> = {
  auto: { name: '自动检测', value: 'auto', englishName: 'Auto Detect' },
  af: { name: 'Afrikaans', value: 'af', englishName: 'Afrikaans' },
  ar: { name: 'العربية', value: 'ar', englishName: 'Arabic' },
  // bat: { name: 'Baltic', value: 'bat', englishName: 'Baltic Languages' },
  bg: { name: 'Български', value: 'bg', englishName: 'Bulgarian' },
  bn: { name: 'বাংলা', value: 'bn', englishName: 'Bengali' },
  ca: { name: 'Català', value: 'ca', englishName: 'Catalan' },
  cs: { name: 'Čeština', value: 'cs', englishName: 'Czech' },
  da: { name: 'Dansk', value: 'da', englishName: 'Danish' },
  de: { name: 'Deutsch', value: 'de', englishName: 'German' },
  en: { name: 'English', value: 'en', englishName: 'English' },
  el: { name: 'Ελληνικά', value: 'el', englishName: 'Greek' },
  es: { name: 'Español', value: 'es', englishName: 'Spanish' },
  et: { name: 'Eesti', value: 'et', englishName: 'Estonian' },
  fa: { name: 'فارسی', value: 'fa', englishName: 'Persian' },
  fi: { name: 'Suomi', value: 'fi', englishName: 'Finnish' },
  fr: { name: 'Français', value: 'fr', englishName: 'French' },
  // gem: { name: 'Germanic', value: 'gem', englishName: 'Germanic Languages' },
  // gmw: { name: 'West Germanic', value: 'gmw', englishName: 'West Germanic Languages' },
  gu: { name: 'ગુજરાતી', value: 'gu', englishName: 'Gujarati' },
  he: { name: 'עברית', value: 'he', englishName: 'Hebrew' },
  hi: { name: 'हिन्दी', value: 'hi', englishName: 'Hindi' },
  hr: { name: 'Hrvatski', value: 'hr', englishName: 'Croatian' },
  hu: { name: 'Magyar', value: 'hu', englishName: 'Hungarian' },
  id: { name: 'Bahasa Indonesia', value: 'id', englishName: 'Indonesian' },
  is: { name: 'Íslenska', value: 'is', englishName: 'Icelandic' },
  it: { name: 'Italiano', value: 'it', englishName: 'Italian' },
  ja: { name: '日本語', value: 'ja', englishName: 'Japanese' },
  kn: { name: 'ಕನ್ನಡ', value: 'kn', englishName: 'Kannada' },
  ko: { name: '한국어', value: 'ko', englishName: 'Korean' },
  lt: { name: 'Lietuvių', value: 'lt', englishName: 'Lithuanian' },
  lv: { name: 'Latviešu', value: 'lv', englishName: 'Latvian' },
  ml: { name: 'മലയാളം', value: 'ml', englishName: 'Malayalam' },
  mr: { name: 'मराठी', value: 'mr', englishName: 'Marathi' },
  mt: { name: 'Malti', value: 'mt', englishName: 'Maltese' },
  mul: { name: 'Multiple', value: 'mul', englishName: 'Multiple Languages' },
  nl: { name: 'Nederlands', value: 'nl', englishName: 'Dutch' },
  no: { name: 'Norsk', value: 'no', englishName: 'Norwegian' },
  pa: { name: 'ਪੰਜਾਬੀ', value: 'pa', englishName: 'Punjabi' },
  pl: { name: 'Polski', value: 'pl', englishName: 'Polish' },
  pt: { name: 'Português', value: 'pt', englishName: 'Portuguese' },
  // ROMANCE: { name: 'Romance', value: 'ROMANCE', englishName: 'Romance Languages' },
  ro: { name: 'Română', value: 'ro', englishName: 'Romanian' },
  ru: { name: 'Русский', value: 'ru', englishName: 'Russian' },
  sk: { name: 'Slovenčina', value: 'sk', englishName: 'Slovak' },
  sl: { name: 'Slovenščina', value: 'sl', englishName: 'Slovenian' },
  sr: { name: 'Српски', value: 'sr', englishName: 'Serbian' },
  sv: { name: 'Svenska', value: 'sv', englishName: 'Swedish' },
  sw: { name: 'Kiswahili', value: 'sw', englishName: 'Swahili' },
  ta: { name: 'தமிழ்', value: 'ta', englishName: 'Tamil' },
  te: { name: 'తెలుగు', value: 'te', englishName: 'Telugu' },
  th: { name: 'ไทย', value: 'th', englishName: 'Thai' },
  tl: { name: 'Tagalog', value: 'tl', englishName: 'Tagalog' },
  tr: { name: 'Türkçe', value: 'tr', englishName: 'Turkish' },
  uk: { name: 'Українська', value: 'uk', englishName: 'Ukrainian' },
  ur: { name: 'اردو', value: 'ur', englishName: 'Urdu' },
  vi: { name: 'Tiếng Việt', value: 'vi', englishName: 'Vietnamese' },
  xh: { name: 'isiXhosa', value: 'xh', englishName: 'Xhosa' },
  cantonese: { name: '粤语', value: 'cantonese', englishName: 'Cantonese' },
  zh: { name: '中文', value: 'zh', englishName: 'Chinese' },
  zu: { name: 'isiZulu', value: 'zu', englishName: 'Zulu' },
};

/** Global language display order — sorted by worldwide usage/importance.
 *  Languages in this array appear first (in this order);
 *  any remaining languages fall back to alphabetical by englishName. */
export const LANGUAGE_PRIORITY: string[] = [
  'en', 'zh', 'es', 'fr', 'ar',
  'bn', 'pt', 'ru', 'de', 'ja',
  'hi', 'ko', 'it', 'tr', 'vi',
  'th', 'id', 'fa', 'ur', 'tl',
  'nl', 'pl', 'sv', 'da', 'ta',
  'te', 'ml', 'kn', 'gu', 'mr',
  'pa', 'fi', 'no', 'uk', 'cs',
  'ro', 'hu', 'el', 'bg', 'hr',
  'sk', 'sl', 'sr', 'ca', 'he',
  'sw', 'is', 'et', 'lt', 'lv',
  'af', 'xh', 'zu', 'mt',
];

function normalizeLocale(locale: string): string {
  return locale.trim().replace(/_/g, '-');
}

function isZhLocale(locale: string): boolean {
  return normalizeLocale(locale).toLowerCase().startsWith('zh');
}

/** App-only codes and aliases that Intl.DisplayNames does not accept. */
const APP_LANGUAGE_ALIASES: Record<string, string> = {
  cantonese: 'yue',
  yue: 'yue',
  cmn: 'zh',
  'cmn-cn': 'zh-CN',
  'zh-hans': 'zh-CN',
  'zh-hant': 'zh-TW',
  fil: 'fil',
  tl: 'fil',
  iw: 'he',
  nb: 'no',
  'ar-xa': 'ar',
};

const SPECIAL_DISPLAY_ZH: Record<string, string> = {
  auto: '自动检测',
  mul: '多语言',
  cantonese: '粤语',
  yue: '粤语',
  zhen: '中英互译',
  'zh-cn': '中文（简体）',
  'zh-hans': '中文（简体）',
  'cmn-cn': '中文（简体）',
  'zh-tw': '中文（繁体）',
  'zh-hant': '中文（繁体）',
  'zh-hk': '中文（香港）',
  'ar-xa': '阿拉伯语',
};

const SPECIAL_DISPLAY_EN: Record<string, string> = {
  auto: 'Auto Detect',
  mul: 'Multiple languages',
  cantonese: 'Cantonese',
  yue: 'Cantonese',
  zhen: 'Chinese ↔ English',
  'ar-xa': 'Arabic',
};

const SHORT_NAME_ZH: Record<string, string> = {
  auto: '自动',
  mul: '多',
  yue: '粤',
  cantonese: '粤',
  zh: '中',
  cmn: '中',
  en: '英',
  ja: '日',
  ko: '韩',
  es: '西',
  fr: '法',
  de: '德',
  pt: '葡',
  ru: '俄',
  vi: '越',
  th: '泰',
  id: '印尼',
  hi: '印地',
  it: '意',
  ar: '阿',
  nl: '荷',
  pl: '波',
  tr: '土',
  uk: '乌',
  ms: '马',
  fa: '波斯',
};

function languageKey(code: string): string {
  return code.trim().toLowerCase().replace(/_/g, '-');
}

function toBcp47(code: string): string {
  const aliased = APP_LANGUAGE_ALIASES[languageKey(code)] ?? languageKey(code);
  return aliased
    .split('-')
    .map((part, index) => {
      if (index === 0) return part;
      if (part.length === 4) return part[0].toUpperCase() + part.slice(1);
      if (part.length === 2 || part.length === 3) return part.toUpperCase();
      return part;
    })
    .join('-');
}

function primaryLanguageSubtag(code: string): string {
  const key = languageKey(code);
  if (key === 'cantonese' || key === 'yue') return 'yue';
  if (key === 'cmn' || key.startsWith('cmn-') || key === 'zh' || key.startsWith('zh-')) return 'zh';
  return toBcp47(code).split('-')[0]?.toLowerCase() || key;
}

/** Look up a LanguageOption by code, resolving regional aliases (zh_CN → zh). */
export function getLanguageOption(code: string): LanguageOption {
  if (LANGUAGE_OPTIONS[code]) return LANGUAGE_OPTIONS[code];
  const key = languageKey(code);
  if (LANGUAGE_OPTIONS[key]) return LANGUAGE_OPTIONS[key];
  if (key === 'yue' || key === 'cantonese') return LANGUAGE_OPTIONS.cantonese;
  const primary = primaryLanguageSubtag(code);
  if (LANGUAGE_OPTIONS[primary]) {
    return { ...LANGUAGE_OPTIONS[primary], value: code };
  }
  return { name: code, value: code, englishName: code };
}

/**
 * Human-readable language name for the current UI locale.
 * Chinese UI shows 英语 / 日语 / 中文（简体） instead of English / 日本語 / zh_CN.
 */
export function getLanguageDisplayName(
  code: string | undefined,
  locale = 'zh-CN',
  fallback?: string,
): string {
  if (!code) return fallback || '?';
  const key = languageKey(code);
  const useZh = isZhLocale(locale);
  const special = (useZh ? SPECIAL_DISPLAY_ZH : SPECIAL_DISPLAY_EN)[key];
  if (special) return special;

  const bcp47 = toBcp47(code);
  const displayLocale = useZh
    ? (normalizeLocale(locale).toLowerCase().startsWith('zh-tw') ? 'zh-TW' : 'zh-CN')
    : (normalizeLocale(locale) || 'en');

  try {
    const names = new Intl.DisplayNames([displayLocale], { type: 'language' });
    const named = names.of(bcp47);
    if (named && named.toLowerCase() !== bcp47.toLowerCase()) return named;
    const primary = names.of(bcp47.split('-')[0]);
    if (primary && primary.toLowerCase() !== bcp47.split('-')[0].toLowerCase()) return primary;
  } catch {
    // Intl rejects app-only codes; fall through.
  }

  const option = getLanguageOption(code);
  if (option.value !== code || LANGUAGE_OPTIONS[option.value] || LANGUAGE_OPTIONS[primaryLanguageSubtag(code)]) {
    return useZh ? option.name : option.englishName;
  }
  return fallback || option.name || code;
}

/** Compact badge for the subtitle bar: 英 / 中 / 日, not EN / ZH / CA. */
export function getLanguageShortName(code: string | undefined, locale = 'zh-CN'): string {
  if (!code) return '?';
  const key = languageKey(code);
  const primary = primaryLanguageSubtag(code);

  if (isZhLocale(locale)) {
    if (SHORT_NAME_ZH[key]) return SHORT_NAME_ZH[key];
    if (SHORT_NAME_ZH[primary]) return SHORT_NAME_ZH[primary];
    const full = getLanguageDisplayName(code, locale);
    const stripped = full.replace(/（.*?）|\(.*?\)/g, '');
    if (stripped === '中文') return '中';
    if (stripped.endsWith('语') && stripped.length <= 4) return stripped.slice(0, -1);
    return stripped.slice(0, 2) || '?';
  }

  if (key === 'auto') return 'AUTO';
  if (key === 'cantonese' || key === 'yue') return 'YUE';
  return primary.toUpperCase();
}

/** Sort language options by global priority, then alphabetically for unlisted languages. */
export function sortLanguageOptions(options: LanguageOption[]): LanguageOption[] {
  return [...options].sort((a, b) => {
    const ai = LANGUAGE_PRIORITY.indexOf(a.value);
    const bi = LANGUAGE_PRIORITY.indexOf(b.value);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.englishName.localeCompare(b.englishName);
  });
}
