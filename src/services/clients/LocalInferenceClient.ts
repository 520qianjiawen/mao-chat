/**
 * LocalInferenceClient — IClient implementation for fully offline
 * ASR → Translation → TTS pipeline using sherpa-onnx WASM engines.
 *
 * Audio flow:
 *   Mic (Int16@24kHz) → AsrEngine → text → TranslationEngine → translated text
 *   → TtsEngine → Float32@modelRate → resample → Int16@24kHz → speaker
 */

import {
  IClient,
  ConversationItem,
  SessionConfig,
  LocalInferenceSessionConfig,
  isLocalInferenceSessionConfig,
  ClientEventHandlers,
  ResponseConfig,
} from '../interfaces/IClient';
import { Provider, ProviderType } from '../../types/Provider';
import { AsrEngine } from '../../lib/local-inference/engine/AsrEngine';
import { StreamingAsrEngine } from '../../lib/local-inference/engine/StreamingAsrEngine';
import {
  TranslationEngine,
  type TranslationResult,
} from '../../lib/local-inference/engine/TranslationEngine';
import { TtsEngine } from '../../lib/local-inference/engine/TtsEngine';
import { getManifestEntry } from '../../lib/local-inference/modelManifest';
import { cleanOfflineAsrText } from '../../lib/local-inference/asrSilence';
import {
  SentenceSegmenter,
  normalizeSegmentationMode,
  shouldTranslatePending,
  type SegmentationMode,
} from '../../lib/local-inference/sentenceSegmenter';
import { asrTuningForMode } from '../../lib/local-inference/asrTuning';
import { resampleFloat32, float32ToInt16 } from '../../utils/audio-conversion';
import { splitSentences } from '../../utils/splitSentences';
import i18n from '../../locales';

/**
 * Error thrown when GPU runs out of memory during WebGPU model initialization.
 * Carries a user-friendly translated message and a stable `isGpuOom` flag so
 * callers can detect it without parsing translated strings.
 */
export class GpuOutOfMemoryError extends Error {
  readonly isGpuOom = true;
  constructor(message: string) {
    super(message);
    this.name = 'GpuOutOfMemoryError';
  }
}

/**
 * Detect GPU out-of-memory errors from ONNX Runtime WebGPU / Vulkan backend.
 * Error messages cascade through several stages; we check the most distinctive patterns.
 */
function isGpuOutOfMemoryError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes('out_of_device_memory') ||
    lower.includes('out of memory') ||
    lower.includes('a valid external instance reference no longer exists') ||
    (lower.includes('webgpu') && lower.includes('device lost'))
  );
}

interface AsrTiming {
  durationMs: number;
  recognitionTimeMs: number;
}

interface PipelineJob {
  text: string;
  asrTiming?: AsrTiming;
  /** Reuse the live incremental translation row when the ASR utterance ends. */
  assistantItem?: ConversationItem;
  /**
   * Exact source text that produced the live partial translation currently
   * shown on `assistantItem`. When this equals `text`, the final pipeline can
   * skip a redundant re-translation (common once incremental translation has
   * caught up to the finalized ASR utterance).
   */
  pretranslatedSource?: string;
  segmentId?: number;
}

/**
 * Partial ASR hypotheses arrive several times per second.  Wait for a small
 * amount of useful context before translating, then coalesce later updates so
 * the translation worker is never flooded with every single token.
 */
// Keep live captions responsive without flooding the worker: ~2 updates/sec
// is plenty for a subtitle band, and lower than the old 850ms floor so short
// smart-split segments do not sit untranslated for nearly a second.
const LIVE_TRANSLATION_MIN_INTERVAL_MS = 450;
const LIVE_TRANSLATION_DEBOUNCE_MS = 180;
// Prefer fuller clauses for live MT (Google/Opus). Online translators handle
// ~40 English words fine; splitting earlier was re-fragmenting coalesced ASR.
const LIVE_TRANSLATION_MAX_WORDS = 36;
const LIVE_TRANSLATION_MAX_CHARS = 100;

export function shouldTranslatePartial(text: string, language?: string): boolean {
  return shouldTranslatePending(text, language);
}

/**
 * Keep each local translation request short. Streaming ASR hypotheses usually
 * have no punctuation, and pair-specific Opus-MT models become unreliable on
 * an ever-growing paragraph.
 */
export function splitTranslationSource(
  text: string,
  maxWords = LIVE_TRANSLATION_MAX_WORDS,
  maxChars = LIVE_TRANSLATION_MAX_CHARS,
): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const sentenceLikeParts = normalized.match(/[^.!?。！？；;]+[.!?。！？；;]?/gu) ?? [normalized];
  const chunks: string[] = [];

  for (const part of sentenceLikeParts) {
    const segment = part.trim();
    if (!segment) continue;
    const words = segment.split(/\s+/).filter(Boolean);

    if (words.length > 1) {
      for (let i = 0; i < words.length; i += maxWords) {
        chunks.push(words.slice(i, i + maxWords).join(' '));
      }
      continue;
    }

    const chars = Array.from(segment);
    for (let i = 0; i < chars.length; i += maxChars) {
      chunks.push(chars.slice(i, i + maxChars).join(''));
    }
  }

  return chunks;
}

/** Reject obvious model degeneration such as "去去去去……". */
export function isDegenerateTranslationOutput(text: string): boolean {
  const value = text.trim();
  if (!value) return false;

  const compact = value.replace(/[\s\p{P}\p{S}]/gu, '');
  if (/(.)\1{7,}/u.test(compact)) return true;

  const chars = Array.from(compact);
  if (chars.length >= 16) {
    const counts = new Map<string, number>();
    for (const char of chars) counts.set(char, (counts.get(char) ?? 0) + 1);
    if (Math.max(...counts.values()) / chars.length >= 0.5) return true;
  }

  const words = value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length >= 8) {
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    if (Math.max(...counts.values()) / words.length >= 0.5) return true;
  }

  return false;
}

export class LocalInferenceClient implements IClient {
  private asrEngine: AsrEngine | StreamingAsrEngine | null = null;
  private translationEngine: TranslationEngine | null = null;
  private ttsEngine: TtsEngine | null = null;

  private config: LocalInferenceSessionConfig | null = null;
  private handlers: ClientEventHandlers = {};
  private conversationItems: ConversationItem[] = [];
  private connected = false;
  private disposed = false;
  private itemCounter = 0;
  // Per-instance prefix so item IDs are globally unique across client
  // instances. In "both" mode the speaker and participant channels each
  // construct their own LocalInferenceClient; without this, both counters
  // start at 0 and mint identical IDs (e.g. local_asst_2 on both), which
  // collides downstream — notably the karaoke highlight, which keys on
  // item.id alone and would light two conversation items at once. Mirrors
  // the instanceId pattern already used by GeminiClient/VolcengineSTClient.
  private readonly instanceId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Streaming ASR: in-progress partial result item
  private partialUserItem: ConversationItem | null = null;

