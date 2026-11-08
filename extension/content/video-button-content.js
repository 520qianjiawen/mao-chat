/* global chrome */
/**
 * MAO Chat In-Video Bilingual Subtitles & Launcher Button
 * (Logic reference: fishjar/kiss-translator, UI: MAO Chat design)
 *
 * Capabilities:
 *  1. In-Video Embedded Subtitle Container:
 *     - Mounted directly inside video player containers (YouTube #movie_player, X/Twitter videoComponent, etc.).
 *     - Displays real-time bilingual or monolingual subtitles with sleek dark glassmorphism styling.
 *     - Auto-adjusts bottom offset to float above controls when visible and drop down when hidden.
 *  2. Interactive Pill Launcher:
 *     - Split pill design: [ 🐱 ▾ | ● MAO 字幕 ]
 *     - Clicking [ 🐱 ▾ ] pops up the Quick Settings Popover Menu:
 *         * Subtitle Display Mode: [ 双语字幕 ] | [ 仅译文 ] | [ 仅原文 ]
 *         * Translation Engine: Google 翻译 | 微软 Bing 翻译 (LLM增强) | DeepL 翻译
 *         * Target Language: 中文 (简体/繁体)、英语、日语、韩语、西班牙语、法语等
 *     - Clicking [ ● MAO 字幕 ] directly toggles subtitles ON / OFF without opening the side panel!
 *  3. Subtitle Acquisition & Synchronization:
 *     - YouTube TimedText + on-screen caption fallback.
 *     - Twitter / X native CC observer + auto-activation.
 *     - In-memory translation caching & pre-translation.
 */
