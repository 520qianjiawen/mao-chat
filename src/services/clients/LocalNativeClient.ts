import type { IClient, SessionConfig, ConversationItem, ClientEventHandlers, ResponseConfig } from '../interfaces/IClient';
import { isLocalNativeSessionConfig } from '../interfaces/IClient';
import type { ProviderType } from '../../types/Provider';
import { Provider } from '../../types/Provider';
import { NativeAsrClient } from '../../lib/local-inference/native/NativeAsrClient';
import { NativeTranslateClient } from '../../lib/local-inference/native/NativeTranslateClient';
import { NativeTtsClient } from '../../lib/local-inference/native/NativeTtsClient';
import { TranslationEngine } from '../../lib/local-inference/engine/TranslationEngine';
import { resampleFloat32, float32ToInt16 } from '../../utils/audio-conversion';
import { transcriptLooksForeign } from '../../utils/transcriptScript';
import { reconcileTtsVoice } from '../../lib/local-inference/native/nativeTtsVoiceReconciliation';
import { isNativeOnlineTranslation, isOllamaTranslation, sidFromTtsVoice, voiceCapability } from '../../lib/local-inference/native/nativeCatalog';
import { voiceStoreFor } from '../../lib/local-inference/native/nativeVoiceStores';
import type { NativeModelInfo } from '../../lib/local-inference/native/nativeProtocol';
import { splitSentences } from '../../utils/splitSentences';
import { useNativeModelStore, nativeListTtsVoices, nativeHardwareInfo } from '../../stores/nativeModelStore';
import {
  SentenceSegmenter,
  normalizeSegmentationMode,
  shouldTranslatePending,
} from '../../lib/local-inference/sentenceSegmenter';
import { asrTuningForMode } from '../../lib/local-inference/asrTuning';
import { OllamaTranslatorClient } from '../../lib/ollama-translator';

interface Deps {
  asr?: NativeAsrClient | any;
  translate?: NativeTranslateClient | any;
  onlineTranslate?: TranslationEngine | any;
  ollamaTranslate?: OllamaTranslatorClient | any;
  tts?: NativeTtsClient | any;
}

// Online MT can cheaply follow cumulative streaming-ASR hypotheses. Coalesce
// the rapid token churn so Bing/Google update the live subtitle a few times a
// second without receiving one request per token.
const NATIVE_LIVE_TRANSLATION_DEBOUNCE_MS = 140;
const NATIVE_LIVE_TRANSLATION_MIN_INTERVAL_MS = 360;

// hayamimi's second-pass rewrite is stored as a SEPARATE user/assistant pair
// next to the raw first-pass group (wide conversation views show both). The
// pair needs its own segmentId for translation pairing; the base offsets it
// far above any sidecar-assigned segment id.
const REFINED_SEGMENT_ID_BASE = 100000;

export function shouldTranslateNativePartial(text: string, language?: string): boolean {
  return shouldTranslatePending(text, language);
}

/**
 * IClient for the native (Electron sidecar) provider. Orchestrates the native
 * WS clients into the session's ConversationItem pipeline: ASR → translation,
 * with TTS optional (native TTS today is Pocket/voice-cloning and needs a
 * reference clip, so the MVP is text-only). Does not touch LocalInferenceClient.
 */
export class LocalNativeClient implements IClient {
  private asr: any;
  private translate: any;
  private onlineTranslate: any;
  private ollamaTranslate: any;
  private tts: any;
  private handlers: ClientEventHandlers = {};
  private items: ConversationItem[] = [];
  private connected = false;
  private idCounter = 0;
  private cfg: any = null;
  private ttsEnabled = false;
  private ttsStreaming = false;
  private ttsSpeed = 1.0;
  private ttsVoiceLabel = '';
  private keepReplayAudio: boolean = false;
  private queue: Promise<void> = Promise.resolve();
  private partialUserItem: ConversationItem | null = null;
  private partialAssistantItem: ConversationItem | null = null;
  private pendingPartialTranslationText: string | null = null;
  private lastPartialTranslationText = '';
  private partialTranslationInFlight = false;
  private partialTranslationTimer: ReturnType<typeof setTimeout> | null = null;
  private partialTranslationLastStartedAt = 0;
  private partialTranslationGeneration = 0;
  private segmenter: SentenceSegmenter | null = null;
  private detectedSourceLanguage: string | null = null;
  private asrRefinementGeneration = 0;

  constructor(deps: Deps = {}) {
    this.asr = deps.asr ?? new NativeAsrClient();
    this.translate = deps.translate ?? new NativeTranslateClient();
    this.onlineTranslate = deps.onlineTranslate ?? new TranslationEngine();
    this.ollamaTranslate = deps.ollamaTranslate ?? new OllamaTranslatorClient();
    this.tts = deps.tts ?? new NativeTtsClient();
  }