  /**
   * ASR finals/partials update this buffer; translation runs only when the
   * Meeting/Video segmenter commits a complete phrase.
   */
  private segmenter: SentenceSegmenter | null = null;
  private pendingAsrTiming?: AsrTiming;

  // Live translation of cumulative partial ASR text. Only one partial request
  // is in flight; newer hypotheses replace `pendingPartialTranslationText`.
  private partialAssistantItem: ConversationItem | null = null;
  private pendingPartialTranslationText: string | null = null;
  private lastPartialTranslationText = '';
  private partialTranslationInFlight = false;
  private partialTranslationTimer: ReturnType<typeof setTimeout> | null = null;
  private partialTranslationLastStartedAt = 0;
  private partialTranslationGeneration = 0;
  // Exact completed chunks remain stable as a cumulative ASR hypothesis grows.
  // Reuse them so a 60-word live caption does not re-run its first 18 words on
  // every partial update.
  private translationChunkCache = new Map<string, TranslationResult[]>();

  // AST mode: ASR produces translated text directly, skip translation engine
  private astMode = false;

  // TTS queue for serial processing
  private ttsQueue: PipelineJob[] = [];
  private ttsProcessing = false;

  /**
   * Cached from `config.keepReplayAudio` at session start. When false, each
   * call to `appendItemAudio()` is skipped — `item.formatted.audio` stays
   * empty, hiding the inline replay button. Real-time TTS playback (via the
   * audio service through `onConversationUpdated({ delta: { audio } })`) is
   * unaffected.
   */
  private keepReplayAudio: boolean = false;

