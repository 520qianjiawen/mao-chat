import type { ConversationItem } from '../../services/interfaces/IClient';
import useSessionStore from '../../stores/sessionStore';
import { BingTranslatorClient } from '../bing-translator';
import { GoogleTranslatorClient } from '../google-translator';
import {
  eventsToCues,
  packOnscreenCrumbs,
  selectCaptionTrackOrFallback,
  shouldAppendLiveCrumb,
  visibleCuesAt,
  youtubeLangToAppLang,
  type CaptionCue,
  type CaptionTrack,
  type TimedTextEvent,
} from './youtubeCaptions';

declare const chrome: any;

export interface YouTubeCaptionStartResult {
  ok: boolean;
  reason?: string;
  trackLang?: string;
  trackName?: string;
  cueCount?: number;
  mode?: 'track' | 'live';
}

interface LoadResponse {
  ok: boolean;
  reason?: string;
  videoId?: string;
  tracks?: CaptionTrack[];
  eventsByUrl?: Record<string, TimedTextEvent[]>;
  onscreen?: string[];
  pot?: boolean;
}

interface OnscreenResponse {
  ok?: boolean;
  videoId?: string;
  currentTimeMs?: number;
  paused?: boolean;
  lines?: string[];
}

interface TimeResponse {
  ok: boolean;
  videoId?: string;
  currentTimeMs?: number;
  paused?: boolean;
}

function sendTabMessage<T>(tabId: number, message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!chrome?.tabs?.sendMessage) {
      reject(new Error('tabs API unavailable'));
      return;
    }
    chrome.tabs.sendMessage(tabId, message, (response: T) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message || 'content script unavailable'));
      else resolve(response);
    });
  });
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const probe = await sendTabMessage<{ ok?: boolean }>(tabId, { type: 'youtube-caption:probe' });
    if (probe?.ok) return;
  } catch {
    // Inject once for tabs that were open before the extension loaded.
  }
  if (!chrome?.scripting?.executeScript) {
    throw new Error('scripting API unavailable');
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['youtube-timedtext-hook.js'],
    });
  } catch {
    // Hook is optional — live on-screen captions still work without it.
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['youtube-captions.js'],
  });
}

export async function resolveYouTubeCaptureTab(): Promise<{ id: number; url?: string } | null> {
  if (typeof chrome === 'undefined' || !chrome.tabs) return null;

  const fromQuery = Number(new URLSearchParams(window.location.search).get('tabId'));
  const injected = Number((globalThis as any).__SOKUJI_SUBTITLE_TARGET_TAB_ID__);
  let tabId = Number.isInteger(fromQuery) && fromQuery > 0
    ? fromQuery
    : (Number.isInteger(injected) && injected > 0 ? injected : 0);

  // Same tab the audio capture uses. Never steal a random YouTube tab — that
  // would skip ASR on Bilibili/Netflix while a YouTube tab sits in the background.
  if (!tabId && chrome.runtime?.sendMessage) {
    try {
      const resolved = await new Promise<{ success?: boolean; tabId?: number } | undefined>((resolve) => {
        chrome.runtime.sendMessage({ type: 'RESOLVE_CAPTURE_TAB' }, (response: { success?: boolean; tabId?: number }) => {
          if (chrome.runtime.lastError) resolve(undefined);
          else resolve(response);
        });
      });
      if (resolved?.success && Number(resolved.tabId) > 0) tabId = Number(resolved.tabId);
    } catch {
      // Leave tabId at 0 and fall through.
    }
  }

  if (!tabId) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    return { id: tabId, url: tab?.url };
  } catch {
    return { id: tabId };
  }
}

interface TranscriptRow {
  cue: CaptionCue;
  translated: string;
}

export class YouTubeCaptionController {
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cues: CaptionCue[] = [];
  private lastText = '';
  private items: ConversationItem[] = [];
  private cache = new Map<string, string>();
  private transcript = new Map<number, TranscriptRow>();
  private activeStarts = new Set<number>();
  private lineStarts = new Map<string, number>();
  private mode: 'track' | 'live' = 'track';
  private lastTrackProbeAt = 0;
  private videoId: string | null = null;
  private preferredLang = 'auto';
  private targetLang = 'zh';
  private sourceLang = 'auto';
  private bing = new BingTranslatorClient();
  private google = new GoogleTranslatorClient();

  constructor(
    private readonly tabId: number,
    private readonly onItems: (items: ConversationItem[]) => void,
  ) {}