  async connect(config: SessionConfig): Promise<void> {
    if (!isLocalNativeSessionConfig(config)) throw new Error('LocalNativeClient requires a local_native config');
    this.cfg = {
      ...config,
      enableAsrRefinement: config.enableAsrRefinement !== false,
      textOnly: Boolean(config.textOnly)
        || normalizeSegmentationMode(config.segmentationMode) === 'video',
    };
    this.detectedSourceLanguage = null;
    this.resetSegmenter();
    this.asr.onResult = (r: any) => this.onAsrResult(r);
    this.asr.onRefine = (r: any) => this.onAsrRefine(r);
    this.asr.onPartialResult = (text: string, language?: string) => this.onAsrPartial(text, language);
    this.asr.onSpeechStart = () => {
      if (!this.isHayamimi()) this.segmenter?.notifySpeechStart();
    };
    this.asr.onError = (e: string) => this.handlers.onError?.(e);
    this.translate.onError = (e: string) => this.handlers.onError?.(e);
    this.onlineTranslate.onError = (e: string) => this.handlers.onError?.(e);
    this.tts.onError = (e: string) => this.handlers.onError?.(e);
    this.emitEvent('local.native.init.start', 'client', {
      asr: config.asrModelId, translation: config.translationModelId, tts: config.ttsModelId,
      sourceLanguage: config.sourceLanguage, targetLanguage: config.targetLanguage,
    });
    // Best-effort machine snapshot so the Logs panel shows which GPU/backends
    // the session resolved against (helps diagnose "GPU wasn't used"). Fire-and-
    // forget: this diagnostic probe must never delay ASR/translation init on the
    // startup critical path. Null (sidecar unavailable) simply skips the line.
    nativeHardwareInfo().then((hw) => {
      if (hw) {
        this.emitEvent('local.native.hardware', 'client', {
          os: hw.os, arch: hw.arch, cpuCores: hw.cpuCores,
          gpus: hw.gpus, backendsInstalled: hw.backendsInstalled, accelAvailable: hw.accelAvailable,
        });
      }
    }).catch(() => { /* diagnostics only — ignore probe failures */ });
    this.ttsSpeed = config.ttsSpeed ?? 1.0;
    this.keepReplayAudio = config.keepReplayAudio ?? false;
    const store = useNativeModelStore.getState();
    const initTranslate = async () => {
      // Transcription-only session: no model selected. Skip init entirely —
      // the sidecar would otherwise substitute its default translation model
      // and silently translate in a session the UI declared ASR-only.
      if (!config.translationModelId) return;
      if (isNativeOnlineTranslation(config.translationModelId)) {
        const tr = await this.onlineTranslate.init(
          config.sourceLanguage,
          config.targetLanguage,
          config.translationModelId,
          { apiKey: config.deeplApiKey },
        );
        const resolved = {
          model: config.translationModelId, device: 'cloud', backend: config.translationModelId,
          computeType: 'online', loadTimeMs: tr.loadTimeMs,
        };
        store.setTranslationResolved(resolved);
        this.emitInitReady('translation', config.translationModelId, resolved);
        return;
      }
      if (isOllamaTranslation(config.translationModelId)) {
        const tr = await this.ollamaTranslate.init(
          config.sourceLanguage,
          config.targetLanguage,
          config.translationModelId,
        );
        const resolved = {
          model: config.translationModelId, device: 'ollama', backend: 'ollama',
          computeType: 'local-llm', loadTimeMs: tr.loadTimeMs,
        };
        store.setTranslationResolved(resolved);
        this.emitInitReady('translation', config.translationModelId, resolved);
        return;
      }
      const tr = await this.translate.init(
        config.sourceLanguage === 'auto' ? '' : config.sourceLanguage,
        config.targetLanguage, config.translationModelId, config.translationDevice,
        config.asrModelId, config.ttsModelId, config.translationVariant,
      );
      store.setTranslationResolved({ model: config.translationModelId ?? '', device: tr.device ?? 'cpu', backend: tr.backend, computeType: tr.computeType, tokensPerSec: tr.tokensPerSec, memoryBytes: tr.memoryBytes, fallbackReason: tr.fallbackReason });
      this.emitInitReady('translation', config.translationModelId ?? '', tr);
    };
    const initAsr = async () => {
      store.setAsrLoading(true);
      try {
        const mode = normalizeSegmentationMode(this.cfg?.segmentationMode);
        const asrTune = asrTuningForMode(mode, config.sourceLanguage);
        const video = mode === 'video';
        const hayamimi = config.asrModelId === 'hayamimi-asr';
        const res = await this.asr.init(config.sourceLanguage, config.asrModelId, 24000, {
          threshold: hayamimi ? (config.vadThreshold ?? 0.5) : video ? Math.min(config.vadThreshold ?? asrTune.vadThreshold, asrTune.vadThreshold) : config.vadThreshold,
          minSilence: hayamimi ? (config.vadMinSilenceDuration ?? 0.35) : video ? Math.min(config.vadMinSilenceDuration ?? asrTune.minSilenceDuration, asrTune.minSilenceDuration) : config.vadMinSilenceDuration,
          minSpeech: hayamimi ? (config.vadMinSpeechDuration ?? 0.25) : video ? Math.min(config.vadMinSpeechDuration ?? asrTune.minSpeechDuration, asrTune.minSpeechDuration) : config.vadMinSpeechDuration,
          maxSpeech: hayamimi ? 12.0 : asrTune.maxSpeechDuration,
        }, config.asrDevice, config.asrVariant, this.isAsrRefinementEnabled());
        store.setAsrResolved({ model: config.asrModelId, device: res.device ?? 'cpu', backend: res.backend, computeType: res.computeType, rtf: res.rtf, memoryBytes: res.memoryBytes, fallbackReason: res.fallbackReason });
        this.emitInitReady('asr', config.asrModelId ?? '', res);
      } finally {
        store.setAsrLoading(false);
      }
    };
    // Load the GPU-priority stage first so it claims VRAM before the flexible
    // stage. With two Auto models that can't co-reside (e.g. a GPU-only Voxtral +
    // a 2B Qwen translation), whoever loads first wins the card; the flexible
    // model then degrades to CPU instead of the GPU-only one hard-failing.
    if (this.asrLoadsFirst(config.asrModelId, config.translationModelId ?? '')) {
      await initAsr();
      await initTranslate();
    } else {
      await initTranslate();
      await initAsr();
    }
    this.ttsEnabled = !!this.cfg.ttsModelId && !this.cfg.textOnly;
    if (this.ttsEnabled) {
      store.setTtsLoading(true);
      try {
        const r = await this.tts.init(config.ttsModelId, config.ttsDevice, config.targetLanguage, config.ttsVariant);
        this.ttsStreaming = !!r.streaming;
        store.setTtsResolved({ model: config.ttsModelId!, device: r.device ?? 'cpu', backend: r.backend, computeType: r.computeType,
          rtf: r.rtf, memoryBytes: r.memoryBytes, fallbackReason: r.fallbackReason });
        this.emitInitReady('tts', config.ttsModelId!, r);
        // Apply the selected voice (next-session semantics), driven by the
        // model's capability (built-in named/range and/or custom clip/style)
        // rather than a MOSS-specific "clones" flag, so any current or future
        // voice-capable model resolves through the same path. Custom ids
        // resolve against the capability's own store; a missing/deleted
        // custom voice reconciles back to the per-language default. Storage
        // failure degrades to built-in voices only (it must not kill TTS),
        // so list() failures are caught locally.
        // If the catalog hasn't loaded yet, fall back to the init response's
        // clones flag (the pre-capability behavior) so a clone-capable model
        // still applies its custom/named voice instead of silently degrading.
        const ttsModel = store.catalog[config.ttsModelId!]
          ?? ({ clones: r.clones } as unknown as NativeModelInfo);
        const cap = voiceCapability(ttsModel);
        const voiceStore = voiceStoreFor(cap.custom, config.ttsModelId!);
        let customIds: number[] = [];
        if (voiceStore) {
          try { customIds = (await voiceStore.list()).map((v) => v.id); }
          catch { /* storage unavailable → built-in voices only */ }
        }
        const voiceList = cap.builtin === 'named' ? await nativeListTtsVoices(config.ttsModelId) : [];
        const voice = reconcileTtsVoice(
          config.ttsVoice ?? '', customIds, config.targetLanguage, voiceList,
          cap.builtin === 'named' || cap.custom !== 'none',
        );
        this.ttsVoiceLabel = voice;   // e.g. builtin:Bella | custom:7 | sid:3 — logged on tts.start
        try {
          if (voice.startsWith('builtin:')) {
            await this.tts.setVoice?.(voice.slice('builtin:'.length));
          } else if (voice.startsWith('custom:') && voiceStore) {
            const payload = await voiceStore.resolveApply(Number(voice.slice('custom:'.length)));
            if (payload?.kind === 'clip') await this.tts.setReferenceVoice(payload.audio, payload.sampleRate, payload.transcript);
            else if (payload?.kind === 'style') await this.tts.setStyleVoice(payload.styleTtl, payload.styleDp);
          } else if (voice.startsWith('sid:')) {
            await this.tts.setSpeaker(sidFromTtsVoice(voice));
          }
          // else single-voice model with no selection: send nothing (backend uses speaker 0)
        } catch (voiceErr) {
          // A stale voice from another card (MOSS "Xiaoyu" on Kokoro/Pocket)
          // must not disable the whole TTS stage. Backends that have a default
          // (SoVITS, Pocket, moss_onnx) still synthesize; others keep speaker 0.
          this.emitEvent('local.native.tts.voice.error', 'client', {
            voice, error: voiceErr instanceof Error ? voiceErr.message : String(voiceErr),
          });
        }
      } catch (e) {
        this.ttsEnabled = false;
        this.handlers.onError?.(`native TTS init failed: ${e}`);
      } finally {
        store.setTtsLoading(false);
      }
    }
    this.connected = true;
    this.emitEvent('local.native.init.ready', 'client', { ttsEnabled: this.ttsEnabled });
    this.handlers.onOpen?.();
  }

