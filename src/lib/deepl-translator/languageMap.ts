// Maps app ISO / BCP-47 codes to DeepL API language codes.
// DeepL uses uppercase codes; targets may include regional variants (EN-US, ZH-HANS).

const DEEPL_SOURCE_OVERRIDES: Record<string, string> = {
  zh: 'ZH',
  'zh-cn': 'ZH',
  'zh-tw': 'ZH',
  'zh-hk': 'ZH',
  'zh-hans': 'ZH',
  'zh-hant': 'ZH',
  cantonese: 'ZH', // closest supported; DeepL has no dedicated Yue
  nb: 'NB',
  no: 'NB',
  he: 'HE',
  iw: 'HE',
  pt: 'PT',
  'pt-br': 'PT',
  'pt-pt': 'PT',
  en: 'EN',
  'en-us': 'EN',
  'en-gb': 'EN',
};

const DEEPL_TARGET_OVERRIDES: Record<string, string> = {
  zh: 'ZH-HANS',
  'zh-cn': 'ZH-HANS',
  'zh-hans': 'ZH-HANS',
  'zh-tw': 'ZH-HANT',
  'zh-hk': 'ZH-HANT',
  'zh-hant': 'ZH-HANT',
  cantonese: 'ZH-HANT',
  nb: 'NB',
  no: 'NB',
  he: 'HE',
  iw: 'HE',
  pt: 'PT-BR',
  'pt-br': 'PT-BR',
  'pt-pt': 'PT-PT',
  en: 'EN-US',
  'en-us': 'EN-US',
  'en-gb': 'EN-GB',
};

// DeepL Free + Pro commonly supported source language ISO inputs (app-side).
// See https://developers.deepl.com/docs/resources/supported-languages
export const DEEPL_SUPPORTED_LANGUAGES: readonly string[] = [
  'ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'en-us', 'en-gb',
  'es', 'et', 'fi', 'fr', 'he', 'hu', 'id', 'it', 'ja', 'ko',
  'lt', 'lv', 'nb', 'no', 'nl', 'pl', 'pt', 'pt-br', 'pt-pt',
  'ro', 'ru', 'sk', 'sl', 'sv', 'th', 'tr', 'uk', 'vi',
  'zh', 'zh-cn', 'zh-tw', 'zh-hk', 'zh-hans', 'zh-hant', 'cantonese',
];

const SUPPORTED_SET = new Set(DEEPL_SUPPORTED_LANGUAGES.map((c) => c.toLowerCase()));

export function isSupportedByDeepL(isoCode: string): boolean {
  if (!isoCode) return false;
  return SUPPORTED_SET.has(isoCode.toLowerCase());
}

export function mapToDeepLSourceCode(isoCode: string): string {
  const lower = (isoCode || '').toLowerCase();
  if (!SUPPORTED_SET.has(lower)) {
    throw new Error(`unsupported language code: "${isoCode}"`);
  }
  return DEEPL_SOURCE_OVERRIDES[lower] ?? lower.toUpperCase();
}

export function mapToDeepLTargetCode(isoCode: string): string {
  const lower = (isoCode || '').toLowerCase();
  if (!SUPPORTED_SET.has(lower)) {
    throw new Error(`unsupported language code: "${isoCode}"`);
  }
  return DEEPL_TARGET_OVERRIDES[lower] ?? lower.toUpperCase();
}