  async start(preferredLang: string, targetLang: string): Promise<YouTubeCaptionStartResult> {
    this.preferredLang = preferredLang || 'auto';
    this.targetLang = targetLang || 'zh';
    await ensureContentScript(this.tabId);
    try {
      await sendTabMessage(this.tabId, { type: 'youtube-caption:enable' });
    } catch {
      // Native CC click is best-effort.
    }
    let loaded = await this.loadTracks();
    if (!loaded.ok) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      loaded = await this.loadTracks();
    }
    if (!loaded.ok) {
      this.mode = 'live';
      this.timer = setInterval(() => {
        void this.tick();
      }, 250);
      return {
        ok: true,
        mode: 'live',
        trackLang: 'live',
        trackName: 'on-screen',
        cueCount: 0,
        reason: loaded.reason,
      };
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, 250);
    return loaded;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async loadTracks(): Promise<YouTubeCaptionStartResult> {
    const payload = await sendTabMessage<LoadResponse>(this.tabId, { type: 'youtube-caption:load' });
    if (!payload?.ok || !payload.tracks?.length) {
      return { ok: false, reason: payload?.reason || 'no-tracks' };
    }
    const track = selectCaptionTrackOrFallback(payload.tracks, this.preferredLang);
    if (!track) return { ok: false, reason: 'no-matching-language' };
    const events = payload.eventsByUrl?.[track.baseUrl] || [];
    const cues = eventsToCues(events, youtubeLangToAppLang(track.languageCode || this.preferredLang));
    if (cues.length === 0) return { ok: false, reason: 'empty-cues' };
    this.cues = cues;
    this.mode = 'track';
    this.videoId = payload.videoId || null;
    this.sourceLang = youtubeLangToAppLang(track.languageCode || this.preferredLang);
    this.lastText = '';
    this.transcript.clear();
    this.activeStarts.clear();
    this.lineStarts.clear();
    this.items = [];
    void this.prefetchFrom(0);
    return {
      ok: true,
      mode: 'track',
      trackLang: track.languageCode,
      trackName: track.name,
      cueCount: cues.length,
    };
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.mode === 'live') {
      if (Date.now() - this.lastTrackProbeAt > 2500) {
        this.lastTrackProbeAt = Date.now();
        const reloaded = await this.loadTracks();
        if (reloaded.ok && this.cues.length > 0) {
          this.mode = 'track';
        }
      }
      if (this.mode === 'live') {
        await this.tickLive();
        return;
      }
    }