  /**
   * Decide which stage loads first so the model that most needs the GPU claims
   * VRAM before the other. A model is "GPU-only" when the sidecar catalog lists
   * tiers for it but none is `cpu` (e.g. Voxtral) — that stage MUST get the GPU,
   * so it goes first. When both or neither are GPU-only, the larger model (by
   * download size) leads. Falls back to ASR-first when catalog/size data isn't
   * loaded yet — ASR is the only stage that can be GPU-only today, so leading
   * with it is the safe default. Never throws; ordering is best-effort.
   */
  private asrLoadsFirst(asrId: string, translationId: string): boolean {
    try {
      const { catalog, sizes } = useNativeModelStore.getState();
      const gpuOnly = (id: string): boolean => {
        const info = catalog[id];
        return !!info && info.tiers.length > 0 && !info.tiers.some((t) => t.tier === 'cpu');
      };
      const asrGpuOnly = gpuOnly(asrId);
      const trGpuOnly = gpuOnly(translationId);
      if (asrGpuOnly !== trGpuOnly) return asrGpuOnly;
      return (sizes[asrId] ?? 0) >= (sizes[translationId] ?? 0);
    } catch {
      return true;
    }
  }

  private nextId(p: string): string { return `${p}_${Date.now()}_${++this.idCounter}`; }

