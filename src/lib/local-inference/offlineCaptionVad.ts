/** Extension tab/video: offline ASR only emits after VAD. Keep cuts short. */
export const EXTENSION_OFFLINE_CAPTION_MIN_SILENCE_S = 0.4;
export const EXTENSION_OFFLINE_CAPTION_MAX_SPEECH_S = 3.2;

export function extensionOfflineVadOverrides(minSilence?: number): {
  minSilenceDuration: number;
  maxSpeechDuration: number;
} {
  const silence = minSilence ?? EXTENSION_OFFLINE_CAPTION_MIN_SILENCE_S;
  return {
    minSilenceDuration: Math.min(silence, EXTENSION_OFFLINE_CAPTION_MIN_SILENCE_S),
    maxSpeechDuration: EXTENSION_OFFLINE_CAPTION_MAX_SPEECH_S,
  };
}