(function () {
  if (window.__maoVideoSubtitlesLoaded__) return;
  window.__maoVideoSubtitlesLoaded__ = true;

  // Global subtitle state
  let isSubtitlesActive = false;
  let isAsrActive = false;
  let isAsrEnabled = true;              // Auto-link ASR for videos without native subtitles
  let currentDisplayMode = 'bilingual'; // 'bilingual' | 'target_only' | 'source_only'
  let currentEngine = 'google';         // 'google' | 'bing' | 'deepl'
  const defaultSourceLang = window.location.hostname.includes('jable') ? 'ja' : 'auto';
  let currentSourceLang = defaultSourceLang; // 'auto' | 'ja' | 'en' | 'zh' | 'ko' | ...
  let currentTargetLang = 'zh-CN';      // 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko' | ...
  let currentFontSize = 'medium';       // 'small' | 'medium' | 'large'

  const activeButtons = new Set();
  const activeVideoManagers = new Map(); // videoEl -> InVideoSubtitleManager
  const translationCache = new Map();
  const inFlightTranslations = new Map();

  // Load persisted user preferences
  try {
    chrome.storage.local.get(['mao_sub_display_mode', 'mao_sub_engine', 'mao_sub_source_lang', 'mao_sub_target_lang', 'mao_sub_font_size', 'mao_sub_asr_enabled'], (res) => {
      if (res) {
        if (res.mao_sub_display_mode) currentDisplayMode = res.mao_sub_display_mode;
        if (res.mao_sub_engine) currentEngine = res.mao_sub_engine;
        if (res.mao_sub_source_lang) currentSourceLang = res.mao_sub_source_lang;
        if (res.mao_sub_target_lang) currentTargetLang = res.mao_sub_target_lang;
        if (res.mao_sub_font_size) currentFontSize = res.mao_sub_font_size;
        if (typeof res.mao_sub_asr_enabled === 'boolean') isAsrEnabled = res.mao_sub_asr_enabled;
      }
      updateAllPopoversUI();
      updateAllSubtitleStyles();
    });
  } catch { /* ignore */ }

  // SVG Icons
  const MAO_CAT_SVG = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 10L6 4L9 8H15L18 4L21 10C21.6 12 21.6 15 20 18C18.5 20.5 15.5 21 12 21C8.5 21 5.5 20.5 4 18C2.4 15 2.4 12 3 10Z"/>
      <circle cx="9" cy="13" r="1.2" fill="currentColor"/>
      <circle cx="15" cy="13" r="1.2" fill="currentColor"/>
      <path d="M10.5 16.5C11.2 17.2 12.8 17.2 13.5 16.5" stroke-width="1.5"/>
    </svg>
  `;

  const YTP_CAT_SVG = `
    <svg width="100%" height="100%" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M7 15L11 6L15 12H21L25 6L29 15C29.8 18 29.8 22.5 27.5 26.2C25.2 30 20.7 30.7 15.5 30.7C10.2 30.7 5.7 30 3.5 26.2C1.2 22.5 1.2 18 2 15L7 15Z" stroke="#ffffff" stroke-width="2.2" stroke-linejoin="round"/>
      <circle cx="11" cy="19.5" r="1.8" fill="#ffffff"/>
      <circle cx="20" cy="19.5" r="1.8" fill="#ffffff"/>
      <path d="M13.5 24.5C14.5 25.5 16.5 25.5 17.5 24.5" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `;

  // Translation helper via background multi-engine service
  async function translateText(text, targetLang = currentTargetLang, engine = currentEngine, sourceLang = currentSourceLang) {
    const raw = (text || '').trim();
    if (!raw) return '';
    const from = sourceLang === 'auto' ? 'auto' : sourceLang;
    const cacheKey = `${engine}:${from}:${targetLang}:${raw.toLowerCase()}`;
    if (translationCache.has(cacheKey)) {
      return translationCache.get(cacheKey);
    }
    if (inFlightTranslations.has(cacheKey)) {
      return inFlightTranslations.get(cacheKey);
    }

    const p = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(raw), 4500);
      try {
        chrome.runtime.sendMessage(
          { type: 'TRANSLATE_TEXT', text: raw, from, to: targetLang, engine: engine },
          (res) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              resolve(raw);
              return;
            }
            if (res && res.success && res.translatedText) {
              translationCache.set(cacheKey, res.translatedText);
              resolve(res.translatedText);
            } else {
              resolve(raw);
            }
          }
        );
      } catch {
        clearTimeout(timer);
        resolve(raw);
      }
    }).finally(() => {
      inFlightTranslations.delete(cacheKey);
    });

    inFlightTranslations.set(cacheKey, p);
    return p;
  }

  // Toggle hiding native CC (YouTube/Twitter/HTML5 video::cue) so they don't overlap with MAO subtitles
  const NATIVE_CAPTION_STYLE_ID = 'mao-hide-native-captions-style';
  function setNativeCaptionsVisibility(hidden) {
    let styleEl = document.getElementById(NATIVE_CAPTION_STYLE_ID);
    if (hidden) {
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = NATIVE_CAPTION_STYLE_ID;
        styleEl.textContent = `
          /* Hide HTML5 browser native VTTCue tracks */
          video::cue {
            opacity: 0 !important;
            visibility: hidden !important;
            font-size: 0px !important;
            color: transparent !important;
            background: transparent !important;
          }
          /* YouTube native captions */
          .ytp-caption-segment,
          .ytp-caption-window-bottom,
          .ytp-caption-window-rollup {
            opacity: 0 !important;
            visibility: hidden !important;
          }
          /* Twitter / X native captions */
          [data-testid="videoComponent"] span[style*="background"],
          [data-testid="videoComponent"] div[dir="auto"] span,
          [data-testid="videoPlayer"] span[style*="background"],
          [data-testid="videoPlayer"] div[dir="auto"] span {
            opacity: 0 !important;
            visibility: hidden !important;
          }
        `;
        (document.head || document.documentElement).appendChild(styleEl);
      }
    } else {
      styleEl?.remove();
    }
  }

  // Filters out player controls, tooltips, time, and badges
  function isIgnoredCaptionText(text) {
    if (!text || typeof text !== 'string') return true;
    const t = text.trim();
    if (t.length === 0) return true;
    // Pure numbers, view counts, ratings e.g. "234 854 428", "12,345", "99%"
    if (/^[\d\s,.\-+%]+$/.test(t)) return true;
    // Time indicators e.g. "0:05", "0:05 / 0:11"
    if (/^\d{1,2}:\d{2}/.test(t)) return true;
    // Common media badges & resolutions
    if (/^(LIVE|CC|HD|4K|1080p|720p|AD)$/i.test(t)) return true;
    // Tooltips and player control labels (Chinese)
    if (/隐藏字幕|显示字幕|开启字幕|关闭字幕|静音|取消静音|播放|暂停|全屏|退出全屏|播放速度|自动播放|画中画|次观看|播放量|浏览|点赞/i.test(t)) return true;
    // Tooltips and player control labels (English)
    if (/hide captions?|show captions?|closed captions?|toggle captions?|mute|unmute|play|pause|fullscreen|playback speed|auto-?play|picture in picture|views?|plays?|likes?/i.test(t)) return true;
    return false;
  }

  // Normalizes subtitle text by removing unwanted linebreaks and extra spaces
  function normalizeSubtitleText(text) {
    if (!text || typeof text !== 'string') return '';
    let cleaned = text
      // Remove thoughts / think tags if any
      .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .trim();

    // Guard against Gemini internal thinking process leaked into subtitle
    if (cleaned.startsWith('**') && (cleaned.includes("I'm working on") || cleaned.includes("translating") || cleaned.includes("Translating"))) {
      return '';
    }
    if (/^I'm working on translating/i.test(cleaned)) {
      return '';
    }

    return cleaned
      .replace(/\r\n/g, '\n')
      // Remove linebreaks between CJK characters from ASR/LLM output
      .replace(/([\u3000-\u9fff\uac00-\ud7af])\n+([\u3000-\u9fff\uac00-\ud7af])/gu, '$1$2')
      // Replace remaining linebreaks with a space
      .replace(/\n+/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  // Auto-enable Twitter closed captions if available
  function enableTwitterCaptions(container) {
    if (!container) return;
    const ccBtn = container.querySelector(
      'button[aria-label*="caption" i], button[aria-label*="Caption" i], button[aria-label*="字幕"], [data-testid="closedCaptionsButton"]'
    );
    if (!ccBtn) return;
    const pressed = ccBtn.getAttribute('aria-pressed');
    const label = ccBtn.getAttribute('aria-label') || '';
    // If it is already active/showing, do not click (clicking would turn it off)
    if (pressed === 'true' || label.includes('隐藏') || label.includes('Hide') || label.includes('Disable')) {
      return;
    }
    try {
      ccBtn.click();
      // Remove focus immediately so Twitter's focus tooltip disappears
      setTimeout(() => {
        try { ccBtn.blur(); } catch {}
      }, 50);
    } catch { /* ignore */ }
  }

  // --- SubtitleManager Class ---
  class InVideoSubtitleManager {
    constructor(videoEl, container) {
      this.videoEl = videoEl;
      this.container = container;
      this.formattedSubtitles = []; // { start, end, text, translation, isTranslating }
      this.currentIndex = -1;
      this.lastExternalText = '';
      this.containerEl = null;
      this.paperEl = null;
      this.transEl = null;
      this.origEl = null;
      this.isYouTube = container.id === 'movie_player' || container.classList.contains('html5-video-player');
      this.isTwitter = Boolean(container.closest('[data-testid="videoComponent"], [data-testid="videoPlayer"], article[data-testid="tweet"]'));

      this.onTimeUpdate = this.onTimeUpdate.bind(this);
      this.onSeeked = this.onSeeked.bind(this);
      this.onSeeking = this.onSeeking.bind(this);

      this.createSubtitleElements();
      this.attachVideoListeners();
      this.loadVideoCaptions();
    }

    createSubtitleElements() {
      if (this.container.querySelector(':scope > .mao-in-video-caption-container')) {
        return;
      }

      // Outer container
      const containerEl = document.createElement('div');
      containerEl.className = 'mao-in-video-caption-container notranslate';
      containerEl.style.cssText = [
        'position: absolute',
        'inset: 0',
        'width: 100%',
        'height: 100%',
        'pointer-events: none',
        'overflow: hidden',
        'z-index: 2147483642',
      ].join(' !important;') + ' !important;';

      // Paper (floats at bottom center)
      const paperEl = document.createElement('div');
      paperEl.className = 'mao-in-video-caption-paper';
      paperEl.style.cssText = [
        'position: absolute',
        'left: 50%',
        'transform: translateX(-50%)',
        'width: max-content',
        'max-width: 90%',
        'bottom: 18px',
        'text-align: center',
        'display: none',
        'flex-direction: column',
        'align-items: center',
        'justify-content: flex-end',
        'pointer-events: none',
        'transition: bottom 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease',
        'user-select: none',
        '-webkit-user-select: none',
      ].join(' !important;') + ' !important;';

      // Inner Window
      const windowEl = document.createElement('div');
      windowEl.className = 'mao-in-video-caption-window';
      windowEl.style.cssText = [
        'display: inline-flex',
        'flex-direction: column',
        'align-items: center',
        'justify-content: center',
        'pointer-events: none',
        'width: max-content',
        'max-width: 100%',
      ].join(' !important;') + ' !important;';

      // Original text (top, secondary)
      const origEl = document.createElement('div');
      origEl.className = 'mao-sub-orig';
      origEl.style.cssText = [
        'margin: 0 0 4px 0',
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        'font-size: clamp(10px, 1.1vw, 12px)',
        'font-weight: 400',
        'line-height: 1.35',
        'color: rgba(255, 255, 255, 0.88)',
        'background: rgba(14, 12, 22, 0.78)',
        'backdrop-filter: blur(8px)',
        '-webkit-backdrop-filter: blur(8px)',
        'border-radius: 4px',
        'padding: 3px 10px',
        'text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95)',
        'display: none',
        'width: max-content',
        'max-width: 100%',
        'box-sizing: border-box',
        'white-space: normal',
        'word-break: break-word',
        'overflow-wrap: break-word',
        'line-break: loose',
        'text-align: center',
      ].join(' !important;') + ' !important;';

      // Translated text (bottom, prominent)
      const transEl = document.createElement('div');
      transEl.className = 'mao-sub-trans';
      transEl.style.cssText = [
        'margin: 0',
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        'font-size: clamp(12px, 1.4vw, 15px)',
        'font-weight: 500',
        'line-height: 1.35',
        'color: #ffffff',
        'background: rgba(18, 14, 26, 0.88)',
        'backdrop-filter: blur(10px)',
        '-webkit-backdrop-filter: blur(10px)',
        'border: 1px solid rgba(255, 255, 255, 0.15)',
        'box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45)',
        'padding: 5px 14px',
        'border-radius: 6px',
        'text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9)',
        'letter-spacing: 0.2px',
        'display: none',
        'width: max-content',
        'max-width: 100%',
        'box-sizing: border-box',
        'white-space: normal',
        'word-break: break-word',
        'overflow-wrap: break-word',
        'line-break: loose',
        'text-align: center',
      ].join(' !important;') + ' !important;';

      windowEl.appendChild(origEl);
      windowEl.appendChild(transEl);
      paperEl.appendChild(windowEl);
      containerEl.appendChild(paperEl);

      this.container.appendChild(containerEl);
      this.containerEl = containerEl;
      this.paperEl = paperEl;
      this.origEl = origEl;
      this.transEl = transEl;

      this.applySubtitleStyles();
      this.setupControlBarAvoidance();
    }

    applySubtitleStyles() {
      if (!this.origEl || !this.transEl) return;
      if (currentFontSize === 'small') {
        this.origEl.style.setProperty('font-size', 'clamp(9px, 1.0vw, 11px)', 'important');
        this.origEl.style.setProperty('padding', '2px 6px', 'important');
        this.transEl.style.setProperty('font-size', 'clamp(11px, 1.2vw, 13px)', 'important');
        this.transEl.style.setProperty('padding', '3px 10px', 'important');
      } else if (currentFontSize === 'large') {
        this.origEl.style.setProperty('font-size', 'clamp(11px, 1.3vw, 13px)', 'important');
        this.origEl.style.setProperty('padding', '3px 10px', 'important');
        this.transEl.style.setProperty('font-size', 'clamp(14px, 1.8vw, 18px)', 'important');
        this.transEl.style.setProperty('padding', '5px 14px', 'important');
      } else {
        // 'medium' (standard sleek default)
        this.origEl.style.setProperty('font-size', 'clamp(10px, 1.1vw, 12px)', 'important');
        this.origEl.style.setProperty('padding', '2px 8px', 'important');
        this.transEl.style.setProperty('font-size', 'clamp(12px, 1.4vw, 15px)', 'important');
        this.transEl.style.setProperty('padding', '4px 12px', 'important');
      }
    }

    setupControlBarAvoidance() {
      if (this.isYouTube) {
        const updateOffset = () => {
          if (!this.paperEl) return;
          const isAutohide = this.container.classList.contains('ytp-autohide');
          this.paperEl.style.setProperty('bottom', isAutohide ? '18px' : '56px', 'important');
        };
        const obs = new MutationObserver(updateOffset);
        obs.observe(this.container, { attributes: true, attributeFilter: ['class'] });
        updateOffset();
      } else {
        const onEnter = () => {
          if (this.paperEl) this.paperEl.style.setProperty('bottom', '36px', 'important');
        };
        const onLeave = () => {
          if (this.paperEl) this.paperEl.style.setProperty('bottom', '16px', 'important');
        };
        this.container.addEventListener('mouseenter', onEnter, { passive: true });
        this.container.addEventListener('mouseleave', onLeave, { passive: true });
      }
    }

    attachVideoListeners() {
      this.videoEl.addEventListener('timeupdate', this.onTimeUpdate, { passive: true });
      this.videoEl.addEventListener('seeking', this.onSeeking, { passive: true });
      this.videoEl.addEventListener('seeked', this.onSeeked, { passive: true });

      // Handle textTracks (Twitter / HLS.js / HTML5 <track>)
      const setupTrack = (track) => {
        if (!track) return;
        try {
          if (track.mode !== 'hidden') {
            track.mode = 'hidden';
          }
        } catch { /* ignore */ }

        const onCueChange = () => {
          if (!isSubtitlesActive) return;
          const cues = track.activeCues;
          if (cues && cues.length > 0) {
            const text = Array.from(cues)
              .map((c) => c.text || '')
              .join(' ')
              .replace(/<[^>]+>/g, '')
              .replace(/[\r\n]+/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            if (text && !isIgnoredCaptionText(text)) {
              this.handleExternalCaption(text);
            }
          }
        };

        try {
          track.removeEventListener('cuechange', onCueChange);
          track.addEventListener('cuechange', onCueChange);
        } catch { /* ignore */ }

        if (track.cues && track.cues.length > 0) {
          this.parseTrackCues(track.cues);
        }
      };

      if (this.videoEl.textTracks) {
        for (let i = 0; i < this.videoEl.textTracks.length; i++) {
          setupTrack(this.videoEl.textTracks[i]);
        }
        try {
          this.videoEl.textTracks.addEventListener('addtrack', (e) => {
            setupTrack(e.track);
          });
        } catch { /* ignore */ }
      }

      // Always setup DOM caption observer for on-screen captions
      this.setupDOMCaptionObserver();
    }

    parseTrackCues(cues) {
      if (!cues || cues.length === 0) return;
      const subs = [];
      for (let i = 0; i < cues.length; i++) {
        const cue = cues[i];
        const start = Math.round((cue.startTime || 0) * 1000);
        const end = Math.round((cue.endTime || 0) * 1000);
        const text = (cue.text || '').replace(/<[^>]+>/g, '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (text && !isIgnoredCaptionText(text)) {
          subs.push({ start, end, text, translation: null, isTranslating: false });
        }
      }
      subs.sort((a, b) => a.start - b.start);
      if (subs.length > 0) {
        this.formattedSubtitles = subs;
        if (isSubtitlesActive) {
          this.onTimeUpdate();
        }
      }
    }

    readTwitterCaption() {
      const containerRect = this.container.getBoundingClientRect();
      if (containerRect.width < 80 || containerRect.height < 60) return null;

      // Find all spans or divs with background color
      const styledElements = this.container.querySelectorAll(
        'span[style*="background"], div[dir="auto"] span, div[style*="background"]'
      );

      const candidateParents = new Map();

      for (let i = 0; i < styledElements.length; i++) {
        const el = styledElements[i];
        if (el.closest('.mao-video-btn-host') || el.closest('.mao-in-video-caption-container')) {
          continue;
        }
        // Exclude UI controls, buttons, tooltips
        if (
          el.closest('button') ||
          el.closest('[role="button"]') ||
          el.closest('[role="tooltip"]') ||
          el.closest('[role="progressbar"]') ||
          el.closest('[role="toolbar"]') ||
          el.closest('[data-testid*="tooltip"]') ||
          el.closest('[data-testid*="Control"]') ||
          el.closest('[data-testid*="control"]') ||
          el.closest('[data-testid="app-bar"]') ||
          el.closest('.ytp-chrome-bottom')
        ) {
          continue;
        }

        const raw = (el.textContent || '').trim();
        if (!raw || isIgnoredCaptionText(raw)) continue;

        // Position check: must be in lower area (35% to 96%) of the video
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const relTop = (rect.top - containerRect.top) / containerRect.height;
        if (relTop < 0.35 || relTop > 0.96) continue;

        // Check if computed background color is actually dark/black
        const style = window.getComputedStyle(el);
        const bg = style.backgroundColor;
        const isDarkBg = bg.includes('rgb(0, 0, 0)') || bg.includes('rgba(0, 0, 0') || bg.includes('black');
        if (!isDarkBg) continue;

        const parent = el.parentElement || el;
        if (!candidateParents.has(parent)) {
          candidateParents.set(parent, []);
        }
        candidateParents.get(parent).push(el);
      }

      if (candidateParents.size > 0) {
        const lines = [];
        const elementsToHide = [];
        for (const [parent, spans] of candidateParents.entries()) {
          const lineText = (parent.textContent || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
          if (lineText && !isIgnoredCaptionText(lineText)) {
            lines.push(lineText);
            elementsToHide.push(parent);
            spans.forEach((s) => elementsToHide.push(s));
          }
        }
        const fullText = lines.join(' ').replace(/\s+/g, ' ').trim();
        if (fullText.length >= 2) {
          return { text: fullText, elements: elementsToHide };
        }
      }
      return null;
    }

    readDOMCaption() {
      const containerRect = this.container.getBoundingClientRect();
      if (containerRect.width < 80 || containerRect.height < 60) return null;

      // Check candidate text elements inside container
      // Twitter/X uses unclassed spans in div[dir="auto"]; generic sites only match explicit subtitle elements
      const candidates = this.isTwitter
        ? this.container.querySelectorAll('span, div[dir="auto"], p')
        : this.container.querySelectorAll('[class*="caption" i], [class*="subtitle" i], [id*="caption" i], [id*="subtitle" i], .vjs-text-track-display, .plyr__captions');
      let bestMatch = null;
      let maxLen = 0;

      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        if (el.closest('.mao-video-btn-host') || el.closest('.mao-in-video-caption-container')) {
          continue;
        }
        // Exclude control bar, buttons, progressbar, tooltips
        if (
          el.closest('button') ||
          el.closest('[role="button"]') ||
          el.closest('[role="tooltip"]') ||
          el.closest('[role="progressbar"]') ||
          el.closest('[role="toolbar"]') ||
          el.closest('[data-testid*="tooltip"]') ||
          el.closest('[data-testid*="Control"]') ||
          el.closest('[data-testid*="control"]') ||
          el.closest('[data-testid="app-bar"]') ||
          el.closest('.ytp-chrome-bottom')
        ) {
          continue;
        }

        const text = (el.textContent || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text || text.length < 3) continue;
        if (isIgnoredCaptionText(text)) continue;

        // Verify spatial position: subtitles are located in the lower area of the video container
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const relativeTop = (rect.top - containerRect.top) / containerRect.height;
        if (relativeTop < 0.35 || relativeTop > 0.96) continue;

        // Prefer longest complete sentence
        if (text.length > maxLen) {
          maxLen = text.length;
          bestMatch = { el, text };
        }
      }

      return bestMatch;
    }

    setupDOMCaptionObserver() {
      const observer = new MutationObserver(() => {
        if (!isSubtitlesActive) return;

        // Priority 1: Twitter styled caption spans
        const twitterCaption = this.readTwitterCaption();
        if (twitterCaption) {
          this.handleExternalCaption(twitterCaption.text);
          if (Array.isArray(twitterCaption.elements)) {
            twitterCaption.elements.forEach((el) => {
              el.style.setProperty('opacity', '0', 'important');
              el.style.setProperty('visibility', 'hidden', 'important');
            });
          }
          return;
        }

        // Priority 2: Generic DOM caption
        const domCaption = this.readDOMCaption();
        if (domCaption) {
          this.handleExternalCaption(domCaption.text);
          if (domCaption.el) {
            domCaption.el.style.setProperty('opacity', '0', 'important');
            domCaption.el.style.setProperty('visibility', 'hidden', 'important');
            const parent = domCaption.el.parentElement;
            if (parent && parent !== this.container && !parent.querySelector('video') && !parent.querySelector('button')) {
              parent.style.setProperty('opacity', '0', 'important');
              parent.style.setProperty('visibility', 'hidden', 'important');
            }
          }
        }
      });
      observer.observe(this.container, { childList: true, subtree: true, characterData: true });
    }

    async loadVideoCaptions() {
      if (!this.isYouTube) return;
      try {
        if (typeof window.__maoEnableNativeCaptions === 'function') {
          window.__maoEnableNativeCaptions();
        }
        let res = null;
        if (typeof window.__maoLoadYouTubeCaptions === 'function') {
          res = await window.__maoLoadYouTubeCaptions();
        }
        if (!res || !res.ok || !res.eventsByUrl || Object.keys(res.eventsByUrl).length === 0) {
          await new Promise((r) => setTimeout(r, 600));
          if (typeof window.__maoLoadYouTubeCaptions === 'function') {
            res = await window.__maoLoadYouTubeCaptions();
          }
        }
        if (res && res.ok && res.eventsByUrl) {
          const allUrls = Object.keys(res.eventsByUrl);
          for (const u of allUrls) {
            const rawEvents = res.eventsByUrl[u] || [];
            if (rawEvents.length > 0) {
              this.parseYouTubeTimedText(rawEvents);
              return;
            }
          }
        }
      } catch (err) {
        console.debug('[MAO Subtitles] Error loading YouTube captions:', err);
      }
    }

    parseYouTubeTimedText(rawEvents) {
      const subs = [];
      for (const ev of rawEvents) {
        const start = ev.tStartMs;
        const duration = ev.dDurationMs || 0;
        const end = start + duration;
        let text = '';
        if (Array.isArray(ev.segs)) {
          text = ev.segs.map((s) => s.utf8 || '').join('');
        }
        text = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (text && text !== '\n' && !isIgnoredCaptionText(text)) {
          subs.push({ start, end, text, translation: null, isTranslating: false });
        }
      }
      subs.sort((a, b) => a.start - b.start);
      this.formattedSubtitles = subs;
      if (subs.length > 0 && isSubtitlesActive) {
        this.onTimeUpdate();
      }
    }

    onTimeUpdate() {
      if (!isSubtitlesActive) {
        this.hideSubtitles();
        return;
      }
      const currentTimeMs = Math.round(this.videoEl.currentTime * 1000);

      // 1. YouTube / WebVTT TimedText formatted subtitles match
      if (this.formattedSubtitles.length > 0) {
        const idx = this.binarySearchSubtitle(currentTimeMs);
        if (idx !== -1) {
          const sub = this.formattedSubtitles[idx];
          this.displaySubtitle(sub.text, sub.translation);
          if (!sub.translation && !sub.isTranslating && currentDisplayMode !== 'source_only') {
            sub.isTranslating = true;
            translateText(sub.text).then((trans) => {
              sub.translation = trans;
              sub.isTranslating = false;
              if (this.currentIndex === idx && isSubtitlesActive) {
                this.displaySubtitle(sub.text, trans);
              }
            });
          }
          // Pre-translate next 2 upcoming subtitles
          if (currentDisplayMode !== 'source_only') {
            for (let n = 1; n <= 2; n++) {
              const next = this.formattedSubtitles[idx + n];
              if (next && !next.translation && !next.isTranslating) {
                next.isTranslating = true;
                translateText(next.text).then((tr) => {
                  next.translation = tr;
                  next.isTranslating = false;
                });
              }
            }
          }
          this.currentIndex = idx;
          return;
        } else {
          this.hideSubtitles();
        }
      }

      // 2. Check active textTracks cues (HTML5 / HLS WebVTT)
      if (this.videoEl.textTracks && this.videoEl.textTracks.length > 0) {
        for (let i = 0; i < this.videoEl.textTracks.length; i++) {
          const track = this.videoEl.textTracks[i];
          if (track.mode !== 'hidden') {
            try { track.mode = 'hidden'; } catch { /* ignore */ }
          }
          if (this.formattedSubtitles.length === 0 && track.cues && track.cues.length > 0) {
            this.parseTrackCues(track.cues);
            return;
          }
          const cues = track.activeCues;
          if (cues && cues.length > 0) {
            const text = Array.from(cues).map((c) => c.text || '').join(' ').replace(/<[^>]+>/g, '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
            if (text && !isIgnoredCaptionText(text)) {
              this.handleExternalCaption(text);
              return;
            }
          }
        }
      }

      // 3. YouTube on-screen captions fallback
      if (this.isYouTube) {
        const onScreenLines = typeof window.__maoReadOnscreenLines === 'function'
          ? window.__maoReadOnscreenLines()
          : [];
        const combined = onScreenLines.join(' ').trim();
        if (combined && !isIgnoredCaptionText(combined)) {
          this.handleExternalCaption(combined);
          return;
        }
        const ytpSegments = document.querySelectorAll('.ytp-caption-segment');
        if (ytpSegments.length > 0) {
          const text = Array.from(ytpSegments).map((s) => s.textContent || '').join(' ').trim();
          if (text && !isIgnoredCaptionText(text)) {
            this.handleExternalCaption(text);
            ytpSegments.forEach((s) => {
              s.style.setProperty('opacity', '0', 'important');
              s.style.setProperty('visibility', 'hidden', 'important');
            });
            return;
          }
        }
      }

      // 4. Twitter / X styled DOM captions
      const twitterCaption = this.readTwitterCaption();
      if (twitterCaption) {
        this.handleExternalCaption(twitterCaption.text);
        if (Array.isArray(twitterCaption.elements)) {
          twitterCaption.elements.forEach((el) => {
            el.style.setProperty('opacity', '0', 'important');
            el.style.setProperty('visibility', 'hidden', 'important');
          });
        }
        return;
      }

      // 5. Generic DOM on-screen captions fallback
      const domCaption = this.readDOMCaption();
      if (domCaption) {
        this.handleExternalCaption(domCaption.text);
        if (domCaption.el) {
          domCaption.el.style.setProperty('opacity', '0', 'important');
          domCaption.el.style.setProperty('visibility', 'hidden', 'important');
          const parent = domCaption.el.parentElement;
          if (parent && parent !== this.container && !parent.querySelector('video') && !parent.querySelector('button')) {
            parent.style.setProperty('opacity', '0', 'important');
            parent.style.setProperty('visibility', 'hidden', 'important');
          }
        }
      }
    }

    binarySearchSubtitle(timeMs) {
      const arr = this.formattedSubtitles;
      let left = 0;
      let right = arr.length - 1;
      while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const sub = arr[mid];
        if (timeMs >= sub.start && timeMs <= sub.end) {
          return mid;
        } else if (timeMs < sub.start) {
          right = mid - 1;
        } else {
          left = mid + 1;
        }
      }
      return -1;
    }

    handleExternalCaption(text) {
      if (!text || !isSubtitlesActive) return;
      if (this.lastExternalText === text) return;
      this.lastExternalText = text;

      if (currentDisplayMode === 'source_only') {
        this.displaySubtitle(text, '');
        return;
      }

      this.displaySubtitle(text, '...');
      translateText(text).then((trans) => {
        if (this.lastExternalText === text && isSubtitlesActive) {
          this.displaySubtitle(text, trans);
        }
      });
    }

    displaySubtitle(origText, transText) {
      if (!this.paperEl || !isSubtitlesActive) return;
      if (!origText && !transText) {
        this.hideSubtitles();
        return;
      }
      this.paperEl.style.setProperty('display', 'flex', 'important');
      this.paperEl.style.setProperty('opacity', '1', 'important');
      this.paperEl.style.setProperty('visibility', 'visible', 'important');

      // Check display modes:
      // 'bilingual': show both orig and trans
      // 'target_only': show trans only (单语: 仅译文)
      // 'source_only': show orig only (单语: 仅原文)
      const showOrig = (currentDisplayMode === 'bilingual' || currentDisplayMode === 'source_only') && Boolean(origText);
      const showTrans = (currentDisplayMode === 'bilingual' || currentDisplayMode === 'target_only') && Boolean(transText);

      if (showOrig) {
        this.origEl.textContent = normalizeSubtitleText(origText);
        this.origEl.style.setProperty('display', 'inline-block', 'important');
      } else {
        this.origEl.style.setProperty('display', 'none', 'important');
      }

      if (showTrans) {
        this.transEl.textContent = normalizeSubtitleText(transText);
        this.transEl.style.setProperty('display', 'inline-block', 'important');
      } else {
        this.transEl.style.setProperty('display', 'none', 'important');
      }
    }

    hideSubtitles() {
      if (this.paperEl) {
        this.paperEl.style.setProperty('display', 'none', 'important');
      }
      this.currentIndex = -1;
    }

    onSeeking() {
      // Scrubbing
    }

    onSeeked() {
      this.onTimeUpdate();
    }

    hasActiveTextTracks() {
      if (!this.videoEl || !this.videoEl.textTracks) return false;
      for (let i = 0; i < this.videoEl.textTracks.length; i++) {
        const t = this.videoEl.textTracks[i];
        if (t.cues && t.cues.length > 0) return true;
      }
      return false;
    }

    destroy() {
      this.videoEl.removeEventListener('timeupdate', this.onTimeUpdate);
      this.videoEl.removeEventListener('seeking', this.onSeeking);
      this.videoEl.removeEventListener('seeked', this.onSeeked);
      this.containerEl?.remove();
    }
  }

  // Styles for Floating Pill Button & Popover Menu inside Shadow DOM
  const BUTTON_STYLES = `
    :host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      line-height: 1;
      user-select: none;
      -webkit-user-select: none;
    }
    .mao-pill-wrap {
      position: relative;
      display: inline-flex;
      flex-direction: column;
      align-items: flex-end;
    }
    .mao-pill-btn-group {
      display: inline-flex;
      align-items: center;
      height: 32px;
      border-radius: 9999px;
      background: rgba(18, 16, 26, 0.85);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 255, 255, 0.2);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.38);
      transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      overflow: hidden;
    }
    .mao-pill-btn-group:hover {
      border-color: rgba(216, 180, 254, 0.5);
      box-shadow: 0 6px 20px rgba(61, 28, 86, 0.55);
    }
    .mao-pill-btn-group.active {
      background: linear-gradient(135deg, #4E246E 0%, #29103D 100%);
      border-color: rgba(192, 132, 252, 0.7);
      box-shadow: 0 4px 18px rgba(168, 85, 247, 0.45);
    }

    /* Left Icon Button (Dropdown trigger) */
    .mao-pill-cat-btn {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      height: 100%;
      padding: 0 7px 0 10px;
      background: transparent;
      border: none;
      cursor: pointer;
      color: #C084FC;
      transition: background 0.18s, color 0.18s;
      outline: none;
    }
    .mao-pill-cat-btn:hover,
    .mao-pill-cat-btn.open {
      background: rgba(255, 255, 255, 0.14);
      color: #F3E8FF;
    }
    .icon-wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 15px;
      height: 15px;
      transition: transform 0.2s ease;
    }
    .mao-pill-cat-btn:hover .icon-wrap {
      transform: rotate(-6deg) scale(1.1);
    }
    .cat-caret {
      font-size: 10px;
      line-height: 1;
      color: rgba(255, 255, 255, 0.65);
      transition: transform 0.2s ease;
    }
    .mao-pill-cat-btn.open .cat-caret {
      transform: rotate(180deg);
      color: #ffffff;
    }

    /* Divider */
    .mao-pill-sep {
      width: 1px;
      height: 14px;
      background: rgba(255, 255, 255, 0.18);
    }

    /* Right Toggle Button */
    .mao-pill-toggle-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 100%;
      padding: 0 12px 0 8px;
      background: transparent;
      border: none;
      cursor: pointer;
      color: #ffffff;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.2px;
      outline: none;
      transition: background 0.18s;
      white-space: nowrap;
    }
    .mao-pill-toggle-btn:hover {
      background: rgba(255, 255, 255, 0.08);
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #10B981;
      box-shadow: 0 0 8px #10B981;
      display: none;
      animation: mao-pulse 2s infinite;
    }
    .mao-pill-btn-group.active .status-dot {
      display: inline-block;
    }
    @keyframes mao-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(0.85); }
    }
    .label-text {
      line-height: 1;
      font-size: 12px;
      font-weight: 500;
    }

    /* ── Popover Settings Menu ── */
    .mao-settings-popover {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      width: 252px;
      background: rgba(18, 14, 28, 0.95);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 12px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.06);
      padding: 12px 14px;
      display: none;
      flex-direction: column;
      gap: 11px;
      z-index: 2147483647;
      color: #ffffff;
      font-size: 12px;
      line-height: 1.4;
      box-sizing: border-box;
      pointer-events: auto;
      animation: mao-popover-in 0.18s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .mao-settings-popover.open {
      display: flex !important;
    }
    @keyframes mao-popover-in {
      from { opacity: 0; transform: translateY(-6px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .popover-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .popover-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 600;
      color: #F3E8FF;
    }
    .popover-section-label {
      font-size: 11px;
      font-weight: 500;
      color: rgba(255, 255, 255, 0.58);
      margin-bottom: 5px;
      letter-spacing: 0.3px;
    }

    /* Segmented Control for Display Mode, Font Size & ASR */
    .mode-segmented,
    .size-segmented,
    .asr-segmented {
      display: flex;
      background: rgba(255, 255, 255, 0.07);
      border-radius: 8px;
      padding: 2px;
      gap: 2px;
    }
    .mode-seg-btn,
    .size-seg-btn,
    .asr-seg-btn {
      flex: 1;
      border: none;
      background: transparent;
      color: rgba(255, 255, 255, 0.7);
      font-size: 11px;
      font-weight: 500;
      padding: 5px 0;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      text-align: center;
      outline: none;
    }
    .mode-seg-btn:hover,
    .size-seg-btn:hover,
    .asr-seg-btn:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.06);
    }
    .mode-seg-btn.active,
    .size-seg-btn.active,
    .asr-seg-btn.active {
      background: #7C3AED;
      color: #ffffff;
      font-weight: 600;
      box-shadow: 0 2px 6px rgba(124, 58, 237, 0.45);
    }

    /* Engine List */
    .engine-list {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .engine-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 9px;
      border-radius: 7px;
      cursor: pointer;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid transparent;
      transition: all 0.15s ease;
    }
    .engine-item:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.1);
    }
    .engine-item.active {
      background: rgba(168, 85, 247, 0.22);
      border-color: rgba(192, 132, 252, 0.4);
    }
    .engine-name {
      font-size: 12px;
      font-weight: 500;
      color: rgba(255, 255, 255, 0.9);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .engine-check {
      font-size: 13px;
      color: #C084FC;
      opacity: 0;
      font-weight: bold;
    }
    .engine-item.active .engine-check {
      opacity: 1;
    }

    /* Target Language Dropdown */
    .lang-select-wrap select {
      width: 100%;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 7px;
      color: #ffffff;
      font-size: 12px;
      padding: 5px 8px;
      outline: none;
      cursor: pointer;
    }
    .lang-select-wrap select option {
      background: #181424;
      color: #ffffff;
    }
  `;

  function updateVisuals(group, active) {
    const label = group.querySelector('.label-text');
    if (active) {
      group.classList.add('active');
      const text = isAsrActive ? 'MAO 听翻 (开启)' : 'MAO 字幕 (开启)';
      if (label) label.textContent = text;
      group.querySelector('.mao-pill-toggle-btn')?.setAttribute('title', 'MAO 字幕已开启 · 点击关闭');
    } else {
      group.classList.remove('active');
      if (label) label.textContent = 'MAO 字幕';
      group.querySelector('.mao-pill-toggle-btn')?.setAttribute('title', 'MAO 视频双语字幕 · 点击开启');
    }
  }

  function setAllButtonsState(active) {
    isSubtitlesActive = active;
    setNativeCaptionsVisibility(active);

    for (const group of activeButtons) {
      try {
        updateVisuals(group, active);
        const host = group.getRootNode()?.host;
        if (host) {
          host.style.setProperty('opacity', active ? '0.7' : '0', 'important');
        }
      } catch { /* ignore detached */ }
    }
    const ytpBtn = document.getElementById('mao-ytp-control-btn');
    if (ytpBtn) {
      ytpBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
      ytpBtn.style.color = active ? '#C084FC' : '#ffffff';
    }

    // Trigger update on all in-video managers
    for (const manager of activeVideoManagers.values()) {
      if (active) {
        if (manager.isYouTube) {
          if (manager.formattedSubtitles.length === 0) {
            manager.loadVideoCaptions().then(() => {
              manager.onTimeUpdate();
            });
          }
        } else if (manager.isTwitter) {
          enableTwitterCaptions(manager.container);
        }
        if (latestSokujiSubtitle && (!manager.formattedSubtitles || manager.formattedSubtitles.length === 0)) {
          manager.displaySubtitle(latestSokujiSubtitle.orig, latestSokujiSubtitle.trans);
        }
        manager.onTimeUpdate();
      } else {
        manager.hideSubtitles();
      }
    }
  }

  function toggleSubtitles() {
    const nextState = !isSubtitlesActive;
    setAllButtonsState(nextState);

    let hasNative = false;
    for (const m of activeVideoManagers.values()) {
      if ((m.formattedSubtitles && m.formattedSubtitles.length > 0) || m.hasActiveTextTracks()) {
        hasNative = true;
        break;
      }
    }

    if (nextState) {
      ensureSokujiPort();
    } else {
      isAsrActive = false;
      if (sokujiPort) {
        try { sokujiPort.disconnect(); } catch {}
        sokujiPort = null;
      }
    }

    const needASR = !hasNative && isAsrEnabled;

    chrome.runtime.sendMessage({
      type: 'MAO_VIDEO_BUTTON_CLICK',
      active: nextState,
      url: window.location.href,
      needASR,
      hasNativeCaptions: hasNative,
      sourceLanguage: currentSourceLang,
      targetLanguage: currentTargetLang,
    }).catch(() => {});
  }

  // Update Popover UI for all mounted buttons
  function updateAllPopoversUI() {
    for (const group of activeButtons) {
      const wrap = group.parentElement;
      if (!wrap) continue;
      const popover = wrap.querySelector('.mao-settings-popover');
      if (!popover) continue;

      // 1. Update Display Mode buttons
      const modeBtns = popover.querySelectorAll('.mode-seg-btn');
      modeBtns.forEach((btn) => {
        const mode = btn.dataset.mode;
        btn.classList.toggle('active', mode === currentDisplayMode);
      });

      // 2. Update Engine items
      const engineItems = popover.querySelectorAll('.engine-item');
      engineItems.forEach((item) => {
        const eng = item.dataset.engine;
        item.classList.toggle('active', eng === currentEngine);
      });

      // 2.5 Update Source Language select
      const sourceLangSelect = popover.querySelector('.source-lang-select');
      if (sourceLangSelect && sourceLangSelect.value !== currentSourceLang) {
        sourceLangSelect.value = currentSourceLang;
      }

      // 3. Update Language select
      const langSelect = popover.querySelector('.lang-select');
      if (langSelect && langSelect.value !== currentTargetLang) {
        langSelect.value = currentTargetLang;
      }

      // 4. Update Font Size buttons
      const sizeBtns = popover.querySelectorAll('.size-seg-btn');
      sizeBtns.forEach((btn) => {
        const size = btn.dataset.size;
        btn.classList.toggle('active', size === currentFontSize);
      });

      // 5. Update ASR buttons
      const asrBtns = popover.querySelectorAll('.asr-seg-btn');
      asrBtns.forEach((btn) => {
        const asr = btn.dataset.asr === 'true';
        btn.classList.toggle('active', asr === isAsrEnabled);
      });
    }
  }

  function setAsrEnabled(enabled) {
    isAsrEnabled = enabled;
    try {
      chrome.storage.local.set({ mao_sub_asr_enabled: enabled });
    } catch { /* ignore */ }
    updateAllPopoversUI();

    if (isSubtitlesActive) {
      let hasNative = false;
      for (const m of activeVideoManagers.values()) {
        if ((m.formattedSubtitles && m.formattedSubtitles.length > 0) || m.hasActiveTextTracks()) {
          hasNative = true;
          break;
        }
      }
      if (!hasNative) {
        if (enabled) {
          ensureSokujiPort();
          chrome.runtime.sendMessage({
            type: 'START_IN_VIDEO_ASR',
          }).catch(() => {});
        } else {
          isAsrActive = false;
          chrome.runtime.sendMessage({
            type: 'STOP_IN_VIDEO_ASR',
          }).catch(() => {});
          for (const group of activeButtons) {
            updateVisuals(group, isSubtitlesActive);
          }
        }
      }
    }
  }

  function setFontSize(size) {
    currentFontSize = size;
    try {
      chrome.storage.local.set({ mao_sub_font_size: size });
    } catch { /* ignore */ }
    updateAllPopoversUI();
    updateAllSubtitleStyles();
  }

  function updateAllSubtitleStyles() {
    for (const m of activeVideoManagers.values()) {
      if (typeof m.applySubtitleStyles === 'function') {
        m.applySubtitleStyles();
      }
    }
  }

  function setDisplayMode(mode) {
    currentDisplayMode = mode;
    try {
      chrome.storage.local.set({ mao_sub_display_mode: mode });
    } catch { /* ignore */ }
    updateAllPopoversUI();
    // Immediate refresh on all video managers
    for (const m of activeVideoManagers.values()) {
      m.onTimeUpdate();
    }
  }

  function setTranslationEngine(engine) {
    currentEngine = engine;
    try {
      chrome.storage.local.set({ mao_sub_engine: engine });
    } catch { /* ignore */ }
    translationCache.clear();
    updateAllPopoversUI();
    // Invalidate cached translations and re-translate
    for (const m of activeVideoManagers.values()) {
      if (m.formattedSubtitles) {
        for (const s of m.formattedSubtitles) {
          s.translation = null;
          s.isTranslating = false;
        }
      }
      m.lastExternalText = '';
      m.onTimeUpdate();
    }
  }

  function setSourceLanguage(lang) {
    currentSourceLang = lang;
    try {
      chrome.storage.local.set({ mao_sub_source_lang: lang });
    } catch { /* ignore */ }
    translationCache.clear();
    updateAllPopoversUI();
    chrome.runtime.sendMessage({
      type: 'MAO_SET_LANGUAGES',
      sourceLanguage: currentSourceLang,
      targetLanguage: currentTargetLang,
    }).catch(() => {});
    for (const m of activeVideoManagers.values()) {
      if (m.formattedSubtitles) {
        for (const s of m.formattedSubtitles) {
          s.translation = null;
          s.isTranslating = false;
        }
      }
      m.lastExternalText = '';
      m.onTimeUpdate();
    }
  }

  function setTargetLanguage(lang) {
    currentTargetLang = lang;
    try {
      chrome.storage.local.set({ mao_sub_target_lang: lang });
    } catch { /* ignore */ }
    translationCache.clear();
    updateAllPopoversUI();
    chrome.runtime.sendMessage({
      type: 'MAO_SET_LANGUAGES',
      sourceLanguage: currentSourceLang,
      targetLanguage: currentTargetLang,
    }).catch(() => {});
    for (const m of activeVideoManagers.values()) {
      if (m.formattedSubtitles) {
        for (const s of m.formattedSubtitles) {
          s.translation = null;
          s.isTranslating = false;
        }
      }
      m.lastExternalText = '';
      m.onTimeUpdate();
    }
  }

  function attachPillToContainer(container) {
    if (container.dataset.maoBtnAttached === 'true') return;
    if (container.querySelector(':scope > .mao-video-btn-host')) return;
    container.dataset.maoBtnAttached = 'true';

    const computed = window.getComputedStyle(container);
    if (computed.position === 'static') {
      container.style.position = 'relative';
    }

    const host = document.createElement('div');
    host.className = 'mao-video-btn-host';
    host.style.cssText = [
      'all: initial',
      'position: absolute',
      'top: 14px',
      'right: 14px',
      'z-index: 2147483640',
      'pointer-events: auto',
      'display: block',
      'transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
      'opacity: 0.75',
      'transform: translateY(0)',
    ].join(' !important;') + ' !important;';

    const shadow = host.attachShadow({ mode: 'open' });
    const styleEl = document.createElement('style');
    styleEl.textContent = BUTTON_STYLES;
    shadow.appendChild(styleEl);

    const wrap = document.createElement('div');
    wrap.className = 'mao-pill-wrap';

    // Button Group: [ 🐱 ▾ | ● MAO 字幕 ]
    const group = document.createElement('div');
    group.className = 'mao-pill-btn-group';

    // Left Cat Button
    const catBtn = document.createElement('button');
    catBtn.className = 'mao-pill-cat-btn';
    catBtn.setAttribute('type', 'button');
    catBtn.setAttribute('title', '点击设置 · 选择翻译引擎与单/双语');
    catBtn.innerHTML = `
      <span class="icon-wrap">${MAO_CAT_SVG}</span>
      <span class="cat-caret">▾</span>
    `;

    // Divider
    const sep = document.createElement('div');
    sep.className = 'mao-pill-sep';

    // Right Toggle Button
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'mao-pill-toggle-btn';
    toggleBtn.setAttribute('type', 'button');
    toggleBtn.setAttribute('title', 'MAO 视频字幕 · 点击开关');
    toggleBtn.innerHTML = `
      <span class="status-dot"></span>
      <span class="label-text">MAO 字幕</span>
    `;

    group.appendChild(catBtn);
    group.appendChild(sep);
    group.appendChild(toggleBtn);
    updateVisuals(group, isSubtitlesActive);
    wrap.appendChild(group);

    // Settings Popover Menu
    const popover = document.createElement('div');
    popover.className = 'mao-settings-popover';
    popover.innerHTML = `
      <div class="popover-header">
        <div class="popover-title">
          <span>${MAO_CAT_SVG}</span>
          <span>MAO 字幕设置</span>
        </div>
      </div>

      <!-- 1. Display Mode: Bilingual vs Monolingual -->
      <div class="popover-section">
        <div class="popover-section-label">字幕显示模式</div>
        <div class="mode-segmented">
          <button type="button" class="mode-seg-btn ${currentDisplayMode === 'bilingual' ? 'active' : ''}" data-mode="bilingual">双语字幕</button>
          <button type="button" class="mode-seg-btn ${currentDisplayMode === 'target_only' ? 'active' : ''}" data-mode="target_only">仅译文</button>
          <button type="button" class="mode-seg-btn ${currentDisplayMode === 'source_only' ? 'active' : ''}" data-mode="source_only">仅原文</button>
        </div>
      </div>

      <!-- 2. Translation Engine -->
      <div class="popover-section">
        <div class="popover-section-label">翻译引擎</div>
        <div class="engine-list">
          <div class="engine-item ${currentEngine === 'google' ? 'active' : ''}" data-engine="google">
            <span class="engine-name">⚡ Google 翻译 <span style="font-size: 10px; color: rgba(255,255,255,0.5);">(快速免费)</span></span>
            <span class="engine-check">✓</span>
          </div>
          <div class="engine-item ${currentEngine === 'bing' ? 'active' : ''}" data-engine="bing">
            <span class="engine-name">🌐 微软 Bing 翻译 <span style="font-size: 10px; color: rgba(255,255,255,0.5);">(LLM增强)</span></span>
            <span class="engine-check">✓</span>
          </div>
          <div class="engine-item ${currentEngine === 'deepl' ? 'active' : ''}" data-engine="deepl">
            <span class="engine-name">🔮 DeepL 翻译 <span style="font-size: 10px; color: rgba(255,255,255,0.5);">(精准自然)</span></span>
            <span class="engine-check">✓</span>
          </div>
        </div>
      </div>

      <!-- 2.5 Source Language / 视频原声 (识别语言) -->
      <div class="popover-section">
        <div class="popover-section-label">视频原声 (识别语言)</div>
        <div class="lang-select-wrap">
          <select class="source-lang-select">
            <option value="auto">🌐 自动检测 (Auto)</option>
            <option value="ja">🇯🇵 日语 (日本語)</option>
            <option value="en">🇺🇸 英语 (English)</option>
            <option value="zh">🇨🇳 中文 (普通话)</option>
            <option value="ko">🇰🇷 韩语 (한국어)</option>
            <option value="es">🇪🇸 西班牙语 (Español)</option>
            <option value="fr">🇫🇷 法语 (Français)</option>
            <option value="de">🇩🇪 德语 (Deutsch)</option>
            <option value="ru">🇷🇺 俄语 (Русский)</option>
          </select>
        </div>
      </div>

      <!-- 3. Target Language -->
      <div class="popover-section">
        <div class="popover-section-label">目标语言 (翻译为)</div>
        <div class="lang-select-wrap">
          <select class="lang-select">
            <option value="zh-CN">🇨🇳 中文 (简体)</option>
            <option value="zh-TW">🇭🇰 中文 (繁体)</option>
            <option value="en">🇺🇸 英语 (English)</option>
            <option value="ja">🇯🇵 日语 (日本語)</option>
            <option value="ko">🇰🇷 韩语 (한국어)</option>
            <option value="es">🇪🇸 西班牙语 (Español)</option>
            <option value="fr">🇫🇷 法语 (Français)</option>
            <option value="de">🇩🇪 德语 (Deutsch)</option>
            <option value="ru">🇷🇺 俄语 (Русский)</option>
          </select>
        </div>
      </div>

      <!-- 4. Subtitle Size -->
      <div class="popover-section">
        <div class="popover-section-label">字幕大小</div>
        <div class="size-segmented">
          <button type="button" class="size-seg-btn ${currentFontSize === 'small' ? 'active' : ''}" data-size="small">小</button>
          <button type="button" class="size-seg-btn ${currentFontSize === 'medium' ? 'active' : ''}" data-size="medium">中 (标准)</button>
          <button type="button" class="size-seg-btn ${currentFontSize === 'large' ? 'active' : ''}" data-size="large">大</button>
        </div>
      </div>

      <!-- 5. Real-time ASR Translation -->
      <div class="popover-section">
        <div class="popover-section-label">实时语音听翻 (无字幕视频)</div>
        <div class="asr-segmented">
          <button type="button" class="asr-seg-btn ${isAsrEnabled ? 'active' : ''}" data-asr="true">自动听翻</button>
          <button type="button" class="asr-seg-btn ${!isAsrEnabled ? 'active' : ''}" data-asr="false">仅原片字幕</button>
        </div>
      </div>
    `;
    wrap.appendChild(popover);
    shadow.appendChild(wrap);

    activeButtons.add(group);

    // Event: Toggle subtitles
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      closePopover();
      toggleSubtitles();
    });

    // Event: Cat button clicked -> toggle popover
    let isPopoverOpen = false;
    const openPopover = () => {
      isPopoverOpen = true;
      popover.classList.add('open');
      catBtn.classList.add('open');
      showButton(false); // keep host visible while popover is open
    };
    const closePopover = () => {
      if (!isPopoverOpen) return;
      isPopoverOpen = false;
      popover.classList.remove('open');
      catBtn.classList.remove('open');
    };

    catBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (isPopoverOpen) {
        closePopover();
      } else {
        openPopover();
      }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (isPopoverOpen && !shadow.contains(e.target)) {
        closePopover();
      }
    });

    // Popover internal clicks: prevent bubble
    popover.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Mode buttons clicked
    popover.querySelectorAll('.mode-seg-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = btn.dataset.mode;
        if (mode) setDisplayMode(mode);
      });
    });

    // Engine items clicked
    popover.querySelectorAll('.engine-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const eng = item.dataset.engine;
        if (eng) setTranslationEngine(eng);
      });
    });

    // Source Language select changed
    const sourceLangSelect = popover.querySelector('.source-lang-select');
    if (sourceLangSelect) {
      sourceLangSelect.value = currentSourceLang;
      sourceLangSelect.addEventListener('change', (e) => {
        e.stopPropagation();
        setSourceLanguage(sourceLangSelect.value);
      });
    }

    // Target Language select changed
    const langSelect = popover.querySelector('.lang-select');
    if (langSelect) {
      langSelect.value = currentTargetLang;
      langSelect.addEventListener('change', (e) => {
        e.stopPropagation();
        setTargetLanguage(langSelect.value);
      });
    }

    // Size buttons clicked
    popover.querySelectorAll('.size-seg-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const size = btn.dataset.size;
        if (size) setFontSize(size);
      });
    });

    // ASR buttons clicked
    popover.querySelectorAll('.asr-seg-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const enabled = btn.dataset.asr === 'true';
        setAsrEnabled(enabled);
      });
    });

    // Auto-fade timer
    let hideTimer = null;
    const showButton = (autoHide = true) => {
      if (hideTimer) clearTimeout(hideTimer);
      host.style.setProperty('opacity', '1', 'important');
      host.style.setProperty('transform', 'translateY(0)', 'important');
      if (autoHide && !isPopoverOpen) {
        hideTimer = setTimeout(() => {
          if (isPopoverOpen) return;
          if (!isSubtitlesActive) {
            host.style.setProperty('opacity', '0.55', 'important');
            host.style.setProperty('transform', 'translateY(0)', 'important');
          } else {
            host.style.setProperty('opacity', '0.75', 'important');
          }
        }, 3500);
      }
    };

    const hideButton = () => {
      if (isPopoverOpen) return;
      if (hideTimer) clearTimeout(hideTimer);
      if (!isSubtitlesActive) {
        host.style.setProperty('opacity', '0.55', 'important');
        host.style.setProperty('transform', 'translateY(0)', 'important');
      } else {
        host.style.setProperty('opacity', '0.75', 'important');
      }
    };

    container.addEventListener('mousemove', () => showButton(true), { passive: true });
    container.addEventListener('mouseenter', () => showButton(true), { passive: true });
    container.addEventListener('touchstart', () => showButton(true), { passive: true });
    container.addEventListener('mouseleave', hideButton, { passive: true });

    host.addEventListener('mouseenter', () => {
      if (hideTimer) clearTimeout(hideTimer);
      host.style.setProperty('opacity', '1', 'important');
    });

    container.appendChild(host);

    // Initial entrance animation so user notices the button
    showButton(true);
  }

  function injectYouTubeControlBarButton() {
    const controls = document.querySelector('.ytp-right-controls');
    if (!controls) return;
    if (document.getElementById('mao-ytp-control-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'mao-ytp-control-btn';
    btn.className = 'ytp-button';
    btn.setAttribute('title', 'MAO 双语字幕 (右键设置)');
    btn.setAttribute('aria-label', 'MAO 双语字幕');
    btn.setAttribute('aria-pressed', isSubtitlesActive ? 'true' : 'false');
    btn.style.cssText = 'position: relative; overflow: visible; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px;';
    btn.innerHTML = YTP_CAT_SVG;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSubtitles();
    });

    const settingsBtn = controls.querySelector('.ytp-settings-button');
    if (settingsBtn) {
      controls.insertBefore(btn, settingsBtn);
    } else {
      controls.appendChild(btn);
    }
  }

  function registerVideo(videoEl, container) {
    attachPillToContainer(container);
    if (!activeVideoManagers.has(videoEl)) {
      const manager = new InVideoSubtitleManager(videoEl, container);
      activeVideoManagers.set(videoEl, manager);
    }
  }

  function scanAndMount() {
    // 1. YouTube Player
    const ytPlayer = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    if (ytPlayer) {
      const ytVideo = ytPlayer.querySelector('video');
      if (ytVideo) {
        registerVideo(ytVideo, ytPlayer);
        injectYouTubeControlBarButton();
      }
    }

    // 2. All HTML5 / Twitter / Social Video Players
    const videos = document.querySelectorAll('video');
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      if (activeVideoManagers.has(video)) continue;
      const rect = video.getBoundingClientRect();
      const parentRect = video.parentElement ? video.parentElement.getBoundingClientRect() : rect;
      const hasSize = (rect.width >= 80 && rect.height >= 50) || (parentRect.width >= 80 && parentRect.height >= 50);
      const isMediaReady = video.videoWidth > 0 || video.readyState > 0 || !video.paused;
      if (!hasSize && !isMediaReady) continue;

      // Skip YouTube as handled above
      if (video.closest('#movie_player') || video.closest('.html5-video-player')) continue;

      const isTwitter = Boolean(video.closest('article[data-testid="tweet"], div[data-testid="videoComponent"], div[data-testid="videoPlayer"]'));
      if (!isTwitter) {
        // Exclude recommendation lists, related videos, preview cards, sidebars
        if (
          video.closest('aside') ||
          video.closest('.sidebar') ||
          video.closest('[class*="sidebar" i]') ||
          video.closest('[class*="related" i]') ||
          video.closest('[class*="recommend" i]') ||
          video.closest('[id*="related" i]') ||
          video.closest('[class*="preview" i]') ||
          video.closest('[class*="thumb" i]') ||
          video.closest('.video-img-box') ||
          video.closest('.posts-list') ||
          video.closest('.video-list')
        ) {
          continue;
        }

        // Thumbnail preview videos are typically small (< 320x180). Skip them on video watch pages.
        if (rect.width > 0 && rect.width < 320 && rect.height > 0 && rect.height < 180) {
          continue;
        }
      }

      // Find the best player container (.plyr, .video-js, .dplayer, .artplayer, Twitter, or parent)
      let container =
        video.closest('.plyr') ||
        video.closest('.video-js') ||
        video.closest('.dplayer') ||
        video.closest('.artplayer-app') ||
        video.closest('#player') ||
        video.closest('.player') ||
        video.closest('[id*="player" i]') ||
        video.closest('[class*="player" i]') ||
        video.closest('[class*="video" i]') ||
        video.closest('[id*="video" i]') ||
        video.closest('div[data-testid="videoComponent"]') ||
        video.closest('div[data-testid="videoPlayer"]') ||
        video.closest('div[data-testid="tweetPhoto"]') ||
        video.closest('article[data-testid="tweet"]') ||
        (video.parentElement && video.parentElement !== document.body && video.parentElement !== document.documentElement
          ? video.parentElement
          : (document.body || document.documentElement));

      if (container === video) {
        container = video.parentElement || document.body || document.documentElement;
      }

      if (container) {
        registerVideo(video, container);
      }
    }
  }

  // Live session stream connection (for real-time ASR / Tab audio capture)
  let sokujiPort = null;
  let sokujiReconnectTimer = null;

  function ensureSokujiPort() {
    if (sokujiPort) return sokujiPort;
    try {
      sokujiPort = chrome.runtime.connect({ name: 'sokuji-subtitle' });
      sokujiPort.onMessage.addListener(handleSokujiMessage);
      sokujiPort.onDisconnect.addListener(() => {
        sokujiPort = null;
        if (isSubtitlesActive) {
          if (!sokujiReconnectTimer) {
            sokujiReconnectTimer = setTimeout(() => {
              sokujiReconnectTimer = null;
              if (isSubtitlesActive) ensureSokujiPort();
            }, 1200);
          }
        }
      });
      return sokujiPort;
    } catch {
      sokujiPort = null;
      return null;
    }
  }

  let latestSokujiSubtitle = null;

  function handleSokujiMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    let items = [];
    let participantItems = [];

    if (msg.type === 'items') {
      items = Array.isArray(msg.items) ? msg.items : [];
      participantItems = Array.isArray(msg.participantItems) ? msg.participantItems : [];
    } else if (msg.type === 'state-init' && msg.payload) {
      items = Array.isArray(msg.payload.items) ? msg.payload.items : [];
      participantItems = Array.isArray(msg.payload.participantItems) ? msg.payload.participantItems : [];
    } else {
      return;
    }

    // Video tab audio capture puts items in participantItems; microphone puts them in items.
    const pool = (participantItems.length > 0 ? participantItems : items).filter(Boolean);
    if (pool.length === 0) return;

    const getItemText = (it) => {
      if (!it || !it.formatted) return '';
      // Prefer transcript (actual spoken output translation) over raw text (which might contain thinking trace)
      const raw = (it.formatted.transcript || it.formatted.text || '').trim();
      return normalizeSubtitleText(raw);
    };

    let latestAssistant = null;
    let latestUser = null;
    for (let i = pool.length - 1; i >= 0; i--) {
      const it = pool[i];
      const text = getItemText(it);
      if (!text) continue;
      if (it.role === 'assistant' && !latestAssistant) {
        latestAssistant = it;
      } else if (it.role === 'user' && !latestUser) {
        latestUser = it;
      }
      if (latestAssistant && latestUser) break;
    }

    if (latestAssistant || latestUser) {
      const trans = latestAssistant ? getItemText(latestAssistant) : '';
      const orig = latestUser ? getItemText(latestUser) : '';

      let finalOrig = orig;
      let finalTrans = trans;

      if (currentDisplayMode === 'bilingual') {
        // In bilingual mode, never duplicate untranslated text into the translation box
        finalOrig = orig;
        finalTrans = trans;
      } else if (currentDisplayMode === 'source_only') {
        finalOrig = orig || trans;
        finalTrans = '';
      } else if (currentDisplayMode === 'target_only') {
        finalTrans = trans || orig;
        finalOrig = '';
      }

      latestSokujiSubtitle = { orig: finalOrig, trans: finalTrans };

      if (isSubtitlesActive) {
        for (const m of activeVideoManagers.values()) {
          m.displaySubtitle(finalOrig, finalTrans);
        }
      }
    }
  }

  // Listen for subtitle and ASR status updates from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'sokuji-wire-message' && msg.payload) {
      handleSokujiMessage(msg.payload);
      return;
    }
    if (msg.type === 'MAO_SUBTITLE_ACTIVE') {
      setAllButtonsState(true);
      ensureSokujiPort();
    } else if (msg.type === 'MAO_SUBTITLE_INACTIVE') {
      setAllButtonsState(false);
      isAsrActive = false;
      if (sokujiPort) {
        try { sokujiPort.disconnect(); } catch {}
        sokujiPort = null;
      }
    } else if (msg.type === 'MAO_ASR_STATUS') {
      if (msg.status === 'active') {
        isAsrActive = true;
        ensureSokujiPort();
      } else if (msg.status === 'error') {
        isAsrActive = false;
        let hint = '需要先在 MAO Chat 设置中配置语音识别 API Key (如 Gemini/OpenAI)';
        const errStr = String(msg.error || '');
        if (errStr.includes('insufficient-balance')) {
          hint = '账户余额不足，请在 MAO Chat 设置中充值或更换 API Key';
        } else if (errStr.includes('api-key-invalid') || errStr.includes('no-models')) {
          hint = '未配置有效语音识别 API Key：请点击浏览器右上角插件图标设置';
        } else if (errStr.includes('toolbar icon') || errStr.includes('activeTab') || errStr.includes('invoked')) {
          hint = '声音捕获权限未激活：请点击浏览器右上角 MAO Chat 插件图标激活本页';
        } else if (errStr.trim()) {
          hint = errStr;
        }
        for (const m of activeVideoManagers.values()) {
          m.displaySubtitle('', hint);
        }
      }
      for (const group of activeButtons) {
        updateVisuals(group, isSubtitlesActive);
      }
    }
  });

  // Continuous monitoring for dynamic videos (SPA navigation / scroll)
  let scanTimer = null;
  const observer = new MutationObserver(() => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanAndMount();
    }, 250);
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  // Hook media lifecycle & fullscreen events so late-injected players are caught immediately
  document.addEventListener('play', () => scanAndMount(), true);
  document.addEventListener('playing', () => scanAndMount(), true);
  document.addEventListener('loadedmetadata', () => scanAndMount(), true);
  document.addEventListener('canplay', () => scanAndMount(), true);
  document.addEventListener('fullscreenchange', () => scanAndMount(), true);
  document.addEventListener('webkitfullscreenchange', () => scanAndMount(), true);
  window.addEventListener('resize', () => scanAndMount(), { passive: true });

  // Initial and periodic scan for slow/async loading players
  scanAndMount();
  let periodicScanCount = 0;
  const pollTimer = setInterval(() => {
    periodicScanCount++;
    scanAndMount();
    if (periodicScanCount >= 10) clearInterval(pollTimer);
  }, 1500);
})();