  private isHayamimi(): boolean { return this.cfg?.asrModelId === 'hayamimi-asr'; }

  private isAsrRefinementEnabled(): boolean {
    return this.cfg?.enableAsrRefinement !== false;
  }

  private emit(item: ConversationItem, delta?: any): void {
    this.handlers.onConversationUpdated?.({ item, delta });
  }

  /** Mirror the LocalInferenceClient logging contract so events reach the Logs panel. */
  private emitEvent(type: string, source: 'client' | 'server', data: Record<string, any> = {}): void {
    this.handlers.onRealtimeEvent?.({ source, event: { type, data } } as any);
  }

  /**
   * Surface the sidecar's resolved plan for one stage into the Logs panel:
   * which device/backend/quant it landed on, its load time and RTF/tokens, and
   * — critically — a distinct `.fallback` line when the stage was moved off the
   * requested device (e.g. GPU→CPU), which was previously silent. Only defined
   * metrics are attached so CPU-only stages don't log empty `rtf`/`memoryBytes`.
   */
  private emitInitReady(engine: 'asr' | 'translation' | 'tts', modelId: string, r: any): void {
    this.emitEvent(`local.native.init.${engine}.ready`, 'client', {
      model: modelId, device: r.device ?? 'cpu', backend: r.backend, computeType: r.computeType,
      ...(r.rtf !== undefined && { rtf: r.rtf }),
      ...(r.tokensPerSec !== undefined && { tokensPerSec: r.tokensPerSec }),
      ...(r.memoryBytes !== undefined && { memoryBytes: r.memoryBytes }),
      loadTimeMs: r.loadTimeMs,
    });
    if (r.fallbackReason) {
      this.emitEvent(`local.native.init.${engine}.fallback`, 'client', { model: modelId, fallbackReason: r.fallbackReason });
    }
  }

