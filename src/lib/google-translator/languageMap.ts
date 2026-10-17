// Maps app ISO / BCP-47 codes to Google Translate free (gtx) language codes.
// Most codes pass through; overrides handle the common mismatches.

const GOOGLE_LANGUAGE_OVERRIDES: Record<string, string> = {
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-tw': 'zh-TW',
  'zh-hk': 'zh-TW',
  cantonese: 'zh-TW', // closest free-gtx target; Google has no dedicated yue on gtx
  // Google historically used iw/jw; modern gtx accepts he/jv as well.
  he: 'he',
  nb: 'no',
  fil: 'tl', // Filipino → Tagalog on gtx
};

// Broad but not infinite — covers languages we expose in the UI + common pairs.
// Unknown codes still fail closed via isSupportedByGoogle.
export const GOOGLE_SUPPORTED_LANGUAGES: readonly string[] = [
  'af', 'am', 'ar', 'az', 'be', 'bg', 'bn', 'bs', 'ca', 'ceb',
  'co', 'cs', 'cy', 'da', 'de', 'el', 'en', 'eo', 'es', 'et',
  'eu', 'fa', 'fi', 'fil', 'fr', 'fy', 'ga', 'gd', 'gl', 'gu',
  'ha', 'haw', 'he', 'hi', 'hmn', 'hr', 'ht', 'hu', 'hy', 'id',
  'ig', 'is', 'it', 'ja', 'jv', 'ka', 'kk', 'km', 'kn', 'ko',
  'ku', 'ky', 'la', 'lb', 'lo', 'lt', 'lv', 'mg', 'mi', 'mk',
  'ml', 'mn', 'mr', 'ms', 'mt', 'my', 'ne', 'nl', 'no', 'nb',
  'ny', 'or', 'pa', 'pl', 'ps', 'pt', 'ro', 'ru', 'rw', 'sd',
  'si', 'sk', 'sl', 'sm', 'sn', 'so', 'sq', 'sr', 'st', 'su',
  'sv', 'sw', 'ta', 'te', 'tg', 'th', 'tk', 'tl', 'tr', 'tt',
  'ug', 'uk', 'ur', 'uz', 'vi', 'xh', 'yi', 'yo', 'zu',
  'zh', 'zh-cn', 'zh-tw', 'zh-hk', 'cantonese',
];

const SUPPORTED_SET = new Set(GOOGLE_SUPPORTED_LANGUAGES.map((c) => c.toLowerCase()));

export function isSupportedByGoogle(isoCode: string): boolean {
  if (!isoCode) return false;
  return SUPPORTED_SET.has(isoCode.toLowerCase());
}

export function mapToGoogleCode(isoCode: string): string {
  const lower = (isoCode || '').toLowerCase();
  if (!SUPPORTED_SET.has(lower)) {
    throw new Error(`unsupported language code: "${isoCode}"`);
  }
  return GOOGLE_LANGUAGE_OVERRIDES[lower] ?? lower;
}