    let time: TimeResponse;
    try {
      time = await sendTabMessage<TimeResponse>(this.tabId, { type: 'youtube-caption:time' });
    } catch {
      return;
    }
    if (!time?.ok) return;
    if (time.paused) return;
    if (time.videoId && this.videoId && time.videoId !== this.videoId) {
      const reloaded = await this.loadTracks();
      if (!reloaded.ok) {
        this.cues = [];
        this.mode = 'live';
        return;
      }
    }
    const nowMs = time.currentTimeMs || 0;
    const visible = visibleCuesAt(this.cues, nowMs);
    if (visible.length === 0) {
      if (this.lastText !== '') {
        this.lastText = '';
        this.activeStarts.clear();
        this.publish();
      }
      return;
    }
    const key = visible.map((cue) => `${cue.startMs}:${cue.text}`).join('|');
    if (key === this.lastText) return;
    this.lastText = key;
    const activeIndex = this.cues.findIndex((cue) => cue.startMs === visible[0].startMs);
    void this.prefetchFrom(Math.max(0, activeIndex));
    await this.emitVisible(visible);
  }

  private async tickLive(): Promise<void> {
    let shot: OnscreenResponse;
    try {
      shot = await sendTabMessage<OnscreenResponse>(this.tabId, { type: 'youtube-caption:onscreen' });
    } catch {
      return;
    }
    if (shot?.videoId && this.videoId && shot.videoId !== this.videoId) {
      this.videoId = shot.videoId;
      this.transcript.clear();
      this.lineStarts.clear();
      this.activeStarts.clear();
    } else if (shot?.videoId && !this.videoId) {
      this.videoId = shot.videoId;
    }

    if (shot?.paused) return;

    const lines = packOnscreenCrumbs(
      (shot?.lines || []).map((line) => String(line || '').replace(/\s+/g, ' ').trim()).filter(Boolean),
    );
    const nowMs = shot?.currentTimeMs || 0;
    if (lines.length === 0) {
      if (this.lastText !== '') {
        this.lastText = '';
        this.activeStarts.clear();
        this.publish();
      }
      return;
    }

    const key = lines.join('\n');
    if (key === this.lastText) return;
    this.lastText = key;

    const visible: CaptionCue[] = [];
    const rows = [...this.transcript.values()].sort((a, b) => a.cue.startMs - b.cue.startMs);
    let lastRow = rows[rows.length - 1];
    for (const line of lines) {
      if (lastRow && shouldAppendLiveCrumb(lastRow.cue.text, line, nowMs - lastRow.cue.startMs)) {
        const nextText = line.startsWith(lastRow.cue.text)
          ? line
          : `${lastRow.cue.text} ${line}`.replace(/\s+/g, ' ').trim();
        lastRow.cue = {
          startMs: lastRow.cue.startMs,
          endMs: nowMs + 2800,
          text: nextText,
        };
        lastRow.translated = this.cache.get(this.cacheKey(nextText)) || '';
        this.lineStarts.set(nextText, lastRow.cue.startMs);
        visible.push(lastRow.cue);
        continue;
      }
      let startMs = this.lineStarts.get(line);
      if (startMs == null) {
        startMs = nowMs;
        while (this.transcript.has(startMs)) startMs += 1;
        this.lineStarts.set(line, startMs);
      }
      const cue = { startMs, endMs: startMs + 2800, text: line };
      visible.push(cue);
      lastRow = this.transcript.get(startMs) || { cue, translated: '' };
    }
    const keep = new Set(visible.map((cue) => cue.text));
    for (const [text] of [...this.lineStarts.entries()]) {
      if (!keep.has(text)) this.lineStarts.delete(text);
    }
    await this.emitVisible(visible);
  }

  private publish(): void {
    const rows = [...this.transcript.values()].sort((a, b) => a.cue.startMs - b.cue.startMs);
    this.items = rows.flatMap(({ cue, translated }) => {
      const active = this.activeStarts.has(cue.startMs);
      return [
        {
          id: `yt_src_${cue.startMs}`,
          role: 'user',
          type: 'message',
          status: 'completed',
          source: 'participant',
          createdAt: cue.startMs,
          detectedLanguage: this.sourceLang,
          active,
          formatted: { text: cue.text, transcript: cue.text },
        },
        {
          id: `yt_tr_${cue.startMs}`,
          role: 'assistant',
          type: 'message',
          status: translated ? 'completed' : 'in_progress',
          source: 'participant',
          createdAt: cue.startMs + 1,
          active,
          formatted: { text: translated || '', transcript: translated || '' },
        },
      ] as ConversationItem[];
    });
    this.onItems([...this.items]);
  }

  private async emitVisible(cues: CaptionCue[]): Promise<void> {
    this.activeStarts = new Set(cues.map((cue) => cue.startMs));
    for (const cue of cues) {
      const cached = this.cache.get(this.cacheKey(cue.text)) || '';
      const existing = this.transcript.get(cue.startMs);
      if (existing) {
        existing.cue = cue;
        if (cached) existing.translated = cached;
      } else {
        this.transcript.set(cue.startMs, { cue, translated: cached });
      }
    }
    this.publish();

    await Promise.all(cues.map(async (cue) => {
      const translated = await this.translate(cue.text);
      const row = this.transcript.get(cue.startMs);
      if (!row || this.stopped) return;
      row.translated = translated;
    }));
    if (this.stopped) return;
    this.publish();
    useSessionStore.getState().incrementTranslationCount();
  }

  private cacheKey(text: string): string {
    return `${this.sourceLang}|${this.targetLang}|${text}`;
  }

  private prefetchFrom(index: number): void {
    for (const cue of this.cues.slice(index, index + 4)) {
      if (!this.cache.has(this.cacheKey(cue.text))) void this.translate(cue.text);
    }
  }

  private async translate(text: string): Promise<string> {
    const cacheKey = this.cacheKey(text);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const from = this.sourceLang === 'auto' ? 'auto' : this.sourceLang;
    try {
      const result = await this.bing.translate(text, from, this.targetLang);
      if (result.translatedText?.trim()) {
        this.cache.set(cacheKey, result.translatedText);
        return result.translatedText;
      }
    } catch {
      // Fall through to Google.
    }
    try {
      const result = await this.google.translate(text, from, this.targetLang);
      if (result.translatedText?.trim()) {
        this.cache.set(cacheKey, result.translatedText);
        return result.translatedText;
      }
    } catch {
      // Keep the source line rather than failing the cue.
    }
    return text;
  }
}