  /**
   * Accumulate a TTS audio chunk onto the item so the inline replay button has
   * a complete buffer. Gated on `keepReplayAudio`; real-time playback (via the
   * audio delta) is unaffected when this is skipped.
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

  private resetSegmenter(): void {
    this.segmenter?.dispose();
    this.segmenter = new SentenceSegmenter({
      mode: normalizeSegmentationMode(this.cfg?.segmentationMode),
      language: this.cfg?.sourceLanguage,
      onPending: (text) => this.showPendingTranscript(text),
      onCommit: (text, _reason, segmentId) => this.commitAsrText(text, segmentId),
    });
  }

  private showPendingTranscript(text: string, detectedLanguage?: string): void {
    if (!text.trim()) return;
    this.emitEvent('local.native.asr.partial', 'server', { text });
    if (!this.partialUserItem) {
      this.partialUserItem = {
        id: this.nextId('user'), role: 'user', type: 'message', status: 'in_progress',
        createdAt: Date.now(), formatted: { transcript: text },
        ...(detectedLanguage ? { detectedLanguage } : {}),
      };
      this.items.push(this.partialUserItem);
      this.emit(this.partialUserItem);
    } else {
      this.partialUserItem.formatted!.transcript = text;
      if (detectedLanguage) this.partialUserItem.detectedLanguage = detectedLanguage;
      this.emit(this.partialUserItem, { transcript: text });
    }
    this.schedulePartialTranslation(text);
  }

  private applyDetectedLanguage(language?: string): void {
    if (this.cfg?.sourceLanguage !== 'auto' || !language || language === 'auto') return;
    this.detectedSourceLanguage = language;
    this.segmenter?.setLanguage(language);
  }

  private onAsrPartial(text: string, language?: string): void {
    if (!text) return;
    this.applyDetectedLanguage(language);
    if (transcriptLooksForeign(text, this.detectedSourceLanguage ?? this.cfg?.sourceLanguage)) return;
    if (this.isHayamimi()) {
      this.showPendingTranscript(text, language);
      return;
    }
    this.segmenter?.ingestPartial(text);
  }

  private onAsrResult(r: {
    text: string;
    durationMs?: number;
    recognitionTimeMs?: number;
    startSample?: number;
    language?: string;
    segmentId?: number;
  }): void {
    if (!r.text?.trim()) return;
    this.applyDetectedLanguage(r.language);
    if (transcriptLooksForeign(
      r.text, this.detectedSourceLanguage ?? this.cfg?.sourceLanguage,
    )) {
      this.emitEvent('local.native.asr.ignored', 'client', {
        text: r.text, reason: 'script-mismatch', sourceLanguage: this.cfg?.sourceLanguage,
      });
      this.partialUserItem = null;
      this.partialAssistantItem = null;
      this.segmenter?.reset();
      return;
    }
    // rtf = compute time / audio duration — the single "can it keep up with
    // real time" number. Only derived when the sidecar sent both timings.
    const rtf = r.durationMs && r.recognitionTimeMs !== undefined
      ? Math.round((r.recognitionTimeMs / r.durationMs) * 1000) / 1000 : undefined;
    this.emitEvent('local.native.asr.end', 'server', {
      text: r.text, modelId: this.cfg?.asrModelId,
      ...(r.language && { language: r.language }),
      ...(r.durationMs !== undefined && { durationMs: r.durationMs }),
      ...(r.recognitionTimeMs !== undefined && { recognitionTimeMs: r.recognitionTimeMs }),
      ...(rtf !== undefined && { rtf }),
    });
    if (this.isHayamimi()) {
      this.commitAsrText(r.text, r.segmentId, r.language);
      return;
    }
    this.segmenter?.ingestFinal(r.text, {
      startSample: r.startSample,
      durationMs: r.durationMs,
    });
  }

  private onAsrRefine(r: {
    text: string;
    language?: string;
    segmentIds: number[];
    startSample?: number;
    durationMs?: number;
    recognitionTimeMs?: number;
  }): void {
    if (!this.isHayamimi() || !r.text?.trim() || !r.segmentIds?.length) return;
    if (!this.isAsrRefinementEnabled()) {
      this.emitEvent('local.native.asr.refine.ignored', 'client', {
        text: r.text, reason: 'subtitle-mode', segmentIds: r.segmentIds,
      });
      return;
    }
    const refinementGeneration = this.asrRefinementGeneration;
    this.applyDetectedLanguage(r.language);
    if (transcriptLooksForeign(
      r.text, this.detectedSourceLanguage ?? this.cfg?.sourceLanguage,
    )) {
      this.emitEvent('local.native.asr.refine.ignored', 'client', {
        text: r.text, reason: 'script-mismatch', segmentIds: r.segmentIds,
      });
      return;
    }
    const segmentIds = [...new Set(r.segmentIds)];
    const primarySegmentId = segmentIds[0];
    this.emitEvent('local.native.asr.refine', 'server', {
      text: r.text, segmentIds,
      ...(r.language && { language: r.language }),
      ...(r.durationMs !== undefined && { durationMs: r.durationMs }),
      ...(r.recognitionTimeMs !== undefined && { recognitionTimeMs: r.recognitionTimeMs }),
    });

    // Fast-final translations are serialized on this same queue. Waiting for
    // them before replacing the group prevents an older in-flight translation
    // from reappearing after the refined source has landed.
    this.queue = this.queue.then(async () => {
      // Subtitle mode can be entered while fast-final translations are still
      // ahead of this task. Do not let that queued rewrite appear later (even
      // if the user has already returned to conversation mode by then).
      if (!this.isAsrRefinementEnabled()
          || refinementGeneration !== this.asrRefinementGeneration) return;
      const wanted = new Set(segmentIds);
      // The raw first-pass group STAYS — wide conversation views show it next
      // to the polished rewrite (split columns); narrow surfaces hide the
      // superseded raw rows via hideSupersededRaw. Only a PREVIOUS refined
      // rendering of these source segments is replaced here.
      this.items = this.items.filter((item) =>
        !item.refined || !item.refinedFor?.some((s) => wanted.has(s)),
      );
      let groupEnd = 0;
      this.items.forEach((item, index) => {
        if (item.segmentId != null && wanted.has(item.segmentId)) groupEnd = index + 1;
      });

      const refinedSegmentId = REFINED_SEGMENT_ID_BASE + primarySegmentId;
      const userItem: ConversationItem = {
        id: this.nextId('user'), role: 'user', type: 'message', status: 'completed',
        createdAt: Date.now(), formatted: { transcript: r.text },
        // Synthetic segment id: pairs the rewrite with its own translation
        // for ordering, and never collides with sidecar-assigned ids.
        segmentId: refinedSegmentId,
        refined: true,
        refinedFor: segmentIds,
        ...(r.language ? { detectedLanguage: r.language } : {}),
      };
      this.items.splice(groupEnd, 0, userItem);
      this.emit(userItem);

      // Translate the authoritative refined text once. TTS is deliberately
      // suppressed here so a listener does not hear both the fast draft and
      // the second-pass revision.
      await this.runJob(r.text, undefined, undefined, refinedSegmentId, true, {
        refined: true,
        refinedFor: segmentIds,
      });
    }).catch((e) => {
      this.emitEvent('local.native.error', 'client', { error: String(e) });
      this.handlers.onError?.(String(e));
    });
  }

  private findItem(role: ConversationItem['role'], segmentId?: number): ConversationItem | undefined {
    if (segmentId == null) return undefined;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item.role === role && item.segmentId === segmentId) return item;
    }
    return undefined;
  }

  private commitAsrText(text: string, segmentId?: number, detectedLanguage?: string): void {
    if (!text.trim()) return;
    const revised = this.findItem('user', segmentId);
    if (revised && this.partialUserItem !== revised) {
      // Same segment_id: a later ASR chunk revised a fragment already shown.
      if (this.partialUserItem) {
        const extra = this.items.indexOf(this.partialUserItem);
        if (extra >= 0) this.items.splice(extra, 1);
      }
      revised.status = 'completed';
      revised.formatted = { ...revised.formatted, transcript: text };
      if (detectedLanguage) revised.detectedLanguage = detectedLanguage;
      this.partialUserItem = null;
      this.emit(revised);
      const existingAsst = this.findItem('assistant', segmentId);
      this.queue = this.queue.then(() => this.runJob(
        text,
        existingAsst,
        undefined,
        segmentId,
      )).catch((e) => {
        this.emitEvent('local.native.error', 'client', { error: String(e) });
        this.handlers.onError?.(String(e));
      });
      return;
    }
    let userItem = this.partialUserItem;
    if (userItem) {
      userItem.status = 'completed';
      userItem.formatted!.transcript = text;
      if (segmentId != null) userItem.segmentId = segmentId;
      if (detectedLanguage) userItem.detectedLanguage = detectedLanguage;
      this.partialUserItem = null;
    } else {
      userItem = {
        id: this.nextId('user'), role: 'user', type: 'message', status: 'completed',
        createdAt: Date.now(), formatted: { transcript: text },
        ...(segmentId != null ? { segmentId } : {}),
        ...(detectedLanguage ? { detectedLanguage } : {}),
      };
      this.items.push(userItem);
    }
    this.emit(userItem);
    const liveTranslation = this.takePartialAssistantForFinal(text);
    const committedSegmentId = segmentId ?? userItem.segmentId;
    // serialize pipeline jobs so text/audio stay ordered
    this.queue = this.queue.then(() => this.runJob(
      text,
      liveTranslation.item ?? undefined,
      liveTranslation.pretranslatedSource,
      committedSegmentId,
    )).catch((e) => {
      this.emitEvent('local.native.error', 'client', { error: String(e) });
      this.handlers.onError?.(String(e));
    });
  }

  /**
   * Incremental translation is intentionally limited to Bing/Google. Local
   * LLM requests are substantially heavier and translating every growing ASR
   * hypothesis can make the final result slower rather than faster.
   */
  private schedulePartialTranslation(text: string): void {
    const modelId = this.cfg?.translationModelId;
    if (!modelId || !isNativeOnlineTranslation(modelId) || !this.connected) return;
    const normalized = text.trim();
    if (!shouldTranslateNativePartial(
      normalized, this.detectedSourceLanguage ?? this.cfg?.sourceLanguage,
    )) return;

    this.pendingPartialTranslationText = normalized;
    if (this.partialTranslationInFlight || this.partialTranslationTimer) return;

    const elapsed = performance.now() - this.partialTranslationLastStartedAt;
    const delay = Math.max(
      NATIVE_LIVE_TRANSLATION_DEBOUNCE_MS,
      NATIVE_LIVE_TRANSLATION_MIN_INTERVAL_MS - elapsed,
    );
    this.partialTranslationTimer = setTimeout(() => {
      this.partialTranslationTimer = null;
      void this.runPartialTranslation();
    }, delay);
  }

