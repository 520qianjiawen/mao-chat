const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
const LATIN = /[A-Za-z]/;

/**
 * True when ASR text is clearly the wrong writing system for the session
 * source language — e.g. "Hello." when the speaker is supposed to be
 * speaking Chinese. Used to drop speaker-bleed / first-chunk hallucinations
 * before they are translated and spoken.
 */
export function transcriptLooksForeign(text: string, sourceLanguage?: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || !sourceLanguage) return false;
  const lang = sourceLanguage.toLowerCase().split(/[-_]/)[0];
  const hasCjk = CJK.test(trimmed);
  const hasLatin = LATIN.test(trimmed);
  if (lang === 'zh' || lang === 'ja' || lang === 'ko') {
    return hasLatin && !hasCjk;
  }
  if (['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'sv', 'pl', 'tr', 'id', 'ms', 'vi', 'fil'].includes(lang)) {
    return hasCjk && !hasLatin;
  }
  return false;
}
