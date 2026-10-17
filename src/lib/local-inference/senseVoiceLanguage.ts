/** SenseVoice only accepts these language tokens. */
export type SenseVoiceLanguage = 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue';

/** Map an app language code onto sherpa-onnx SenseVoice's language field. */
export function mapSenseVoiceLanguage(code?: string | null): SenseVoiceLanguage {
  const primary = String(code || 'auto').toLowerCase().replace(/_/g, '-').split('-')[0];
  if (primary === 'zh' || primary === 'cmn') return 'zh';
  if (primary === 'en') return 'en';
  if (primary === 'ja') return 'ja';
  if (primary === 'ko') return 'ko';
  if (primary === 'yue' || primary === 'cantonese') return 'yue';
  return 'auto';
}
