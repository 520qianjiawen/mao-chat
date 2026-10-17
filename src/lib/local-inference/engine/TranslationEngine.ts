/**
 * TranslationEngine — Main thread wrapper for the translation Web Worker.
 * Provides a simple async API for translating text via Opus-MT.
 *
 * Model files are loaded from IndexedDB as blob URLs (same pattern as ASR/TTS).
 */

import { getTranslationModel, getManifestEntry, getManifestByType } from '../modelManifest';
import { ModelManager } from '../ModelManager';
import { isExtension } from '../../../utils/environment';
import { WorkerSession } from './WorkerSession';
import { RequestRegistry } from './RequestRegistry';
import { DeepLTranslatorClient } from '../../deepl-translator';

export interface TranslationResult {
  sourceText: string;
  translatedText: string;
  inferenceTimeMs: number;
  systemPrompt?: string;
}

export interface TranslationEngineInitOptions {
  /** Required when modelId is deepl-translator (Free or Pro API key). */
  apiKey?: string;
}

type ErrorCallback = (error: string) => void;

export class TranslationEngine {
  private session: WorkerSession | null = null;
  /** Main-thread DeepL client (needs Electron IPC / extension host perms; not a worker). */
  private deeplClient: DeepLTranslatorClient | null = null;
  private currentModelId: string | null = null;
  private sourceLang = '';
  private targetLang = '';
  private readonly reqs = new RequestRegistry<TranslationResult>();
  private requestCounter = 0;
  private bingDnrActive = false;

  onError: ErrorCallback | null = null;

  /**
   * Initialize with a language pair (e.g. 'ja', 'en').
   * Loads model files from IndexedDB and passes blob URLs to the worker.
   * Selects Opus-MT worker (pair-specific WASM) or Qwen worker (multilingual WebGPU)
   * based on the matched manifest entry.
   *
   * @param modelId - Optional specific model ID to use (from user selection).
   *                  When omitted, auto-selects via getTranslationModel() preference.
   * @param options - Optional extras (e.g. DeepL API key).
   */
  async init(
    sourceLang: string,
    targetLang: string,
    modelId?: string,
    options?: TranslationEngineInitOptions,
  ): Promise<{ loadTimeMs: number; device: string }> {
    const entry = modelId ? getManifestEntry(modelId) : getTranslationModel(sourceLang, targetLang);
    if (!entry) {
      const available = getManifestByType('translation').map(m =>
        m.multilingual ? `${m.id} (multilingual)` : `${m.sourceLang}-${m.targetLang}`
      ).join(', ');
      throw new Error(`No translation model available for language pair: ${sourceLang}-${targetLang}. Available: ${available}`);
    }
    if (!entry.isCloudModel && !entry.hfModelId) {
      throw new Error(`Translation model "${entry.id}" has no hfModelId and is not a cloud model.`);
    }
    // Use hfModelId as the cache key for local models, entry.id for cloud models.
    const modelCacheKey = entry.hfModelId ?? entry.id;
    const workerType = entry.translationWorkerType
      || (entry.multilingual ? 'qwen' : 'opus-mt');

    // DeepL: main-thread path (Electron CORS proxy + extension host permissions).
    if (workerType === 'deepl') {
      const apiKey = (options?.apiKey || '').trim();
      if (!apiKey) {
        throw new Error('DeepL API key is required. Enter your Free or Pro key in Settings.');
      }
      if (this.deeplClient && this.currentModelId === modelCacheKey
        && this.sourceLang === sourceLang && this.targetLang === targetLang) {
        return { loadTimeMs: 0, device: 'cloud' };
      }
      this.dispose();
      this.sourceLang = sourceLang;
      this.targetLang = targetLang;
      this.deeplClient = new DeepLTranslatorClient({ apiKey });
      this.currentModelId = modelCacheKey;
      return { loadTimeMs: 0, device: 'cloud' };
    }

    // If already loaded with same model and same language pair, skip
    if (this.session?.ready && this.currentModelId === modelCacheKey
      && this.sourceLang === sourceLang && this.targetLang === targetLang) {
      return { loadTimeMs: 0, device: entry.isCloudModel ? 'cloud' : (entry.requiredDevice || 'wasm') };
    }

    // Dispose previous worker if switching models
    if (this.session || this.deeplClient) {
      this.dispose();
    }

    this.sourceLang = sourceLang;
    this.targetLang = targetLang;

    // Load model file blob URLs from IndexedDB (skipped for cloud models)
    const manager = ModelManager.getInstance();
    let dtype: string | Record<string, string> | undefined;
    let fileUrls: Record<string, string> = {};
    if (!entry.isCloudModel) {
      if (!await manager.isModelReady(entry.id)) {
        throw new Error(`Translation model "${entry.id}" is not downloaded. Download it first via Model Management.`);
      }
      ({ dtype } = await manager.getModelVariantInfo(entry.id));
      fileUrls = await manager.getModelBlobUrls(entry.id);
    }

    // Legacy Bing DNR hook (no-op since Edge Cognitive path); kept for call-site order.
    if (workerType === 'bing') {
      await setBingTranslatorDNR(true);
      this.bingDnrActive = true;
    }

    const makeWorker = (): Worker => {
      switch (workerType) {
        case 'bing':
          return new Worker(
            new URL('../workers/bing-translation.worker.ts', import.meta.url),
            { type: 'module' }
          );
        case 'google':
          return new Worker(
            new URL('../workers/google-translation.worker.ts', import.meta.url),
            { type: 'module' }
          );
        case 'qwen35':
          return new Worker(
            new URL('../workers/qwen35-translation.worker.ts', import.meta.url),
            { type: 'module' }
          );
        case 'qwen':
          return new Worker(
            new URL('../workers/qwen-translation.worker.ts', import.meta.url),
            { type: 'module' }
          );
        case 'translategemma':
          return new Worker(
            new URL('../workers/translategemma-translation.worker.ts', import.meta.url),
            { type: 'module' }
          );
        case 'hy-mt':
          return new Worker(
            new URL('../workers/hy-mt-translation.worker.ts', import.meta.url),
            { type: 'module' }
          );
        default: // opus-mt
          return new Worker(
            new URL('../workers/translation.worker.ts', import.meta.url),
            { type: 'module' }
          );
      }
    };

    const session = new WorkerSession({
      makeWorker,
      revokeBlobs: () => manager.revokeBlobUrls(fileUrls),
      onFatalError: (message) => this.onError?.(message),
      onMessage: (msg) => this.route(msg),
    });
    this.session = session;

    // Send init message with blob URLs + language info + dtype from variant.
    // hfModelId / fileUrls / dtype are empty/undefined for cloud models (e.g. bing); those workers only read sourceLang/targetLang.
    const ready = await session.start({
      type: 'init',
      hfModelId: entry.hfModelId,
      fileUrls,
      sourceLang,
      targetLang,
      dtype,
      ortWasmBaseUrl: new URL('./wasm/ort/', window.location.href).href,
    });
    this.currentModelId = modelCacheKey;
    return { loadTimeMs: ready.loadTimeMs, device: ready.device || 'wasm' };
  }

