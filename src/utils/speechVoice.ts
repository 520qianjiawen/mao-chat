// src/utils/speechVoice.ts

/**
 * High-quality speech synthesis utility that filters out macOS novelty,
 * robotic, and archaic voices (e.g. Albert, Fred, Zarvox, Eloquence) and
 * prioritizes natural, crystal-clear human voices (Samantha, Daniel, Tingting, etc.).
 */

const FORBIDDEN_VOICE_NAMES = [
  'albert',
  'bad news',
  'bahh',
  'bells',
  'boing',
  'bubbles',
  'cellos',
  'deranged',
  'wobble',
  'fred',
  'good news',
  'hysterical',
  'jester',
  'junior',
  'kathy',
  'organ',
  'princess',
  'superstar',
  'ralph',
  'trinoids',
  'whisper',
  'zarvox',
  'eddy',
  'flo',
  'grandma',
  'grandpa',
  'reed',
  'rocko',
  'sandy',
  'shelley',
];

const PREFERRED_VOICES_BY_LANG: Record<string, string[]> = {
  en: ['samantha', 'ava', 'daniel', 'karen', 'victoria', 'allison', 'oliver', 'tom', 'serena', 'zoe', 'alex'],
  zh: ['tingting', 'ting-ting', 'meijia', 'sinji', 'sin-ji', 'xiaoxiao', 'yunxi', 'yu-shu', 'li-mu'],
  ja: ['kyoko', 'otoya', 'nanami'],
  ko: ['yuna', 'sunhi'],
  es: ['monica', 'paulina', 'jorge'],
  fr: ['thomas', 'audrey', 'aurelie'],
  de: ['anna', 'markus', 'petra'],
  pt: ['joana', 'luciana', 'felipe'],
};

const MING_TO_SYSTEM_MAP: Record<string, string> = {
  US_Emma: 'Samantha',
  UK_George: 'Daniel',
  UK_Charlotte: 'Samantha',
  灵小雅: 'Ting-Ting',
  灵小棠: 'Ting-Ting',
  灵小锋: 'Ting-Ting',
  灵卓然: 'Ting-Ting',
};

/**
 * Checks if a voice is a natural, pleasant voice rather than a novelty/robotic one.
 */
export function isNaturalVoice(v: SpeechSynthesisVoice): boolean {
  const nameLower = v.name.toLowerCase().trim();
  const uriLower = (v.voiceURI || '').toLowerCase();

  if (uriLower.includes('eloquence') || uriLower.includes('speech.synthesis.voice')) {
    return false;
  }

  for (const forbidden of FORBIDDEN_VOICE_NAMES) {
    if (nameLower === forbidden || nameLower.startsWith(forbidden + ' ') || nameLower.startsWith(forbidden + '(')) {
      return false;
    }
  }

  return true;
}

/**
 * Retrieves all available voices, waiting for the browser voiceschanged event if needed.
 */
let cachedVoices: SpeechSynthesisVoice[] = [];

export async function getLoadedVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return [];
  }

  if (cachedVoices.length > 0) {
    return cachedVoices;
  }

  const existing = window.speechSynthesis.getVoices();
  if (existing.length > 0) {
    cachedVoices = existing;
    return existing;
  }

  return new Promise((resolve) => {
    let resolved = false;
    let timer: NodeJS.Timeout | null = null;
    let pollInterval: NodeJS.Timeout | null = null;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      if (pollInterval) clearInterval(pollInterval);
      window.speechSynthesis.onvoiceschanged = null;
      const v = window.speechSynthesis.getVoices();
      if (v.length > 0) cachedVoices = v;
      resolve(v);
    };

    window.speechSynthesis.onvoiceschanged = finish;

    // Periodic check in case onvoiceschanged does not fire in Electron
    pollInterval = setInterval(() => {
      const v = window.speechSynthesis.getVoices();
      if (v.length > 0) {
        finish();
      }
    }, 50);

    // Safety timeout
    timer = setTimeout(finish, 2000);
  });
}

/**
 * Resolves the best natural voice for a given target language and optional preferred voice name.
 */
