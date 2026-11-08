// src/services/clients/AntLingClient.ts
import {
  IClient,
  ConversationItem,
  SessionConfig,
  ClientEventHandlers,
  ResponseConfig,
} from '../interfaces/IClient';
import { Provider, ProviderType } from '../../types/Provider';
import { encodeMonoPcm16Wav } from '../../utils/ttsAudioExport';

export interface AntLingSessionConfig extends SessionConfig {
  apiKey: string;
  apiHost?: string;
  asrModel?: string;
  chatModel?: string;
  ttsModel?: string;
  voice?: string;
  temperature?: number;
  sourceLanguage?: string;
  targetLanguage?: string;
  turnDetectionMode?: 'Auto' | 'Push-to-Talk' | 'Push-to-Translate';
  channelSource?: 'speaker' | 'participant';
}

export class AntLingClient implements IClient {
  private apiKey: string;
  private apiHost: string;
  private asrModel: string = 'Ming-3.0-asr-tiny';
  private chatModel: string = 'Ling-3.1-flash';
  private ttsModel: string = 'Ming-3.0-tts-0.5B';
  private voice: string = '灵小雅';
  private sourceLanguage: string = 'auto';
  private targetLanguage: string = 'zh';
  private turnDetectionMode: 'Auto' | 'Push-to-Talk' | 'Push-to-Translate' = 'Auto';
  private channelSource: 'speaker' | 'participant' = 'speaker';
  private textOnly: boolean = false;
  private connected: boolean = false;

  private eventHandlers: ClientEventHandlers = {};
  private conversationItems: ConversationItem[] = [];

  // Audio chunk buffer for VAD
  private speechBuffer: Int16Array[] = [];
  private totalBufferedSamples = 0;
  private silentChunkCount = 0;
  private activeConsecutiveChunks = 0;
  private isSpeaking = false;
  private processingQueue: Promise<void> = Promise.resolve();

  private readonly SAMPLE_RATE = 24000;
  // ~420 RMS energy threshold for speech detection (filters room hum, distant noise)
  private readonly RMS_THRESHOLD = 420;
  // 12 chunks (~1.2s) of silence after speech ends to commit turn (avoids fragmenting natural pauses)
  private readonly SILENCE_CHUNKS_THRESHOLD = 12;
  // Max ~10 seconds of continuous speech before committing turn (allows full complete sentences)
  private readonly MAX_SPEECH_SAMPLES = 24000 * 10;

  constructor(apiKey: string, apiHost: string = 'https://api.ant-ling.com/v1') {
    this.apiKey = apiKey.trim();
    this.apiHost = apiHost.trim().replace(/\/+$/, '');
    if (this.apiHost.endsWith('/v1')) {
      // keep apiHost without trailing slash
    } else {
      this.apiHost = `${this.apiHost}/v1`;
    }
  }