  private async runPartialTranslation(): Promise<void> {
    const modelId = this.cfg?.translationModelId;
    if (
      this.partialTranslationInFlight || !modelId ||
      !isNativeOnlineTranslation(modelId) || !this.connected
    ) return;
    const sourceText = this.pendingPartialTranslationText?.trim();
    this.pendingPartialTranslationText = null;
    if (!sourceText || sourceText === this.lastPartialTranslationText) return;

    const generation = this.partialTranslationGeneration;
    this.partialTranslationInFlight = true;
    this.partialTranslationLastStartedAt = performance.now();
    this.lastPartialTranslationText = sourceText;
    try {
      this.emitEvent('local.native.translation.partial.start', 'client', {
        sourceText, modelId,
      });
      const tr = await this.onlineTranslate.translate(
        sourceText,
        this.cfg?.instructions ?? '',
        !!this.cfg?.wrapTranscript,
      );
      if (!this.connected || generation !== this.partialTranslationGeneration) return;
      const translatedText = String(tr?.translatedText || '').trim();
      if (!translatedText) return;

      if (!this.partialAssistantItem) {
        this.partialAssistantItem = {
          id: this.nextId('asst'), role: 'assistant', type: 'message', status: 'in_progress',
          createdAt: Date.now(), formatted: { transcript: translatedText },
        };
        this.items.push(this.partialAssistantItem);
      } else {
        this.partialAssistantItem.formatted = {
          ...this.partialAssistantItem.formatted,
          transcript: translatedText,
        };
      }
      this.emit(this.partialAssistantItem);
      this.emitEvent('local.native.translation.partial.end', 'server', {
        sourceText,
        translatedText,
        inferenceTimeMs: tr?.inferenceTimeMs,
        modelId,
      });
    } catch (error) {
      // Partials are best-effort. The final utterance still uses the normal
      // translation path, which reports a persistent error to the user.
      if (this.connected && generation === this.partialTranslationGeneration) {
        console.warn('[LocalNative] Incremental online translation skipped:', error);
      }
    } finally {
      this.partialTranslationInFlight = false;
      if (this.pendingPartialTranslationText && this.connected) {
        this.schedulePartialTranslation(this.pendingPartialTranslationText);
      }
    }
  }

  private takePartialAssistantForFinal(finalText: string): {
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
    return item && partialSource === finalText.trim()
      ? { item, pretranslatedSource: partialSource }
      : { item };
  }