export async function getBestSpeechVoice(
  targetLang: string,
  preferredVoiceName?: string,
): Promise<SpeechSynthesisVoice | null> {
  const allVoices = await getLoadedVoices();
  if (allVoices.length === 0) return null;

  const baseLang = (targetLang || 'en').split('-')[0].toLowerCase();
  const naturalVoices = allVoices.filter(isNaturalVoice);

  // 1. Try preferred voice name
  if (preferredVoiceName) {
    let clean = preferredVoiceName.replace(/^(system|ming):/, '').trim();
    if (MING_TO_SYSTEM_MAP[clean]) {
      clean = MING_TO_SYSTEM_MAP[clean];
    }
    const cleanLower = clean.toLowerCase();

    const directMatch = naturalVoices.find(
      (v) =>
        v.name.toLowerCase() === cleanLower ||
        v.name.toLowerCase().includes(cleanLower) ||
        (v.voiceURI && v.voiceURI.toLowerCase().includes(cleanLower)),
    );
    if (directMatch) return directMatch;
  }

  // 2. Filter natural voices matching the target language
  const langVoices = naturalVoices.filter(
    (v) => v.lang.toLowerCase().startsWith(baseLang) || (baseLang === 'zh' && v.lang.toLowerCase().includes('chinese')),
  );

  // 3. Check preferred voice list for this language
  const preferredList = PREFERRED_VOICES_BY_LANG[baseLang] || [];
  for (const pref of preferredList) {
    const found = langVoices.find((v) => v.name.toLowerCase().includes(pref));
    if (found) return found;
  }

  // 4. Return first natural voice for this language
  if (langVoices.length > 0) {
    return langVoices[0];
  }

  // 5. Fallback: Any voice matching language that is not strictly forbidden
  const fallbackMatch = allVoices.find(
    (v) => isNaturalVoice(v) && v.lang.toLowerCase().startsWith(baseLang),
  );
  if (fallbackMatch) return fallbackMatch;

  // 6. Absolute last resort (e.g. headless or limited environments)
  return allVoices.find((v) => v.lang.toLowerCase().startsWith(baseLang)) || allVoices[0] || null;
}

export interface SpeakTextOptions {
  voiceName?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  onEnd?: () => void;
  onError?: (err: any) => void;
}

/**
 * Speaks the given text using a high-quality natural voice.
 */
export async function speakText(
  text: string,
  targetLang: string,
  options?: SpeakTextOptions,
): Promise<boolean> {
  if (!text || !text.trim()) {
    return false;
  }

  stopSpeaking();

  // 1. In Electron, use native local speech (/usr/bin/say) for 100% natural Samantha/Tingting sound
  if (typeof window !== 'undefined' && (window as any).electron?.invoke) {
    try {
      const baseLang = (targetLang || 'en').split('-')[0].toLowerCase();
      const defaultVoice = baseLang === 'zh' ? 'Tingting' : 'Samantha';
      const cleanVoice = options?.voiceName
        ? options.voiceName.replace(/^(system|ming):/, '').trim()
        : defaultVoice;

      const res = await (window as any).electron.invoke('speak-local-audio', {
        text: text.trim(),
        lang: targetLang,
        voice: cleanVoice || defaultVoice,
      });

      if (res?.ok) {
        options?.onEnd?.();
        return true;
      }
    } catch (e) {
      console.warn('[speechVoice] speak-local-audio failed, falling back to browser synthesis:', e);
    }
  }

  // 2. Web Speech API fallback for browser environment
  if (
    typeof window === 'undefined' ||
    !('speechSynthesis' in window) ||
    typeof SpeechSynthesisUtterance === 'undefined'
  ) {
    return false;
  }

  window.speechSynthesis.cancel();

  const baseLang = (targetLang || 'en').split('-')[0].toLowerCase();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = baseLang === 'zh' ? 'zh-CN' : baseLang === 'en' ? 'en-US' : targetLang;
  utterance.rate = options?.rate ?? 1.0;
  utterance.pitch = options?.pitch ?? 1.0;
  utterance.volume = options?.volume ?? 1.0;

  const voice = await getBestSpeechVoice(targetLang, options?.voiceName);
  if (voice) {
    utterance.voice = voice;
  }

  utterance.onend = () => {
    options?.onEnd?.();
  };

  utterance.onerror = (e) => {
    options?.onError?.(e);
  };

  window.speechSynthesis.speak(utterance);
  return true;
}

/**
 * Stops any active speech synthesis.
 */
export function stopSpeaking(): void {
  if (typeof window !== 'undefined' && (window as any).electron?.invoke) {
    try {
      void (window as any).electron.invoke('stop-local-audio');
    } catch {}
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }
}
