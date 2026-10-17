import { defaultTtsVoice } from './nativeCatalog';
import type { NativeVoiceInfo } from './nativeProtocol';

/** Resolve a stored ttsVoice to a concrete in-model selection.
 *  - usesNamedVoiceSelection=false (single/range): pass through
 *    ('' = default speaker, 'sid:n' = a speaker).
 *  - usesNamedVoiceSelection=true (named presets and/or custom voices):
 *    '' or a dead custom id → the language's default built-in; a builtin name
 *    the current model doesn't have (stale setting from a previously selected
 *    model, e.g. pocket's 'eponine' arriving at gpt-sovits) → the language's
 *    default built-in. Builtin names are only validated when a voice list is
 *    available — an empty list can't distinguish "unknown" from "not loaded". */
export function reconcileTtsVoice(
  ttsVoice: string, customVoiceIds: number[], targetLanguage: string,
  voices: NativeVoiceInfo[], usesNamedVoiceSelection: boolean,
): string {
  if (!usesNamedVoiceSelection) return ttsVoice;
  if (!ttsVoice) return defaultTtsVoice(targetLanguage, voices);
  if (ttsVoice.startsWith('custom:')) {
    const id = Number(ttsVoice.slice('custom:'.length));
    if (!Number.isFinite(id) || !customVoiceIds.includes(id)) return defaultTtsVoice(targetLanguage, voices);
  }
  if (ttsVoice.startsWith('builtin:') && voices.length > 0) {
    const name = ttsVoice.slice('builtin:'.length);
    // Case-insensitive: settings may carry MOSS "Xiaoyu" while Qwen3 only
    // has "vivian"/"serena"/… — any name not on this model falls back.
    const match = voices.find((v) => v.name.toLowerCase() === name.toLowerCase());
    if (!match) return defaultTtsVoice(targetLanguage, voices);
    // Normalize casing to the catalog's speaker id (Qwen3 speakers are lower-case).
    return `builtin:${match.name}`;
  }
  return ttsVoice;
}