  async connect(config: SessionConfig): Promise<void> {
    const antConfig = config as AntLingSessionConfig;
    this.asrModel = antConfig.asrModel || 'Ming-3.0-asr-tiny';
    this.chatModel = antConfig.chatModel || 'Ling-3.1-flash';
    this.ttsModel = antConfig.ttsModel || 'Ming-3.0-tts-0.5B';
    this.voice = antConfig.voice || '灵小雅';
    this.sourceLanguage = antConfig.sourceLanguage || 'auto';
    this.targetLanguage = antConfig.targetLanguage || 'zh';
    this.turnDetectionMode = antConfig.turnDetectionMode || 'Auto';
    this.textOnly = Boolean(antConfig.textOnly);

    this.connected = true;
    this.conversationItems = [];
    this.speechBuffer = [];
    this.totalBufferedSamples = 0;
    this.silentChunkCount = 0;
    this.activeConsecutiveChunks = 0;
    this.isSpeaking = false;

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({ type: 'ANT_LING_ENSURE_HEADERS' }, () => {});
      } catch {}
    }

    this.eventHandlers.onRealtimeEvent?.({
      source: 'client',
      event: {
        type: 'session.opened',
        data: {
          provider: 'ant_ling',
          asrModel: this.asrModel,
          chatModel: this.chatModel,
          ttsModel: this.ttsModel,
          timestamp: Date.now(),
        },
      },
    });

    this.eventHandlers.onOpen?.();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.flushSpeechBuffer();
    this.eventHandlers.onRealtimeEvent?.({
      source: 'client',
      event: {
        type: 'session.closed',
        data: {
          provider: 'ant_ling',
          timestamp: Date.now(),
        },
      },
    });
    this.eventHandlers.onClose?.({});
  }

  isConnected(): boolean {
    return this.connected;
  }

  updateSession(config: Partial<SessionConfig>): void {
    const antConfig = config as Partial<AntLingSessionConfig>;
    if (antConfig.asrModel) this.asrModel = antConfig.asrModel;
    if (antConfig.chatModel) this.chatModel = antConfig.chatModel;
    if (antConfig.ttsModel) this.ttsModel = antConfig.ttsModel;
    if (antConfig.voice) this.voice = antConfig.voice;
    if (antConfig.sourceLanguage) this.sourceLanguage = antConfig.sourceLanguage;
    if (antConfig.targetLanguage) this.targetLanguage = antConfig.targetLanguage;
    if (antConfig.turnDetectionMode) this.turnDetectionMode = antConfig.turnDetectionMode;
    if (antConfig.channelSource) this.channelSource = antConfig.channelSource;
    if (typeof antConfig.textOnly === 'boolean') this.textOnly = antConfig.textOnly;
  }

  reset(): void {
    this.conversationItems = [];
    this.speechBuffer = [];
    this.totalBufferedSamples = 0;
    this.silentChunkCount = 0;
    this.activeConsecutiveChunks = 0;
    this.isSpeaking = false;
  }

  appendInputAudio(audioData: Int16Array): void {
    if (!this.connected || audioData.length === 0) return;

    // 1. In Push-to-Talk mode: the user holds the key to talk, so buffer all audio during hold
    if (this.turnDetectionMode === 'Push-to-Talk') {
      this.isSpeaking = true;
      this.speechBuffer.push(audioData);
      this.totalBufferedSamples += audioData.length;
      return;
    }

    // 2. In Auto mode: energy RMS threshold with 2-chunk debouncing to filter room noise / breaths
    let sumSquares = 0;
    for (let i = 0; i < audioData.length; i++) {
      sumSquares += audioData[i] * audioData[i];
    }
    const rms = Math.sqrt(sumSquares / audioData.length);

    if (rms > this.RMS_THRESHOLD) {
      this.activeConsecutiveChunks++;
      if (this.activeConsecutiveChunks >= 2 || this.isSpeaking) {
        this.isSpeaking = true;
        this.silentChunkCount = 0;
        this.speechBuffer.push(audioData);
        this.totalBufferedSamples += audioData.length;

        // Force flush if speech is too long
        if (this.totalBufferedSamples >= this.MAX_SPEECH_SAMPLES) {
          this.flushSpeechBuffer();
        }
      }
    } else {
      this.activeConsecutiveChunks = 0;
      if (this.isSpeaking) {
        this.speechBuffer.push(audioData);
        this.totalBufferedSamples += audioData.length;
        this.silentChunkCount++;

        if (this.silentChunkCount >= this.SILENCE_CHUNKS_THRESHOLD) {
          this.flushSpeechBuffer();
        }
      }
    }
  }

  appendInputText(text: string): void {
    if (!this.connected || !text.trim()) return;
    this.enqueueTurn(text.trim());
  }

  createResponse(_config?: ResponseConfig): void {
    this.flushSpeechBuffer();
  }

  cancelResponse(_trackId?: string, _offset?: number): void {
    // No-op for pipeline
  }

  getConversationItems(): ConversationItem[] {
    return [...this.conversationItems];
  }

  clearConversationItems(): void {
    this.conversationItems = [];
  }

  setEventHandlers(handlers: ClientEventHandlers): void {
    this.eventHandlers = handlers;
  }

  getProvider(): ProviderType {
    return Provider.ANT_LING;
  }

  // ─── Pipeline Processing ───────────────────────────────────

  private flushSpeechBuffer(): void {
    if (this.speechBuffer.length === 0) return;

    // In PTT mode: allow turns down to 0.2s so short words ("好", "对") are captured
    const minSamples = this.turnDetectionMode === 'Push-to-Talk'
      ? this.SAMPLE_RATE * 0.2
      : this.SAMPLE_RATE * 0.35;

    if (this.totalBufferedSamples >= minSamples) {
      const chunksToProcess = this.speechBuffer;
      this.speechBuffer = [];
      this.totalBufferedSamples = 0;
      this.silentChunkCount = 0;
      this.activeConsecutiveChunks = 0;
      this.isSpeaking = false;

      this.enqueueAudioTurn(chunksToProcess);
    } else {
      this.speechBuffer = [];
      this.totalBufferedSamples = 0;
      this.silentChunkCount = 0;
      this.activeConsecutiveChunks = 0;
      this.isSpeaking = false;
    }
  }

  private enqueueAudioTurn(chunks: Int16Array[]): void {
    this.processingQueue = this.processingQueue
      .then(() => this.processAudioTurn(chunks))
      .catch((err) => {
        console.error('[AntLingClient] Audio processing error:', err);
      });
  }

  private enqueueTurn(text: string): void {
    this.processingQueue = this.processingQueue
      .then(() => this.processTextTurn(text))
      .catch((err) => {
        console.error('[AntLingClient] Text processing error:', err);
      });
  }

  private cleanAsrText(text: string): string {
    if (!text) return '';
    const cleaned = text
      .replace(/<questionmark>/gi, '?')
      .replace(/<period>/gi, '.')
      .replace(/<comma>/gi, ',')
      .replace(/<exclamation>/gi, '!')
      .replace(/<colon>/gi, ':')
      .replace(/<semicolon>/gi, ';')
      .replace(/<[a-zA-Z0-9_\-]+>/g, '') // remove any speech or event tags
      .replace(/\s+([.,?!:;])/g, '$1') // remove whitespace before punctuation
      .replace(/\s{2,}/g, ' ')
      .trim();

    // In auto mode, filter out ambient noise & silence hallucinations (e.g. "啊。", "二。", "Yeah.", "No.", "I should.")
    if (this.turnDetectionMode === 'Auto') {
      const stripped = cleaned.replace(/[。，！？.?!, \n\r]/g, '').toLowerCase();
      const hallucinations = [
        '啊', '呃', '额', '嗯', '哦', '二',
        'yeah', 'yes', 'no', 'ishould', 'ishouldishould', 'thankyou', 'thanks', 'you', 'ok', 'okay', 'bye', 'hello', 'sure'
      ];
      if (hallucinations.includes(stripped)) {
        return '';
      }
    }
    return cleaned;
  }

  private async processAudioTurn(chunks: Int16Array[]): Promise<void> {
    if (!this.connected) return;

    // 1. Encode PCM to WAV
    const wavBuffer = encodeMonoPcm16Wav(chunks, this.SAMPLE_RATE);
    const audioBlob = new Blob([wavBuffer], { type: 'audio/wav' });

    // 2. Transcribe via Ant-Ling ASR
    const turnId = `ant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const userItem: ConversationItem = {
      id: turnId,
      role: 'user',
      source: this.channelSource,
      status: 'in_progress',
      createdAt: Date.now(),
      formatted: { transcript: '正在识别...' },
    };
    this.conversationItems.push(userItem);
    this.eventHandlers.onConversationUpdated?.({ item: userItem });

    let recognizedText = '';
    try {
      const form = new FormData();
      form.append('file', audioBlob, 'speech.wav');
      form.append('model', this.asrModel);
      if (this.sourceLanguage && this.sourceLanguage !== 'auto') {
        form.append('language', this.sourceLanguage);
      }

      const asrRes = await fetch(`${this.apiHost}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: form,
      });

      if (!asrRes.ok) {
        throw new Error(`ASR request failed with status ${asrRes.status}`);
      }

      const asrData = await asrRes.json();
      recognizedText = this.cleanAsrText(asrData.text || '');
    } catch (e: any) {
      console.warn('[AntLingClient] ASR failed:', e);
      // Remove placeholder if failed
      this.conversationItems = this.conversationItems.filter((it) => it.id !== turnId);
      return;
    }

    if (!recognizedText) {
      this.conversationItems = this.conversationItems.filter((it) => it.id !== turnId);
      return;
    }

    // Update userItem with final transcript
    userItem.status = 'completed';
    userItem.formatted = {
      transcript: recognizedText,
      text: recognizedText,
    };
    this.eventHandlers.onConversationUpdated?.({ item: userItem });

    // 3. Translate recognized speech
    await this.translateAndSpeak(userItem, recognizedText);
  }

  private async processTextTurn(text: string): Promise<void> {
    if (!this.connected) return;

    const turnId = `ant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const userItem: ConversationItem = {
      id: turnId,
      role: 'user',
      status: 'completed',
      createdAt: Date.now(),
      formatted: { transcript: text, text },
    };
    this.conversationItems.push(userItem);
    this.eventHandlers.onConversationUpdated?.({ item: userItem });

    await this.translateAndSpeak(userItem, text);
  }

  private async translateAndSpeak(userItem: ConversationItem, sourceText: string): Promise<void> {
    const assistantId = `ant-asst-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const assistantItem: ConversationItem = {
      id: assistantId,
      role: 'assistant',
      source: this.channelSource,
      status: 'in_progress',
      createdAt: Date.now(),
      formatted: { text: '正在翻译...' },
    };
    this.conversationItems.push(assistantItem);
    this.eventHandlers.onConversationUpdated?.({ item: assistantItem });

    const targetLang = this.targetLanguage === 'zh'
      ? 'Simplified Chinese (简体中文)'
      : (this.targetLanguage === 'en' ? 'English' : this.targetLanguage);

    let translatedText = '';
    try {
      const chatRes = await fetch(`${this.apiHost}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.chatModel,
          messages: [
            {
              role: 'system',
              content: `You are an accurate, real-time simultaneous interpreter. Translate the speech into ${targetLang}. Output ONLY the translated result without any commentary, explanation, or quotes.`,
            },
            {
              role: 'user',
              content: sourceText,
            },
          ],
          temperature: 0.2,
        }),
      });

      if (!chatRes.ok) {
        throw new Error(`Chat translation failed with status ${chatRes.status}`);
      }

      const chatData = await chatRes.json();
      translatedText = (chatData.choices?.[0]?.message?.content || '').trim();
    } catch (e: any) {
      console.warn('[AntLingClient] Translation failed:', e);
      translatedText = sourceText; // fallback
    }

    assistantItem.status = 'completed';
    assistantItem.formatted = { text: translatedText };
    this.eventHandlers.onConversationUpdated?.({ item: assistantItem });

    // 4. Synthesize voice if TTS is not disabled
    if (!this.textOnly && translatedText) {
      try {
        const speechRes = await fetch(`${this.apiHost}/audio/speech`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.ttsModel,
            input: translatedText,
            voice: this.voice,
          }),
        });

        if (speechRes.ok) {
          const wavArrayBuffer = await speechRes.arrayBuffer();
          // WAV header is 44 bytes; remaining bytes are 16-bit PCM samples
          if (wavArrayBuffer.byteLength > 44) {
            const pcmSamples = new Int16Array(wavArrayBuffer.slice(44));
            this.eventHandlers.onConversationUpdated?.({
              item: assistantItem,
              delta: { audio: pcmSamples },
            });
          }
        }
      } catch (ttsError) {
        console.warn('[AntLingClient] TTS synthesis error:', ttsError);
      }
    }
  }
}