  /**
   * Route non-handshake worker messages to the appropriate handler.
   * The init handshake ('ready' / pre-ready 'error') is handled by WorkerSession.
   */
  private route(msg: any): void {
    switch (msg.type) {
      case 'result':
        this.reqs.resolve(msg.id, {
          sourceText: msg.sourceText,
          translatedText: msg.translatedText,
          inferenceTimeMs: msg.inferenceTimeMs,
          systemPrompt: msg.systemPrompt,
        });
        break;

      case 'error':
        if (msg.id) {
          this.reqs.reject(msg.id, new Error(msg.error));
        } else {
          // Post-ready fatal error; pre-ready fatal error is handled by WorkerSession.
          this.onError?.(msg.error);
        }
        break;

      case 'disposed':
        break;
    }
  }

  /**
   * Translate text. Returns a Promise with the result.
   *
   * @param text              The source text to translate.
   * @param systemPrompt      Resolved system prompt. Ignored by non-LLM workers (opus-mt, translategemma).
   * @param wrapTranscript    If true, wrap user message in <transcript> tags. Ignored by non-LLM workers.
   */
  async translate(text: string, systemPrompt: string, wrapTranscript: boolean): Promise<TranslationResult> {
    if (this.deeplClient) {
      const result = await this.deeplClient.translate(text, this.sourceLang, this.targetLang);
      return {
        sourceText: text,
        translatedText: result.translatedText,
        inferenceTimeMs: result.inferenceTimeMs,
      };
    }

    if (!this.session?.ready) {
      throw new Error('TranslationEngine not initialized. Call init() first.');
    }

    const id = `tr_${++this.requestCounter}`;
    const p = this.reqs.create(id);
    this.session!.post({
      type: 'translate',
      id,
      text,
      sourceLang: this.sourceLang,
      targetLang: this.targetLang,
      systemPrompt,
      wrapTranscript,
    });
    return p;
  }

  /**
   * Get available language pairs
   */
  static getAvailableLanguagePairs(): string[] {
    const pairs: string[] = [];
    for (const m of getManifestByType('translation')) {
      if (m.multilingual) {
        pairs.push(`${m.id} (multilingual: ${m.languages.join(',')})`);
      } else {
        pairs.push(`${m.sourceLang}-${m.targetLang}`);
      }
    }
    return pairs;
  }

  /**
   * Check if a language pair is supported
   */
  static isLanguagePairSupported(sourceLang: string, targetLang: string): boolean {
    return !!getTranslationModel(sourceLang, targetLang);
  }

  get ready(): boolean {
    return (this.session?.ready ?? false) || this.deeplClient !== null;
  }

  get modelId(): string | null {
    return this.currentModelId;
  }

  dispose(): void {
    this.session?.dispose();
    this.session = null;
    this.deeplClient = null;
    if (this.bingDnrActive) {
      setBingTranslatorDNR(false);
      this.bingDnrActive = false;
    }
    this.currentModelId = null;
    this.sourceLang = '';
    this.targetLang = '';

    // Reject all pending requests
    this.reqs.rejectAll(new Error('TranslationEngine disposed'));
  }
}

/**
 * Legacy DNR hook for the old www.bing.com/ttranslatev3 scrape path.
 * Runtime now uses Edge JWT + api-edge.cognitive.microsofttranslator.com
 * (kiss-translator style), which does not need header rewriting. Kept as a
 * no-op so callers still await a settled promise without races.
 */
function setBingTranslatorDNR(_enable: boolean): Promise<void> {
  return Promise.resolve();
}
