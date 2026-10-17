/**
 * ASR-only VAD / endpoint knobs.
 *
 * Derived from language segmentation timings so captions stay in the same
 * ballpark, but this module is what ASR engines import — not the segmenter.
 */

import {
  getSegmentationPreset,
  normalizeSegmentationMode,
  type SegmentationMode,
} from './languageRules';

export function asrTuningForMode(mode: SegmentationMode, language?: string | null): {
  endpointMinTrailingSilenceSeconds: number;
  maxUtteranceDurationSeconds: number;
  captionMaxWords: number;
  captionMaxChars: number;
  minSilenceDuration: number;
  maxSpeechDuration: number;
  minSpeechDuration: number;
  vadThreshold: number;
} {
  const preset = getSegmentationPreset(mode, language);
  const video = normalizeSegmentationMode(mode) === 'video';
  return {
    endpointMinTrailingSilenceSeconds: preset.hardSilenceMs / 1000,
    maxUtteranceDurationSeconds: preset.forceDurationMs / 1000,
    captionMaxWords: preset.maxWords,
    captionMaxChars: preset.maxCjkChars,
    // VAD chunking is independent of sentence-segmenter force duration.
    // Video used to cut at 1s, which made streaming ASR emit fake-period
    // fragments ("the Navy.", "allies by."). 6s matches sentence scale;
    // batch ASR still publishes 0.5s partials for live English pending.
    minSilenceDuration: video ? 0.45 : Math.max(0.5, preset.softSilenceMs / 1000),
    maxSpeechDuration: video ? 6.0 : 2.5,
    minSpeechDuration: video ? 0.12 : 0.18,
    vadThreshold: video ? 0.28 : 0.30,
  };
}