  private resetPartialTranslationState(): void {
    if (this.partialTranslationTimer) clearTimeout(this.partialTranslationTimer);
    this.partialTranslationTimer = null;
    this.partialTranslationGeneration += 1;
    this.partialAssistantItem = null;
    this.pendingPartialTranslationText = null;
    this.lastPartialTranslationText = '';
    this.partialTranslationInFlight = false;
    this.partialTranslationLastStartedAt = 0;
  }

  private async runJob(
    text: string,
    assistantItem?: ConversationItem,
    pretranslatedSource?: string,
    segmentId?: number,
    suppressTts = false,
    tags?: Pick<ConversationItem, 'refined' | 'refinedFor'>,
  ): Promise<void> {
    if (!this.cfg?.translationModelId) {
      // Transcription-only: the user item already carries the transcript;
      // there is no assistant stage to run.
      return;
    }
    this.emitEvent('local.native.translation.start', 'client', {
      sourceText: text, modelId: this.cfg?.translationModelId,
      systemPrompt: this.cfg?.instructions ?? '', wrapTranscript: !!this.cfg?.wrapTranscript,
    });
    // Stage-local catch so a translation failure surfaces in the Logs panel with
    // translation-stage context (which model/text), rather than only through the
    // generic queue catch. Aborts this job — no assistant item is produced.
    let tr: { sourceText?: string; translatedText: string; inferenceTimeMs?: number };
    const canReusePartial = !!assistantItem && pretranslatedSource?.trim() === text.trim()
      && !!assistantItem.formatted?.transcript?.trim();
    if (canReusePartial) {
      tr = {
        sourceText: text,
        translatedText: assistantItem!.formatted!.transcript!,
        inferenceTimeMs: 0,
      };
    } else {
      try {
        const engine = isNativeOnlineTranslation(this.cfg?.translationModelId)
          ? this.onlineTranslate
          : isOllamaTranslation(this.cfg?.translationModelId)
            ? this.ollamaTranslate
            : this.translate;
        tr = await engine.translate(text, this.cfg?.instructions ?? '', !!this.cfg?.wrapTranscript);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.emitEvent('local.native.error', 'client', { stage: 'translation', modelId: this.cfg?.translationModelId, sourceText: text, error });
        this.handlers.onError?.(error);
        return;
      }
    }
    this.emitEvent('local.native.translation.end', 'server', {
      sourceText: tr.sourceText ?? text, translatedText: tr.translatedText,
      inferenceTimeMs: tr.inferenceTimeMs, modelId: this.cfg?.translationModelId,
      ...(canReusePartial && { reusedPartial: true }),
    });
    const existingAsst = assistantItem ?? this.findItem('assistant', segmentId);
    const item: ConversationItem = existingAsst ?? {
      id: this.nextId('asst'), role: 'assistant', type: 'message', status: 'in_progress',
      createdAt: Date.now(), formatted: { transcript: tr.translatedText },
      ...(tags ?? {}),
    };
    if (segmentId != null) item.segmentId = segmentId;
    item.status = 'in_progress';
    item.formatted = { ...item.formatted, transcript: tr.translatedText };
    if (!existingAsst) this.items.push(item);
    this.emit(item);
    if (this.ttsEnabled && !suppressTts) {
      const displayText = tr.translatedText;
      // Iterate the non-empty sentences so sentenceIndex/sentenceCount are clean
      // and consistent with the per-sentence events emitted below.
      const sentences = splitSentences(displayText, this.cfg?.targetLanguage).filter((s) => s.trim());
      const sentenceCount = sentences.length;
      this.emitEvent('local.native.tts.start', 'client', {
        text: displayText, sentenceCount, modelId: this.cfg?.ttsModelId,
        voice: this.ttsVoiceLabel, speed: this.ttsSpeed,
      });
      const ttsStartTime = performance.now();
      item.formatted!.audioSegments = [];
      let searchFrom = 0;
      let cumulativeAudioDuration = 0;

      for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i];
        const pos = displayText.indexOf(sentence, searchFrom);
        const textEnd = pos >= 0 ? pos + sentence.length : searchFrom + sentence.length;
        searchFrom = textEnd;

        this.emitEvent('local.native.tts.sentence.start', 'client', {
          sentenceIndex: i, sentenceCount, text: sentence,
        });
        const sentenceStart = performance.now();

        try {
          let sentenceSamples: number;
          let generateMs: number | undefined;
          if (this.ttsStreaming) {
            // Pre-set audioTextEnd so every chunk delta already carries current karaoke
            // metadata — mirrors LocalInferenceClient streaming path (LIC line 647).
            item.formatted!.audioTextEnd = textEnd;
            let chunkSampleCount = 0;
            const done = await this.tts.generate(sentence, this.ttsSpeed, (pcm: Float32Array) => {
              const int16 = float32ToInt16(resampleFloat32(pcm, 24000, 24000));
              chunkSampleCount += int16.length;
              if (this.keepReplayAudio) this.appendItemAudio(item, int16);
              this.emit(item, { audio: int16 });
            });
            sentenceSamples = chunkSampleCount;
            generateMs = done?.generationTimeMs;
            cumulativeAudioDuration += chunkSampleCount / 24000;
            item.formatted!.audioSegments.push({ textEnd, audioEnd: cumulativeAudioDuration });
            // Bare emit (no delta) publishes finalized segment metadata to the renderer
            // — mirrors LocalInferenceClient line 687: onConversationUpdated({ item }).
            this.emit(item);
          } else {
            // Set audioTextEnd before generate so metadata is current when the audio
            // delta fires — mirrors LocalInferenceClient non-streaming path (LIC line 713).
            item.formatted!.audioTextEnd = textEnd;
            const res = await this.tts.generate(sentence, this.ttsSpeed);
            const int16 = float32ToInt16(resampleFloat32(res.samples as Float32Array, res.sampleRate, 24000));
            sentenceSamples = int16.length;
            generateMs = res.generationTimeMs;
            cumulativeAudioDuration += int16.length / 24000;
            item.formatted!.audioSegments.push({ textEnd, audioEnd: cumulativeAudioDuration });
            if (this.keepReplayAudio) this.appendItemAudio(item, int16);
            this.emit(item, { audio: int16 });
          }

          const audioDurationMs = Math.round((sentenceSamples / 24000) * 1000);
          // Prefer the sidecar's reported synth time; fall back to wall time when
          // it isn't provided so the log always carries a generateMs.
          const gm = generateMs ?? Math.round(performance.now() - sentenceStart);
          const rtf = audioDurationMs > 0 ? Math.round((gm / audioDurationMs) * 1000) / 1000 : undefined;
          this.emitEvent('local.native.tts.sentence.end', 'server', {
            sentenceIndex: i, sentenceCount, text: sentence,
            generateMs: gm, audioDurationMs, ...(rtf !== undefined && { rtf }),
          });
        } catch (ttsError) {
          // Mirror LocalInferenceClient lines 751-757: log + skip failed sentence,
          // loop continues so the item still reaches status='completed'.
          console.warn('[LocalNative] TTS failed for sentence, skipping:', ttsError);
          this.emitEvent('local.native.tts.error', 'server', {
            error: ttsError instanceof Error ? ttsError.message : String(ttsError),
            sentenceIndex: i,
          });
        }
      }