  /**
   * Helper to wrap an engine init call with per-engine progress event emission and timing.
   */
  private async trackInit<T>(
    engineName: 'asr' | 'translation' | 'tts',
    modelId: string,
    initFn: () => Promise<T>,
  ): Promise<T> {
    this.emitEvent(`local.init.${engineName}.start`, 'client', { model: modelId });
    const startTime = performance.now();
    try {
      const result = await initFn();
      const initDurationMs = Math.round(performance.now() - startTime);
      this.emitEvent(`local.init.${engineName}.ready`, 'client', { model: modelId, initDurationMs });
      return result;
    } catch (error) {
      this.emitEvent(`local.init.${engineName}.error`, 'client', {
        model: modelId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * If the active TTS engine is Supertonic and the configured sid isn't in the
   * actually-loaded voices, emit a warning. The worker has its own fallback
   * (substituting defaultSid at generate time), so this is purely diagnostic —
   * we don't mutate any state here. The UI layer reconciles the user setting
   * separately (see VoiceLibrarySection).
   */
  private reconcileSupertonicSidIfNeeded(
    config: { ttsModelId?: string; ttsSpeakerId?: number },
    ready: { voices?: Array<{ sid: number }>; sampleRate: number } | null | undefined,
  ): void {
    if (!ready?.voices || ready.voices.length === 0) return;
    if (typeof config.ttsSpeakerId !== 'number') return;
    const sids = new Set(ready.voices.map(v => v.sid));
    if (sids.has(config.ttsSpeakerId)) return;
    // The worker substitutes the model's defaultSid at generate time, so
    // synthesis still works. Just log — do NOT call onError, which MainPanel
    // treats as a hard session failure (would spuriously surface as a red
    // banner every reconnect for a user who just deleted an imported voice).
    console.warn(
      `[LocalInference] Configured ttsSpeakerId=${config.ttsSpeakerId} is not in the loaded Supertonic voices; worker will fall back to default sid. Update your selection in settings.`,
    );
  }

  async connect(config: SessionConfig): Promise<void> {
    if (!isLocalInferenceSessionConfig(config)) {
      throw new Error('LocalInferenceClient requires LocalInferenceSessionConfig');
    }

    this.config = {
      ...config,
      textOnly: Boolean(config.textOnly)
        || normalizeSegmentationMode(config.segmentationMode) === 'video',
    };
    this.disposed = false;
    this.conversationItems = [];
    this.itemCounter = 0;
    this.ttsEngine = null;
    this.keepReplayAudio = config.keepReplayAudio ?? false;
    this.resetPartialTranslationState();
    this.resetSegmenter(normalizeSegmentationMode(config.segmentationMode));

    try {
      // --- Create engines & set callbacks synchronously ---

      // ASR engine — detect streaming vs offline model
      const asrModel = getManifestEntry(config.asrModelId);
      console.info('[LocalInference] Initializing ASR engine:', config.asrModelId, '(type:', asrModel?.type, ')');
      const dropFillers = Boolean(config.youtubeCaptionTuning)
        || normalizeSegmentationMode(config.segmentationMode) === 'video';

      if (asrModel?.type === 'asr-stream') {
        const engine = new StreamingAsrEngine();

        engine.onPartialResult = (text) => {
          if (this.disposed) return;
          this.ensureSegmenter().ingestPartial(text);
        };

        engine.onResult = (result) => {
          if (this.disposed) return;
          const text = cleanOfflineAsrText(result.text, { dropFillers });
          if (!text) return;
          console.debug('[LocalInference] Streaming ASR result:', text, `(${result.durationMs}ms, ${result.recognitionTimeMs}ms recognition)`);
          this.ingestAsrFinal(text, {
            durationMs: result.durationMs,
            recognitionTimeMs: result.recognitionTimeMs,
          });
        };

        engine.onSpeechStart = () => {
          if (this.disposed) return;
          this.ensureSegmenter().notifySpeechStart();
          this.emitEvent('local.asr.start', 'server', { modelId: this.config?.asrModelId });
        };

        engine.onError = (error) => {
          console.error(`[LocalInference] Streaming ASR error (${config.asrModelId}):`, error);
          this.emitEvent('local.asr.error', 'server', { error });
          this.handlers.onError?.(new Error(`ASR: ${error}`));
        };

        this.asrEngine = engine;
      } else {
        const engine = new AsrEngine();

        engine.onSpeechStart = () => {
          if (this.disposed) return;
          this.ensureSegmenter().notifySpeechStart();
          this.emitEvent('local.asr.start', 'server', { modelId: this.config?.asrModelId });
        };

        engine.onPartialResult = (text) => {
          if (this.disposed) return;
          this.ensureSegmenter().ingestPartial(text);
        };

        engine.onResult = (result) => {
          if (this.disposed) return;
          const text = cleanOfflineAsrText(result.text, { dropFillers });
          if (!text) return;
          console.debug('[LocalInference] ASR result:', text, `(${result.durationMs}ms speech, ${result.recognitionTimeMs}ms recognition)`);
          this.ingestAsrFinal(text, { durationMs: result.durationMs, recognitionTimeMs: result.recognitionTimeMs });
        };

        engine.onError = (error) => {
          console.error(`[LocalInference] ASR error (${config.asrModelId}):`, error);
          this.emitEvent('local.asr.error', 'server', { error });
          this.handlers.onError?.(new Error(`ASR: ${error}`));
        };

        this.asrEngine = engine;
      }

      // Translation engine — skip when no model available (participant ASR-only)
      // or when ASR model handles AST directly (Granite Speech)
      const isAstMode = asrModel?.asrEngine === 'granite-speech'
        && config.translationModelId === config.asrModelId;
      this.astMode = isAstMode;

      if (isAstMode) {
        console.info('[LocalInference] AST mode: Granite Speech handles translation, skipping translation engine');
        this.translationEngine = null;
      } else if (config.translationModelId) {
        console.info('[LocalInference] Initializing Translation engine:', config.translationModelId, `(${config.sourceLanguage} → ${config.targetLanguage})`);
        this.translationEngine = new TranslationEngine();
      } else {
        console.info('[LocalInference] No translation model — ASR-only mode');
        this.translationEngine = null;
      }

      // Determine which engines will be initialized
      const engines = ['asr'];
      if (this.translationEngine) engines.push('translation');
      if (config.ttsModelId && !config.textOnly) engines.push('tts');
      this.emitEvent('local.init.start', 'client', { engines: [...engines] });

      // TTS engine (optional — skip when textOnly or no TTS model configured)
      if (config.ttsModelId && !config.textOnly) {
        console.info('[LocalInference] Initializing TTS engine:', config.ttsModelId);
        this.ttsEngine = new TtsEngine();
      } else {
        console.info('[LocalInference] No TTS:', config.textOnly ? 'text-only mode' : 'no TTS model configured');
      }

      // --- Fire all init() calls in parallel ---

      const asrPromise = this.trackInit('asr', config.asrModelId, () => {
        // YouTube-checkbox ASR fallback only. Unchecked sessions keep the
        // original VAD / streaming defaults so tab audio matches pre-YouTube.
        const youtubeCaptionTuning = Boolean(config.youtubeCaptionTuning);
        const mode = normalizeSegmentationMode(config.segmentationMode);
        const asrTune = asrTuningForMode(mode, config.sourceLanguage);
        const vadConfig = {
          threshold: config.vadThreshold,
          // 0/absent lets the worker derive it from `threshold`; it is clamped
          // to never sit above it, which would disable endpoint detection.
          negativeThreshold: config.vadNegativeThreshold || undefined,
          minSilenceDuration: mode === 'video' || youtubeCaptionTuning
            ? Math.min(config.vadMinSilenceDuration ?? asrTune.minSilenceDuration, asrTune.minSilenceDuration)
            : config.vadMinSilenceDuration,
          minSpeechDuration: mode === 'video' || youtubeCaptionTuning
            ? Math.min(config.vadMinSpeechDuration ?? asrTune.minSpeechDuration, asrTune.minSpeechDuration)
            : config.vadMinSpeechDuration,
          maxSpeechDuration: asrTune.maxSpeechDuration,
        };
        if (asrModel?.type === 'asr-stream') {
          return (this.asrEngine as StreamingAsrEngine).init(config.asrModelId, {
            language: config.sourceLanguage,
            vadConfig,
            captionMaxWords: asrTune.captionMaxWords,
            captionMaxChars: asrTune.captionMaxChars,
            endpointMinTrailingSilenceSeconds: asrTune.endpointMinTrailingSilenceSeconds,
            maxUtteranceDurationSeconds: asrTune.maxUtteranceDurationSeconds,
          });
        } else {
          const taskConfig = isAstMode
            ? { task: 'translate' as const, targetLanguage: config.targetLanguage }
            : undefined;
          return (this.asrEngine as AsrEngine).init(
            config.asrModelId,
            vadConfig,
            config.sourceLanguage,
            taskConfig,
            { skipQuietSegments: youtubeCaptionTuning },
          );
        }
      });

      const translationPromise = this.translationEngine
        ? this.trackInit('translation', config.translationModelId!, () =>
            this.translationEngine!.init(
              config.sourceLanguage,
              config.targetLanguage,
              config.translationModelId,
              { apiKey: config.deeplApiKey },
            ),
          )
        : Promise.resolve(null);

      // TTS catches its own errors for graceful degradation
      const ttsPromise = this.ttsEngine
        ? this.trackInit('tts', config.ttsModelId!, async () => {
            const ready = await this.ttsEngine!.init(config.ttsModelId!);
            this.reconcileSupertonicSidIfNeeded(config, ready);
            return ready;
          }).catch((error) => {
            console.warn('[LocalInference] TTS init failed, continuing without TTS:', error);
            this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
            this.ttsEngine?.dispose();
            this.ttsEngine = null;
            return null;
          })
        : Promise.resolve(null);

      const results = await Promise.allSettled([asrPromise, translationPromise, ttsPromise]);

      // Check ASR result
      if (results[0].status === 'rejected') {
        throw new Error(`ASR engine init failed: ${results[0].reason instanceof Error ? results[0].reason.message : String(results[0].reason)}`);
      }
      console.info('[LocalInference] ASR engine ready');

      // Check Translation result (skip if ASR-only or AST mode)
      if (this.translationEngine) {
        if (results[1].status === 'rejected') {
          throw new Error(`Translation engine init failed: ${results[1].reason instanceof Error ? results[1].reason.message : String(results[1].reason)}`);
        }
        console.info('[LocalInference] Translation engine ready');
      }

      // TTS result (already handled via catch above, just log success)
      if (this.ttsEngine) {
        console.info('[LocalInference] TTS engine ready (sampleRate:', this.ttsEngine.sampleRate, ', speakers:', this.ttsEngine.numSpeakers, ')');
      }

      this.connected = true;
      this.emitEvent('local.session.opened', 'client', {
        asrModel: config.asrModelId,
        translationPair: `${config.sourceLanguage} → ${config.targetLanguage}`,
        ttsModel: config.ttsModelId ?? null,
      });
      this.handlers.onOpen?.();
    } catch (error) {
      // Clean up on failure
      this.asrEngine?.dispose();
      this.asrEngine = null;
      this.translationEngine?.dispose();
      this.translationEngine = null;
      this.ttsEngine?.dispose();
      this.ttsEngine = null;

      // Surface a user-friendly message when GPU runs out of memory
      if (isGpuOutOfMemoryError(error)) {
        console.error('[LocalInference] GPU out of memory detected:', error);
        throw new GpuOutOfMemoryError(i18n.t('errors.gpuOutOfMemory'));
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    this.connected = false;
    this.ttsQueue = [];
    this.ttsProcessing = false;
    this.partialUserItem = null;
    this.resetSegmenter();
    this.resetPartialTranslationState();
    this.astMode = false;

    this.asrEngine?.dispose();
    this.asrEngine = null;
    this.translationEngine?.dispose();
    this.translationEngine = null;
    this.ttsEngine?.dispose();
    this.ttsEngine = null;

    this.emitEvent('local.session.closed', 'client', { reason: 'user_disconnect' });
    this.handlers.onClose?.({});
  }

  isConnected(): boolean {
    return this.connected;
  }

  updateSession(config: Partial<SessionConfig>): void {
    if (this.config && isLocalInferenceSessionConfig(config as SessionConfig)) {
      this.config = { ...this.config, ...(config as Partial<LocalInferenceSessionConfig>) };
      if (this.segmenter) {
        if (config.segmentationMode) {
          this.segmenter.setMode(normalizeSegmentationMode(config.segmentationMode));
        }
        if (config.sourceLanguage) this.segmenter.setLanguage(config.sourceLanguage);
      }
    }
  }

  reset(): void {
    this.conversationItems = [];
    this.itemCounter = 0;
    this.partialUserItem = null;
    this.resetSegmenter();
    this.resetPartialTranslationState();
  }

  appendInputAudio(audioData: Int16Array): void {
    if (!this.asrEngine || this.disposed) return;
    this.asrEngine.feedAudio(audioData, 24000);
  }

  appendInputText(text: string): void {
    if (this.disposed || !text.trim()) return;
    // Typed input is already a complete sentence — commit any held ASR first.
    this.ensureSegmenter().flush();
    this.handleAsrResult(text.trim());
  }

  createResponse(_config?: ResponseConfig): void {
    // In Auto mode the pipeline is triggered by ASR/VAD results automatically.
    // In Push-to-Talk mode this is called on key release to flush any pending
    // ASR utterance that hasn't hit endpoint/silence detection yet.
    this.asrEngine?.flush();
    // Commit any held phrase so PTT release still produces MT.
    this.ensureSegmenter().flush();
  }

  cancelResponse(_trackId?: string, _offset?: number): void {
    // No-op
  }

  getConversationItems(): ConversationItem[] {
    return [...this.conversationItems];
  }

  clearConversationItems(): void {
    this.conversationItems = [];
    this.partialUserItem = null;
    this.resetSegmenter();
    this.resetPartialTranslationState();
  }

  setEventHandlers(handlers: ClientEventHandlers): void {
    this.handlers = handlers;
  }

  getProvider(): ProviderType {
    return Provider.LOCAL_INFERENCE;
  }

  // ─── Event Emission ──────────────────────────────────────

  private emitEvent(type: string, source: 'client' | 'server', data: Record<string, any>): void {
    this.handlers.onRealtimeEvent?.({
      source,
      event: { type, data },
    });
  }

  /**
   * Append a TTS audio chunk onto the assistant item so the inline replay
   * button (ConversationRow → handlePlayAudio) has a complete Int16Array to
   * play back. Without this, chunks only stream through the audio player and
   * `item.formatted.audio` stays empty, leaving the replay button disabled.
   */
  private appendItemAudio(item: ConversationItem, chunk: Int16Array): void {
    if (!item.formatted) item.formatted = {};
    const prev = item.formatted.audio;
    if (prev instanceof Int16Array && prev.length > 0) {
      const combined = new Int16Array(prev.length + chunk.length);
      combined.set(prev);
      combined.set(chunk, prev.length);
      item.formatted.audio = combined;
    } else {
      item.formatted.audio = new Int16Array(chunk);
    }
  }

  // ─── Pipeline ─────────────────────────────────────────────

  private resetPartialTranslationState(): void {
    if (this.partialTranslationTimer) {
      clearTimeout(this.partialTranslationTimer);
      this.partialTranslationTimer = null;
    }
    this.partialTranslationGeneration += 1;
    this.partialAssistantItem = null;
    this.pendingPartialTranslationText = null;
    this.lastPartialTranslationText = '';
    this.partialTranslationInFlight = false;
    this.partialTranslationLastStartedAt = 0;
  }

  /**
   * Stop partial updates for the utterance and hand its live assistant row to
   * the final pipeline job. An older async partial result is then ignored.
   *
   * @param finalSourceText - the ASR text that is being finalized. When the
   *   live partial was produced for a *different* span (typical with smart
   *   caption splits that finalize a head while the partial still covered
   *   head+tail), drop the mismatched translation so the UI does not show a
   *   long-form translation next to a shorter source line.
   */
  private takePartialAssistantForFinal(finalSourceText: string): {
    item: ConversationItem | null;
    pretranslatedSource?: string;
  } {
    if (this.partialTranslationTimer) {
      clearTimeout(this.partialTranslationTimer);
      this.partialTranslationTimer = null;
    }
    this.partialTranslationGeneration += 1;
    this.pendingPartialTranslationText = null;

    const item = this.partialAssistantItem;
    this.partialAssistantItem = null;
    const partialSource = this.lastPartialTranslationText.trim();
    this.lastPartialTranslationText = '';

    if (!item) return { item: null };

    const finalSource = finalSourceText.trim();
    if (!partialSource || !finalSource) {
      return { item };
    }

    // Exact match: final pipeline can reuse the live translation as-is.
    if (partialSource === finalSource) {
      return { item, pretranslatedSource: partialSource };
    }

    // Progressive growth: partial covered a prefix of the final utterance
    // (e.g. "hello world" → "hello world today"). Keep the interim text so
    // the row does not blank while the final re-translate runs.
    if (finalSource.startsWith(partialSource)) {
      return { item };
    }

    // Smart-split / rewrite case: partial was for a longer or different span
    // than the finalized head. Showing that translation beside the shorter
    // source looks broken — clear it and let the final job refill.
    item.formatted = {
      ...item.formatted,
      transcript: '',
    };
    this.handlers.onConversationUpdated?.({ item });
    return { item };
  }

  private schedulePartialTranslation(text: string): void {
    if (!this.translationEngine || this.astMode || this.disposed) return;
    const normalized = text.trim();
    if (!shouldTranslatePartial(normalized, this.config?.sourceLanguage)) return;

    this.pendingPartialTranslationText = normalized;
    if (this.partialTranslationInFlight || this.partialTranslationTimer) return;

    const elapsed = performance.now() - this.partialTranslationLastStartedAt;
    const delay = Math.max(
      LIVE_TRANSLATION_DEBOUNCE_MS,
      LIVE_TRANSLATION_MIN_INTERVAL_MS - elapsed,
    );
    this.partialTranslationTimer = setTimeout(() => {
      this.partialTranslationTimer = null;
      void this.runPartialTranslation();
    }, delay);
  }

  private async runPartialTranslation(): Promise<void> {
    if (this.partialTranslationInFlight || !this.translationEngine || this.disposed) return;
    const sourceText = this.pendingPartialTranslationText?.trim();
    this.pendingPartialTranslationText = null;
    if (!sourceText || sourceText === this.lastPartialTranslationText) return;

    const generation = this.partialTranslationGeneration;
    this.partialTranslationInFlight = true;
    this.partialTranslationLastStartedAt = performance.now();
    this.lastPartialTranslationText = sourceText;

    try {
      const resolvedPrompt = this.config?.instructions || '';
      const wrapTranscript = this.config?.wrapTranscript ?? true;
      this.emitEvent('local.translation.partial.start', 'client', {
        sourceText,
        modelId: this.config?.translationModelId,
      });
      const result = await this.translateTextSafely(
        sourceText,
        resolvedPrompt,
        wrapTranscript,
      );

      // A final ASR result, reset, or disconnect supersedes this hypothesis.
      if (this.disposed || generation !== this.partialTranslationGeneration) return;
      const translatedText = result.translatedText.trim();
      if (!translatedText) return;

      if (!this.partialAssistantItem) {
        this.partialAssistantItem = {
          id: `${this.instanceId}_asst_${++this.itemCounter}`,
          role: 'assistant',
          type: 'message',
          status: 'in_progress',
          createdAt: Date.now(),
          formatted: { transcript: translatedText },
        };
        this.conversationItems.push(this.partialAssistantItem);
      } else {
        this.partialAssistantItem.formatted = {
          ...this.partialAssistantItem.formatted,
          transcript: translatedText,
        };
      }
      this.handlers.onConversationUpdated?.({ item: this.partialAssistantItem });
      this.emitEvent('local.translation.partial.end', 'server', {
        sourceText,
        translatedText,
        inferenceTimeMs: result.inferenceTimeMs,
        modelId: this.config?.translationModelId,
      });
    } catch (error) {
      // Partial hypotheses are best-effort; the finalized utterance still runs
      // through the normal pipeline and reports any persistent failure.
      if (!this.disposed && generation === this.partialTranslationGeneration) {
        console.warn('[LocalInference] Incremental translation skipped:', error);
      }
    } finally {
      this.partialTranslationInFlight = false;
      if (this.pendingPartialTranslationText && !this.disposed) {
        this.schedulePartialTranslation(this.pendingPartialTranslationText);
      }
    }
  }

  /**
   * Translate a long ASR utterance in bounded chunks and retry a pathological
   * chunk as two smaller pieces before allowing it into the conversation UI.
   */
  private async translateTextSafely(
    sourceText: string,
    systemPrompt: string,
    wrapTranscript: boolean,
  ): Promise<TranslationResult> {
    if (!this.translationEngine) {
      throw new Error('Translation engine is not available.');
    }

    const translateChunk = async (chunk: string): Promise<TranslationResult[]> => {
      const cached = this.translationChunkCache.get(chunk);
      if (cached) return cached;

      const first = await this.translationEngine!.translate(chunk, systemPrompt, wrapTranscript);
      if (!isDegenerateTranslationOutput(first.translatedText)) {
        const result = [first];
        this.cacheTranslationChunk(chunk, result);
        return result;
      }

      const words = chunk.split(/\s+/).filter(Boolean);
      const halves = words.length > 1
        ? [
          words.slice(0, Math.ceil(words.length / 2)).join(' '),
          words.slice(Math.ceil(words.length / 2)).join(' '),
        ].filter(Boolean)
        : (() => {
          const chars = Array.from(chunk);
          const middle = Math.ceil(chars.length / 2);
          return [chars.slice(0, middle).join(''), chars.slice(middle).join('')].filter(Boolean);
        })();

      if (halves.length < 2) {
        throw new Error('Translation model generated unstable repeated text.');
      }

      console.warn('[LocalInference] Retrying repetitive translation as smaller chunks:', chunk);
      const retried: TranslationResult[] = [];
      for (const half of halves) {
        const result = await this.translationEngine!.translate(half, systemPrompt, wrapTranscript);
        if (isDegenerateTranslationOutput(result.translatedText)) {
          throw new Error('Translation model generated unstable repeated text.');
        }
        retried.push(result);
      }
      this.cacheTranslationChunk(chunk, retried);
      return retried;
    };

    const sourceChunks = splitTranslationSource(sourceText);
    const translated: string[] = [];
    let inferenceTimeMs = 0;
    let resolvedSystemPrompt: string | undefined;

    for (const chunk of sourceChunks) {
      const results = await translateChunk(chunk);
      for (const result of results) {
        const output = result.translatedText.trim();
        if (output) translated.push(output);
        inferenceTimeMs += result.inferenceTimeMs;
        resolvedSystemPrompt ??= result.systemPrompt;
      }
    }

    const targetLanguage = this.config?.targetLanguage?.toLowerCase() ?? '';
    const separator = /^(zh|ja)(-|$)/.test(targetLanguage) ? '' : ' ';
    return {
      sourceText,
      translatedText: translated.join(separator),
      inferenceTimeMs,
      systemPrompt: resolvedSystemPrompt,
    };
  }

  private cacheTranslationChunk(chunk: string, results: TranslationResult[]): void {
    // A live session only needs a small rolling cache. Map preserves insertion
    // order, so evicting the first key is deterministic and inexpensive.
    if (this.translationChunkCache.size >= 96) {
      const oldest = this.translationChunkCache.keys().next().value;
      if (oldest) this.translationChunkCache.delete(oldest);
    }
    this.translationChunkCache.set(chunk, results);
  }

  /**
   * Handle partial (interim) ASR result from streaming recognizer.
   * Creates or updates an in_progress user item with interim text.
   */
  private handlePartialAsrResult(text: string): void {
    if (!text.trim()) return;
    this.emitEvent('local.asr.partial', 'server', { text });
    this.schedulePartialTranslation(text);

    if (this.partialUserItem) {
      // Update existing partial item
      this.partialUserItem.formatted!.transcript = text;
      this.handlers.onConversationUpdated?.({ item: this.partialUserItem });
    } else {
      // Create new in_progress item
      this.partialUserItem = {
        id: `${this.instanceId}_user_${++this.itemCounter}`,
        role: 'user',
        type: 'message',
        status: 'in_progress',
        createdAt: Date.now(),
        formatted: {
          transcript: text,
        },
      };
      this.conversationItems.push(this.partialUserItem);
      this.handlers.onConversationUpdated?.({ item: this.partialUserItem });
    }
  }

  private ensureSegmenter(): SentenceSegmenter {
    if (!this.segmenter) this.resetSegmenter();
    return this.segmenter!;
  }

  private resetSegmenter(mode?: SegmentationMode): void {
    this.segmenter?.dispose();
    this.pendingAsrTiming = undefined;
    this.segmenter = new SentenceSegmenter({
      mode: mode ?? normalizeSegmentationMode(this.config?.segmentationMode),
      language: this.config?.sourceLanguage,
      onPending: (text) => {
        if (!this.disposed) this.handlePartialAsrResult(text);
      },
      onCommit: (text, _reason, segmentId) => {
        if (this.disposed) return;
        const timing = this.pendingAsrTiming;
        this.pendingAsrTiming = undefined;
        this.handleAsrResult(text, timing, segmentId);
      },
    });
  }

  private ingestAsrFinal(text: string, timing?: AsrTiming): void {
    if (timing) {
      if (!this.pendingAsrTiming) {
        this.pendingAsrTiming = { ...timing };
      } else {
        this.pendingAsrTiming = {
          durationMs: (this.pendingAsrTiming.durationMs || 0) + (timing.durationMs || 0),
          recognitionTimeMs:
            (this.pendingAsrTiming.recognitionTimeMs || 0) + (timing.recognitionTimeMs || 0),
        };
      }
    }
    this.ensureSegmenter().ingestFinal(text);
  }

  private handleAsrResult(text: string, timing?: AsrTiming, segmentId?: number): void {
    // In AST mode, text is already translated — show placeholder for user item
    const userTranscript = this.astMode
      ? i18n.t('mainPanel.speechDetected')
      : text;

    const revised = segmentId != null
      ? [...this.conversationItems].reverse().find((item) => item.role === 'user' && item.segmentId === segmentId)
      : undefined;
    if (revised && this.partialUserItem !== revised) {
      if (this.partialUserItem) {
        const extra = this.conversationItems.indexOf(this.partialUserItem);
        if (extra >= 0) this.conversationItems.splice(extra, 1);
      }
      revised.formatted = { ...revised.formatted, transcript: userTranscript };
      revised.status = 'completed';
      this.partialUserItem = null;
      this.handlers.onConversationUpdated?.({ item: revised });
      this.emitEvent('local.asr.end', 'server', {
        text,
        modelId: this.config?.asrModelId,
        ...(timing && { durationMs: timing.durationMs, recognitionTimeMs: timing.recognitionTimeMs }),
      });
      const existingAsst = [...this.conversationItems].reverse().find(
        (item) => item.role === 'assistant' && item.segmentId === segmentId,
      );
      this.ttsQueue.push({
        text,
        asrTiming: timing,
        assistantItem: existingAsst,
        segmentId,
      });
      this.processQueue();
      return;
    }

    if (this.partialUserItem) {
      // Finalize the partial item from streaming ASR
      this.partialUserItem.formatted!.transcript = userTranscript;
      this.partialUserItem.status = 'completed';
      if (segmentId != null) this.partialUserItem.segmentId = segmentId;
      this.handlers.onConversationUpdated?.({ item: this.partialUserItem });
      this.partialUserItem = null;
    } else {
      // Create new completed user item (offline ASR path)
      const userItem: ConversationItem = {
        id: `${this.instanceId}_user_${++this.itemCounter}`,
        role: 'user',
        type: 'message',
        status: 'completed',
        createdAt: Date.now(),
        formatted: {
          transcript: userTranscript,
        },
        ...(segmentId != null ? { segmentId } : {}),
      };
      this.conversationItems.push(userItem);
      this.handlers.onConversationUpdated?.({ item: userItem });
    }

    this.emitEvent('local.asr.end', 'server', {
      text,
      modelId: this.config?.asrModelId,
      ...(timing && { durationMs: timing.durationMs, recognitionTimeMs: timing.recognitionTimeMs }),
    });

    // Enqueue final translation + TTS. If incremental translation already
    // created a row, reuse it instead of appending a duplicate final row.
    const { item: assistantItem, pretranslatedSource } = this.takePartialAssistantForFinal(text);
    this.ttsQueue.push({
      text,
      asrTiming: timing,
      assistantItem: assistantItem ?? undefined,
      pretranslatedSource,
      segmentId,
    });
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.ttsProcessing) return;
    this.ttsProcessing = true;

    while (this.ttsQueue.length > 0) {
      if (this.disposed) break;

      const job = this.ttsQueue.shift()!;
      await this.processPipelineJob(job);
    }

    this.ttsProcessing = false;
  }

  private async processPipelineJob(job: PipelineJob): Promise<void> {
    const itemId = job.assistantItem?.id ?? `${this.instanceId}_asst_${++this.itemCounter}`;

    try {
      if (this.disposed) return;

      let displayText: string;

      if (this.translationEngine) {
        const resolvedPrompt = this.config?.instructions || '';
        const wrapTranscript = this.config?.wrapTranscript ?? true;
        const existingPartial = (job.assistantItem?.formatted?.transcript || '').trim();
        const canReusePartial =
          !!job.pretranslatedSource
          && job.pretranslatedSource.trim() === job.text.trim()
          && !!existingPartial;

        let translatedText: string;
        let inferenceTimeMs = 0;
        let systemPrompt: string | undefined;

        if (canReusePartial) {
          // Live incremental translation already produced the final string for
          // this exact source. Reuse it so short caption segments do not wait
          // on a second full model pass (and so the row never blanks).
          translatedText = existingPartial;
          this.emitEvent('local.translation.end', 'server', {
            sourceText: job.text,
            translatedText,
            inferenceTimeMs: 0,
            reusedPartial: true,
            wrapTranscript,
            modelId: this.config?.translationModelId,
          });
        } else {
          this.emitEvent('local.translation.start', 'client', {
            sourceText: job.text,
            modelId: this.config?.translationModelId,
            systemPrompt: resolvedPrompt,
            wrapTranscript,
          });
          const translationResult = await this.translateTextSafely(
            job.text,
            resolvedPrompt,
            wrapTranscript,
          );
          if (this.disposed) return;

          translatedText = translationResult.translatedText;
          inferenceTimeMs = translationResult.inferenceTimeMs;
          systemPrompt = translationResult.systemPrompt;
          console.debug(
            '[LocalInference] Translation:', job.text, '→', translatedText,
            `(${inferenceTimeMs}ms)`,
            '\n  systemPrompt:', systemPrompt,
            '\n  wrapTranscript:', wrapTranscript,
          );

          this.emitEvent('local.translation.end', 'server', {
            sourceText: job.text,
            translatedText,
            inferenceTimeMs,
            systemPrompt,
            wrapTranscript,
            modelId: this.config?.translationModelId,
          });
        }

        if (!translatedText?.trim()) {
          // Nothing to show: mark any reused live row completed so it does not
          // stick as in_progress forever, then drop out (no TTS on empty text).
          console.debug('[LocalInference] Translation empty — skipping:', job.text);
          if (job.assistantItem) {
            job.assistantItem.status = 'completed';
            this.handlers.onConversationUpdated?.({ item: job.assistantItem });
          }
          return;
        }

        displayText = translatedText;
      } else if (this.astMode) {
        // AST mode: ASR already produced translated text
        displayText = job.text;
        console.debug('[LocalInference] AST mode — text already translated:', displayText);
        if (!displayText) return;
      } else {
        // ASR-only mode: use source text directly as the assistant item
        console.debug('[LocalInference] ASR-only mode — displaying source text:', job.text);
        displayText = job.text;
      }

      // Finalize the existing live-translation row when present; short
      // utterances that never crossed the incremental threshold create one now.
      const existingAsst = job.assistantItem ?? (
        job.segmentId != null
          ? [...this.conversationItems].reverse().find(
              (item) => item.role === 'assistant' && item.segmentId === job.segmentId,
            )
          : undefined
      );
      const assistantItem: ConversationItem = existingAsst ?? {
        id: itemId,
        role: 'assistant',
        type: 'message',
        status: 'in_progress',
        createdAt: Date.now(),
        formatted: {},
      };
      if (job.segmentId != null) assistantItem.segmentId = job.segmentId;
      assistantItem.status = 'in_progress';
      assistantItem.formatted = {
        ...assistantItem.formatted,
        transcript: displayText,
      };
      if (!existingAsst) {
        this.conversationItems.push(assistantItem);
      }
      this.handlers.onConversationUpdated?.({ item: assistantItem });

      // TTS (optional) — split into sentences for reduced time-to-first-audio
      if (this.ttsEngine && this.config && !this.disposed) {
        const ttsEntry = getManifestEntry(this.config.ttsModelId || '');
        const isEdgeTts = ttsEntry?.engine === 'edge-tts';

        const sentences = splitSentences(displayText, this.config.targetLanguage);
        const ttsStartTime = performance.now();
        this.emitEvent('local.tts.start', 'client', {
          text: displayText,
          sentenceCount: sentences.length,
          modelId: this.config?.ttsModelId,
          // Include voice identity (edge-tts voice name, or speaker ID for
          // local multi-speaker models) and speed so the LogsPanel reflects
          // exactly which configuration produced the audio.
          voice: isEdgeTts ? this.config.edgeTtsVoice : `speaker:${this.config.ttsSpeakerId}`,
          speed: this.config.ttsSpeed,
        });
        console.debug(`[Karaoke] TTS start: fullText="${displayText}" (${displayText.length} chars), ${sentences.length} sentences:`, sentences.map((s, i) => `[${i}] "${s}" (${s.length} chars)`));

        let searchFrom = 0;
        let cumulativeAudioDuration = 0;
        assistantItem.formatted!.audioSegments = [];

        for (let i = 0; i < sentences.length; i++) {
          if (this.disposed) return;

          try {
            this.emitEvent('local.tts.sentence.start', 'client', {
              sentenceIndex: i,
              sentenceCount: sentences.length,
              text: sentences[i],
            });

            if (isEdgeTts) {
              // Streaming path — Edge TTS sends audio-chunk messages.
              //
              // The non-streaming path updates audioTextEnd/audioSegments *before*
              // emitting the audio delta, so the renderer always has fresh karaoke
              // metadata when the audio plays. For streaming we pre-compute
              // audioTextEnd (we know which sentence we're about to speak) so
              // chunks emitted mid-stream already reference up-to-date metadata.
              // audioSegments can only be pushed after we know the total audio
              // duration, so we push + emit a metadata update once the stream ends.
              const pos = displayText.indexOf(sentences[i], searchFrom);
              const audioTextEnd = pos >= 0 ? pos + sentences[i].length : searchFrom + sentences[i].length;
              searchFrom = audioTextEnd;
              assistantItem.formatted!.audioTextEnd = audioTextEnd;

              let chunkSampleCount = 0;
              const sentenceStart = performance.now();
              await this.ttsEngine.generateStream(
                sentences[i],
                0,  // sid unused for edge-tts
                this.config.ttsSpeed,
                this.config.targetLanguage,
                (chunkSamples, chunkSampleRate) => {
                  if (this.disposed) return;
                  const resampled = resampleFloat32(chunkSamples, chunkSampleRate, 24000);
                  const int16Audio = float32ToInt16(resampled);
                  chunkSampleCount += int16Audio.length;
                  // Gated on keepReplayAudio — when off, the per-item replay
                  // buffer is skipped. Real-time playback below (via the audio
                  // delta) is unaffected. Karaoke math (sentenceAudioDuration)
                  // is computed from chunkSampleCount, not from the stored
                  // buffer, so gating does not affect it.
                  if (this.keepReplayAudio) {
                    this.appendItemAudio(assistantItem, int16Audio);
                  }
                  this.handlers.onConversationUpdated?.({
                    item: assistantItem,
                    delta: { audio: int16Audio },
                  });
                },
                this.config.edgeTtsVoice,
              );
              if (this.disposed) return;

              const sentenceAudioDuration = chunkSampleCount / 24000;
              cumulativeAudioDuration += sentenceAudioDuration;
              assistantItem.formatted!.audioSegments!.push({
                textEnd: audioTextEnd,
                audioEnd: cumulativeAudioDuration,
              });

              // Publish the finalized segment metadata so the renderer picks up
              // timing info without waiting for the full response to complete.
              this.handlers.onConversationUpdated?.({ item: assistantItem });

              const generateMs = Math.round(performance.now() - sentenceStart);
              this.emitEvent('local.tts.sentence.end', 'server', {
                sentenceIndex: i,
                sentenceCount: sentences.length,
                text: sentences[i],
                generateMs,
                audioDurationMs: Math.round(sentenceAudioDuration * 1000),
              });

              console.debug(`[Karaoke] TTS sentence ${i + 1}/${sentences.length}: "${sentences[i]}" → ${sentenceAudioDuration.toFixed(3)}s audio (streaming)`);
            } else {
              const sentenceStart = performance.now();
              const ttsResult = await this.ttsEngine.generate(
                sentences[i],
                this.config.ttsSpeakerId,
                this.config.ttsSpeed,
                this.config.targetLanguage,
              );
              if (this.disposed) return;

              // Track how far into the text TTS audio has been generated
              const pos = displayText.indexOf(sentences[i], searchFrom);
              const audioTextEnd = pos >= 0 ? pos + sentences[i].length : searchFrom + sentences[i].length;
              searchFrom = audioTextEnd;
              assistantItem.formatted!.audioTextEnd = audioTextEnd;

              // Resample to 24kHz and convert to Int16
              const resampled = resampleFloat32(ttsResult.samples, ttsResult.sampleRate, 24000);
              const int16Audio = float32ToInt16(resampled);

              // Track per-sentence audio-to-text mapping for accurate karaoke
              const sentenceAudioDuration = int16Audio.length / 24000;
              cumulativeAudioDuration += sentenceAudioDuration;
              assistantItem.formatted!.audioSegments!.push({
                textEnd: audioTextEnd,
                audioEnd: cumulativeAudioDuration,
              });

              const generateMs = Math.round(performance.now() - sentenceStart);
              this.emitEvent('local.tts.sentence.end', 'server', {
                sentenceIndex: i,
                sentenceCount: sentences.length,
                text: sentences[i],
                generateMs,
                audioDurationMs: Math.round(sentenceAudioDuration * 1000),
              });

              console.debug(`[Karaoke] TTS sentence ${i + 1}/${sentences.length}: "${sentences[i]}" (${sentences[i].length} chars) → ${sentenceAudioDuration.toFixed(3)}s audio | textEnd=${audioTextEnd}/${displayText.length}, cumAudio=${cumulativeAudioDuration.toFixed(3)}s`);

              // Emit audio delta immediately — player receives chunk right away.
              // The replay buffer (appendItemAudio) is gated on keepReplayAudio,
              // but the delta below dispatches to real-time playback regardless.
              // Karaoke math above uses int16Audio.length directly, not the
              // stored buffer, so it is unaffected.
              if (this.keepReplayAudio) {
                this.appendItemAudio(assistantItem, int16Audio);
              }
              this.handlers.onConversationUpdated?.({
                item: assistantItem,
                delta: { audio: int16Audio },
              });
            }
          } catch (ttsError) {
            console.warn(`[LocalInference] TTS failed for sentence ${i + 1}/${sentences.length}, skipping:`, ttsError);
            this.emitEvent('local.tts.error', 'server', {
              error: ttsError instanceof Error ? ttsError.message : String(ttsError),
              sentenceIndex: i,
            });
          }
        }

        // Ensure trailing whitespace is covered
        assistantItem.formatted!.audioTextEnd = displayText.length;
        console.debug(`[Karaoke] TTS complete: ${assistantItem.formatted!.audioSegments!.length} segments, totalAudio=${cumulativeAudioDuration.toFixed(3)}s, totalChars=${displayText.length}`);

        const ttsDurationMs = performance.now() - ttsStartTime;
        this.emitEvent('local.tts.end', 'server', { sentenceCount: sentences.length, durationMs: Math.round(ttsDurationMs) });
      }

      // Mark completed
      assistantItem.status = 'completed';
      this.handlers.onConversationUpdated?.({ item: assistantItem });

    } catch (error) {
      // Session ending — expected, not an error
      if (this.disposed) return;

      console.error('[LocalInference] Pipeline error:', error);
      if (job.assistantItem) {
        // Drop the empty/stale live row so the dedicated error item is the one
        // users see — leaving both with related ids used to collide in React
        // keys and karaoke highlight maps.
        job.assistantItem.status = 'completed';
        if (!job.assistantItem.formatted?.transcript?.trim()) {
          const idx = this.conversationItems.indexOf(job.assistantItem);
          if (idx >= 0) this.conversationItems.splice(idx, 1);
        } else {
          this.handlers.onConversationUpdated?.({ item: job.assistantItem });
        }
      }
      const userMessage = humanizeTranslationError(error);
      this.emitEvent('local.pipeline.error', 'server', {
        error: error instanceof Error ? error.message : String(error),
        userMessage,
      });

      // Always mint a fresh id — never reuse the assistant item id, or React
      // keys / karaoke maps treat the error bubble as the same row.
      const errorItem: ConversationItem = {
        id: `${this.instanceId}_err_${++this.itemCounter}`,
        role: 'assistant',
        type: 'error',
        status: 'completed',
        createdAt: Date.now(),
        formatted: { transcript: `Translation error: ${userMessage}` },
      };
      this.conversationItems.push(errorItem);
      this.handlers.onConversationUpdated?.({ item: errorItem });
    }
  }
}

/**
 * Maps a translation-worker error to a user-facing string.
 *
 * The Bing worker prefixes its error messages with a tag like `[bing:token]`
 * or `[bing:network]` (see src/lib/local-inference/workers/bing-translation.worker.ts).
 * This helper peels the tag off and picks a friendly sentence. Errors without
 * the tag fall through to the original message.
 */
const BING_ERROR_MESSAGES: Record<string, string> = {
  token: 'Bing Translator could not connect. Check your network and try again.',
  unsupported: 'Bing Translator does not support this language pair.',
  network: 'Bing Translator is temporarily unavailable.',
};

const GOOGLE_ERROR_MESSAGES: Record<string, string> = {
  unsupported: 'Google Translator does not support this language pair.',
  network: 'Google Translator is temporarily unavailable. Check your network or try Bing.',
};

function humanizeTranslationError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  if (!raw) return 'Translation failed.';

  const bingMatch = raw.match(/^\[bing:(token|unsupported|network|unknown)\]\s*(.*)$/);
  if (bingMatch) {
    const tag = bingMatch[1];
    const detail = bingMatch[2];
    const known = BING_ERROR_MESSAGES[tag];
    if (known) return known;
    return detail ? `Bing Translator failed: ${detail}` : 'Bing Translator failed.';
  }

  const googleMatch = raw.match(/^\[google:(unsupported|network|unknown)\]\s*(.*)$/);
  if (googleMatch) {
    const tag = googleMatch[1];
    const detail = googleMatch[2];
    const known = GOOGLE_ERROR_MESSAGES[tag];
    if (known) return known;
    return detail ? `Google Translator failed: ${detail}` : 'Google Translator failed.';
  }

  return raw;
}