      // Ensure trailing whitespace is covered
      item.formatted!.audioTextEnd = displayText.length;
      this.emitEvent('local.native.tts.end', 'server', {
        sentenceCount, durationMs: Math.round(performance.now() - ttsStartTime),
      });
    }
    item.status = 'completed';
    this.emit(item);
  }

  appendInputAudio(audioData: Int16Array): void { if (this.connected) this.asr.feedAudio(audioData, 24000); }
  appendInputText(text: string): void { this.segmenter?.flush(); this.commitAsrText(text); }
  createResponse(_config?: ResponseConfig): void { this.asr.flush?.(); this.segmenter?.flush(); }
  cancelResponse(): void { try { this.tts?.cancel?.(); } catch (_) {} }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.partialUserItem = null;
    this.segmenter?.dispose();
    this.segmenter = null;
    this.resetPartialTranslationState();
    this.emitEvent('local.native.session.closed', 'client', { reason: 'user_disconnect' });
    this.asr.dispose?.(); this.translate.dispose?.(); this.onlineTranslate.dispose?.(); this.ollamaTranslate.dispose?.(); this.tts.dispose?.();
    this.handlers.onClose?.({});
  }
  isConnected(): boolean { return this.connected; }
  updateSession(config: Partial<SessionConfig>): void {
    if ('enableAsrRefinement' in config
        && typeof config.enableAsrRefinement === 'boolean') {
      const enabled = config.enableAsrRefinement;
      const changed = this.isAsrRefinementEnabled() !== enabled;
      this.cfg = { ...(this.cfg ?? {}), enableAsrRefinement: enabled };
      if (changed) this.asrRefinementGeneration += 1;
      void Promise.resolve(this.asr.setRefinementEnabled?.(enabled)).catch((error) => {
        // The renderer-side gate above is authoritative for display. A sidecar
        // control failure only means it may waste compute, so log it without
        // killing the active caption session.
        console.warn('[LocalNative] Failed to update ASR refinement mode:', error);
        this.emitEvent('local.native.asr.refinement.error', 'client', {
          enabled, error: error instanceof Error ? error.message : String(error),
        });
      });
      this.emitEvent('local.native.asr.refinement.updated', 'client', { enabled });
    }
    if (this.segmenter) {
      if (config.segmentationMode) {
        this.segmenter.setMode(normalizeSegmentationMode(config.segmentationMode));
      }
      if ('sourceLanguage' in config && (config as { sourceLanguage?: string }).sourceLanguage) {
        this.segmenter.setLanguage((config as { sourceLanguage?: string }).sourceLanguage);
      }
    }
  }
  reset(): void { this.items = []; this.partialUserItem = null; this.segmenter?.reset(); this.resetPartialTranslationState(); }
  getConversationItems(): ConversationItem[] { return [...this.items]; }  // fresh ref so setItems() re-renders
  clearConversationItems(): void { this.items = []; this.partialUserItem = null; this.segmenter?.reset(); this.resetPartialTranslationState(); }  // drop in-progress partials too, else the next final mutates detached items
  setEventHandlers(handlers: ClientEventHandlers): void { this.handlers = handlers; }
  getProvider(): ProviderType { return Provider.LOCAL_NATIVE; }
}
