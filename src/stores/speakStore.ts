// src/stores/speakStore.ts
import { create } from 'zustand';
import { speakText, stopSpeaking } from '../utils/speechVoice';

export interface SpeakVoiceOption {
  id: string;
  name: string;
  tags: string[];
  kind: 'ming' | 'system' | 'clone';
  latencyLabel: string;
  gender?: 'female' | 'male';
}

export interface VoiceLanguageMeta {
  key: string;
  title: string;
  sample: string;
}

export const SUPPORTED_SPEAK_LANGUAGES: VoiceLanguageMeta[] = [
  { key: 'en', title: 'English', sample: "Thanks everyone. Let's look at the launch timeline and decide who owns the microphone tests." },
  { key: 'zh', title: '中文', sample: '谢谢大家。我们来看一下上线时间表，并确定谁负责麦克风测试。' },
  { key: 'ja', title: '日本語', sample: '皆さん、ありがとうございます。発売スケジュールを確認しましょう。' },
  { key: 'ko', title: '한국어', sample: '감사합니다. 출시 일정을 함께 확인해 보겠습니다.' },
  { key: 'es', title: 'Español', sample: 'Gracias a todos. Revisemos el calendario de lanzamiento.' },
  { key: 'fr', title: 'Français', sample: 'Merci à tous. Regardons ensemble le calendrier de lancement.' },
  { key: 'de', title: 'Deutsch', sample: 'Danke an alle. Schauen wir uns den Zeitplan für den Start an.' },
  { key: 'pt', title: 'Português', sample: 'Obrigado a todos. Vamos ver o cronograma de lançamento.' },
];

export function getVoiceOptionsForLanguage(langKey: string): SpeakVoiceOption[] {
  const baseKey = (langKey || 'en').split('-')[0].toLowerCase();
  switch (baseKey) {
    case 'zh':
      return [
        { id: 'ming:灵小雅', name: '小雅', tags: ['女', '清亮', 'Ming'], kind: 'ming', latencyLabel: '慢约 1 秒', gender: 'female' },
        { id: 'ming:灵小棠', name: '小棠', tags: ['女', '温和', 'Ming'], kind: 'ming', latencyLabel: '慢约 1 秒', gender: 'female' },
        { id: 'ming:灵小锋', name: '小锋', tags: ['男', '温暖', 'Ming'], kind: 'ming', latencyLabel: '慢约 1 秒', gender: 'male' },
        { id: 'ming:灵卓然', name: '卓然', tags: ['男', '沉着', 'Ming'], kind: 'ming', latencyLabel: '慢约 1 秒', gender: 'male' },
        { id: 'system:Ting-Ting', name: 'Ting-Ting', tags: ['女', '本机'], kind: 'system', latencyLabel: '最快', gender: 'female' },
        { id: 'system:Sin-ji', name: 'Sin-ji', tags: ['女', '本机'], kind: 'system', latencyLabel: '最快', gender: 'female' },
      ];
    case 'ja':
      return [
        { id: 'ming:US_Emma', name: 'Emma', tags: ['女', 'Ming'], kind: 'ming', latencyLabel: '慢约 1 秒', gender: 'female' },
        { id: 'ming:UK_George', name: 'George', tags: ['男', 'Ming'], kind: 'ming', latencyLabel: '慢约 1 秒', gender: 'male' },
        { id: 'system:Kyoko', name: 'Kyoko', tags: ['女', '本机'], kind: 'system', latencyLabel: '最快', gender: 'female' },
        { id: 'system:Otoya', name: 'Otoya', tags: ['男', '本机'], kind: 'system', latencyLabel: '最快', gender: 'male' },
      ];
    case 'ko':
      return [
        { id: 'ming:US_Emma', name: 'Emma', tags: ['女', 'Ming'], kind: 'ming', latencyLabel: '慢约 1 秒', gender: 'female' },
        { id: 'ming:UK_George', name: 'George', tags: ['男', 'Ming'], kind: 'ming', latencyLabel: '慢约 1 秒', gender: 'male' },
        { id: 'system:Yuna', name: 'Yuna', tags: ['女', '本机'], kind: 'system', latencyLabel: '最快', gender: 'female' },
      ];
    case 'es':
    case 'fr':
    case 'de':
    case 'pt':
      return [
        { id: 'ming:US_Emma', name: 'Emma', tags: ['女', 'Ming'], kind: 'ming', latencyLabel: '慢约 1 秒', gender: 'female' },
        { id: 'ming:UK_George', name: 'George', tags: ['男', 'Ming'], kind: 'ming', latencyLabel: '慢约 1 秒', gender: 'male' },
        { id: `system:${baseKey}-voice`, name: 'System', tags: ['本机'], kind: 'system', latencyLabel: '最快' },
      ];
    case 'en':
    default:
      return [
        { id: 'ming:US_Emma', name: 'Emma', tags: ['女', '美式', 'Ming'], kind: 'ming', latencyLabel: '慢约 1 秒', gender: 'female' },
        { id: 'ming:UK_George', name: 'George', tags: ['男', '英式', 'Ming'], kind: 'ming', latencyLabel: '慢约 1 秒', gender: 'male' },
        { id: 'ming:UK_Charlotte', name: 'Charlotte', tags: ['女', '英式', 'Ming'], kind: 'ming', latencyLabel: '慢约 1 秒', gender: 'female' },
        { id: 'system:Samantha', name: 'Samantha', tags: ['女', '本机'], kind: 'system', latencyLabel: '最快', gender: 'female' },
        { id: 'system:Daniel', name: 'Daniel', tags: ['男', '本机'], kind: 'system', latencyLabel: '最快', gender: 'male' },
      ];
  }
}

export interface VoiceCloneData {
  audioBase64?: string;
  audioBlobUrl?: string;
  durationSeconds: number;
  recordedText?: string;
  createdAt: number;
}

interface SpeakState {
  speakEnabled: boolean; // "把我说的翻译给对方"
  speakShortcut: string; // e.g. "RightOption" (displays as "右 ⌥") or "Space"
  speakTo: string; // "room" (跟随对方) or language code e.g. "en", "zh"
  speakVoices: Record<string, string>; // langKey -> voiceId, e.g. { en: "ming:US_Emma", zh: "ming:灵小雅" }
  voiceClone: VoiceCloneData | null;
  previewingVoiceId: string | null;
  activeLanguageTab: string; // Language currently selected in voice picker

  // Actions
  setSpeakEnabled: (enabled: boolean) => void;
  setSpeakShortcut: (shortcut: string) => void;
  setSpeakTo: (speakTo: string) => void;
  setVoiceForLanguage: (langKey: string, voiceId: string) => void;
  setActiveLanguageTab: (langKey: string) => void;
  setVoiceClone: (data: VoiceCloneData | null) => void;
  deleteVoiceClone: () => void;
  setPreviewingVoiceId: (id: string | null) => void;
  playVoicePreview: (voiceId: string, langKey: string) => Promise<void>;
  stopVoicePreview: () => void;
  speakVirtualMicText: (text: string, langKey?: string) => Promise<boolean>;
  testVirtualMic: () => Promise<boolean>;
}

const STORAGE_KEY_ENABLED = 'mao_speak_enabled';
const STORAGE_KEY_SHORTCUT = 'mao_speak_shortcut';
const STORAGE_KEY_SPEAK_TO = 'mao_speak_to';
const STORAGE_KEY_VOICES = 'mao_speak_voices';
const STORAGE_KEY_CLONE = 'mao_speak_voice_clone';

function loadInitialState(): {
  speakEnabled: boolean;
  speakShortcut: string;
  speakTo: string;
  speakVoices: Record<string, string>;
  voiceClone: VoiceCloneData | null;
} {
  let speakEnabled = true;
  let speakShortcut = 'RightOption';
  let speakTo = 'room';
  let speakVoices: Record<string, string> = {
    en: 'system:Samantha',
    zh: 'system:Ting-Ting',
    ja: 'system:Kyoko',
    ko: 'system:Yuna',
  };
  let voiceClone: VoiceCloneData | null = null;

  try {
    const savedEnabled = localStorage.getItem(STORAGE_KEY_ENABLED);
    if (savedEnabled !== null) speakEnabled = savedEnabled === 'true';

    const savedShortcut = localStorage.getItem(STORAGE_KEY_SHORTCUT);
    if (savedShortcut) speakShortcut = savedShortcut;

    const savedSpeakTo = localStorage.getItem(STORAGE_KEY_SPEAK_TO);
    if (savedSpeakTo) speakTo = savedSpeakTo;

    const savedVoices = localStorage.getItem(STORAGE_KEY_VOICES);
    if (savedVoices) speakVoices = { ...speakVoices, ...JSON.parse(savedVoices) };

    const savedClone = localStorage.getItem(STORAGE_KEY_CLONE);
    if (savedClone) voiceClone = JSON.parse(savedClone);
  } catch (err) {
    console.warn('[SpeakStore] Error reading localStorage:', err);
  }

  return { speakEnabled, speakShortcut, speakTo, speakVoices, voiceClone };
}

let activeAudioElement: HTMLAudioElement | null = null;

export const useSpeakStore = create<SpeakState>((set, get) => {
  const initial = loadInitialState();

  return {
    speakEnabled: initial.speakEnabled,
    speakShortcut: initial.speakShortcut,
    speakTo: initial.speakTo,
    speakVoices: initial.speakVoices,
    voiceClone: initial.voiceClone,
    previewingVoiceId: null,
    activeLanguageTab: 'en',

    setSpeakEnabled: (enabled: boolean) => {
      set({ speakEnabled: enabled });
      try {
        localStorage.setItem(STORAGE_KEY_ENABLED, String(enabled));
      } catch {}
    },

    setSpeakShortcut: (shortcut: string) => {
      set({ speakShortcut: shortcut });
      try {
        localStorage.setItem(STORAGE_KEY_SHORTCUT, shortcut);
      } catch {}
    },

    setSpeakTo: (speakTo: string) => {
      set({ speakTo });
      try {
        localStorage.setItem(STORAGE_KEY_SPEAK_TO, speakTo);
      } catch {}
    },

    setVoiceForLanguage: (langKey: string, voiceId: string) => {
      const baseKey = (langKey || 'en').split('-')[0].toLowerCase();
      const nextVoices = { ...get().speakVoices, [baseKey]: voiceId };
      set({ speakVoices: nextVoices });
      try {
        localStorage.setItem(STORAGE_KEY_VOICES, JSON.stringify(nextVoices));
      } catch {}

      // Keep Ant-Ling provider voice setting in sync with chosen voice
      try {
        const clean = voiceId.replace(/^(system|ming):/, '').trim();
        const settingsStore = (window as any).__sokuji_settings_store?.getState?.();
        if (settingsStore?.updateAntLing) {
          settingsStore.updateAntLing({ voice: clean });
        }
      } catch {}
    },

    setActiveLanguageTab: (langKey: string) => {
      const baseKey = (langKey || 'en').split('-')[0].toLowerCase();
      set({ activeLanguageTab: baseKey });
    },

    setVoiceClone: (data: VoiceCloneData | null) => {
      set({ voiceClone: data });
      try {
        if (data) {
          localStorage.setItem(STORAGE_KEY_CLONE, JSON.stringify(data));
        } else {
          localStorage.removeItem(STORAGE_KEY_CLONE);
        }
      } catch {}
    },

    deleteVoiceClone: () => {
      set({ voiceClone: null });
      try {
        localStorage.removeItem(STORAGE_KEY_CLONE);
      } catch {}
      // If any language was set to clone, reset to default
      const currentVoices = { ...get().speakVoices };
      let changed = false;
      Object.entries(currentVoices).forEach(([k, v]) => {
        if (v === 'clone') {
          const opts = getVoiceOptionsForLanguage(k);
          currentVoices[k] = opts[0]?.id || 'system:default';
          changed = true;
        }
      });
      if (changed) {
        set({ speakVoices: currentVoices });
        try {
          localStorage.setItem(STORAGE_KEY_VOICES, JSON.stringify(currentVoices));
        } catch {}
      }
    },

    setPreviewingVoiceId: (id: string | null) => {
      set({ previewingVoiceId: id });
    },

    stopVoicePreview: () => {
      if (activeAudioElement) {
        try {
          activeAudioElement.pause();
          activeAudioElement.currentTime = 0;
        } catch {}
        activeAudioElement = null;
      }
      stopSpeaking();
      set({ previewingVoiceId: null });
    },

    playVoicePreview: async (voiceId: string, langKey: string) => {
      const { stopVoicePreview } = get();
      stopVoicePreview();

      set({ previewingVoiceId: voiceId });

      const baseKey = (langKey || 'en').split('-')[0].toLowerCase();
      const langMeta = SUPPORTED_SPEAK_LANGUAGES.find((l) => l.key === baseKey) || SUPPORTED_SPEAK_LANGUAGES[0];
      const textToSpeak = langMeta.sample;

      try {
        // Clone voice preview:
        if (voiceId === 'clone') {
          const clone = get().voiceClone;
          if (clone?.audioBlobUrl || clone?.audioBase64) {
            const audioSrc = clone.audioBlobUrl || clone.audioBase64!;
            const audio = new Audio(audioSrc);
            activeAudioElement = audio;
            audio.onended = () => set({ previewingVoiceId: null });
            audio.onerror = () => set({ previewingVoiceId: null });
            await audio.play();
            return;
          }
        }

        // Ming voice preview via Ling TTS:
        if (voiceId.startsWith('ming:')) {
          const mingVoiceName = voiceId.slice(5); // e.g. "US_Emma", "灵小雅"

          // Resolve Ling API key (from localStorage, openaiCompatible settings, or fallback)
          let lingKey = '';
          try {
            const rawStored = localStorage.getItem('ling_api_key');
            if (rawStored) lingKey = rawStored;
            if (!lingKey) {
              const settingsState = (window as unknown as { __sokuji_settings_store?: { getState: () => { antLing?: { apiKey?: string }; openaiCompatible?: { apiKey?: string; apiHost?: string } } } })
                .__sokuji_settings_store?.getState?.();
              if (settingsState?.antLing?.apiKey) {
                lingKey = settingsState.antLing.apiKey;
              } else if (settingsState?.openaiCompatible?.apiKey) {
                lingKey = settingsState.openaiCompatible.apiKey;
              }
            }
          } catch {}

          if (!lingKey) {
            // Default studio key if user has one configured locally
            lingKey = 'sk-studio-8e6cffe1bce9454cafde670c526822d4';
          }

          if (lingKey) {
            try {
              const response = await fetch('https://api.ant-ling.com/v1/audio/speech', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${lingKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  model: 'Ming-3.0-tts-0.5B',
                  input: textToSpeak,
                  voice: mingVoiceName,
                  response_format: 'mp3',
                  ...(baseKey !== 'zh' && baseKey !== 'en' ? { language_id: baseKey } : {}),
                }),
              });

              if (response.ok) {
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                activeAudioElement = audio;
                audio.onended = () => {
                  URL.revokeObjectURL(url);
                  set({ previewingVoiceId: null });
                };
                audio.onerror = () => {
                  URL.revokeObjectURL(url);
                  set({ previewingVoiceId: null });
                };
                await audio.play();
                return;
              }
            } catch (netErr) {
              console.warn('[SpeakStore] Ling TTS network preview failed, falling back to local TTS:', netErr);
            }
          }
        }

        // Fallback or System voice preview via natural voice synthesis
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          const success = await speakText(textToSpeak, baseKey, {
            voiceName: voiceId,
            onEnd: () => set({ previewingVoiceId: null }),
            onError: () => set({ previewingVoiceId: null }),
          });
          if (success) return;
        }

        set({ previewingVoiceId: null });
      } catch (err) {
        console.error('[SpeakStore] Error playing voice preview:', err);
        set({ previewingVoiceId: null });
      }
    },

    speakVirtualMicText: async (text: string, langKey?: string) => {
      if (!text || !text.trim()) return false;
      const state = get();
      if (!state.speakEnabled) return false;

      const targetLang = langKey || (state.speakTo === 'room' ? 'en' : state.speakTo);
      const baseKey = (targetLang || 'en').split('-')[0].toLowerCase();
      const voiceId = state.speakVoices[baseKey] || (baseKey === 'zh' ? 'ming:灵小雅' : 'ming:UK_George');

      if (typeof window !== 'undefined' && (window as any).electron?.invoke) {
        // 1. High-fidelity neural Ming TTS path into virtual microphone
        if (voiceId.startsWith('ming:')) {
          try {
            const mingVoiceName = voiceId.slice(5);
            let lingKey = 'sk-studio-8e6cffe1bce9454cafde670c526822d4';
            try {
              const rawStored = localStorage.getItem('ling_api_key');
              if (rawStored) lingKey = rawStored;
              const settingsState = (window as unknown as { __sokuji_settings_store?: { getState: () => { antLing?: { apiKey?: string } } } })
                .__sokuji_settings_store?.getState?.();
              if (settingsState?.antLing?.apiKey) {
                lingKey = settingsState.antLing.apiKey;
              }
            } catch {}

            const response = await fetch('https://api.ant-ling.com/v1/audio/speech', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${lingKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: 'Ming-3.0-tts-0.5B',
                input: text.trim(),
                voice: mingVoiceName,
                response_format: 'wav',
                ...(baseKey !== 'zh' && baseKey !== 'en' ? { language_id: baseKey } : {}),
              }),
            });

            if (response.ok) {
              const arrayBuffer = await response.arrayBuffer();
              const bytes = new Uint8Array(arrayBuffer);
              let binary = '';
              const len = bytes.byteLength;
              for (let i = 0; i < len; i++) {
                binary += String.fromCharCode(bytes[i]);
              }
              const base64 = window.btoa(binary);

              const res = await (window as any).electron.invoke('play-file-to-virtual-mic', {
                base64,
                ext: 'wav',
              });
              if (res?.ok) return true;
            }
          } catch (mingErr) {
            console.warn('[SpeakStore] Ming neural TTS to virtual mic failed, falling back to system speech:', mingErr);
          }
        }

        // 2. Local system speech synthesis fallback
        try {
          let cleanVoice = voiceId.replace(/^(system|ming):/, '').trim();
          if (cleanVoice === 'US_Emma' || cleanVoice === 'UK_Charlotte') cleanVoice = 'Samantha';
          else if (cleanVoice === 'UK_George') cleanVoice = 'Daniel';
          else if (cleanVoice.startsWith('灵')) cleanVoice = 'Ting-Ting';

          const res = await (window as any).electron.invoke('speak-to-virtual-mic', {
            text: text.trim(),
            lang: targetLang,
            voice: cleanVoice,
          });
          return res?.ok ?? true;
        } catch (err) {
          console.error('[SpeakStore] Failed to speak to virtual mic:', err);
          return false;
        }
      }
      return false;
    },

    testVirtualMic: async () => {
      if (typeof window !== 'undefined' && (window as any).electron?.invoke) {
        try {
          const res = await (window as any).electron.invoke('test-virtual-mic');
          return res?.ok ?? true;
        } catch (e) {
          console.error('[SpeakStore] testVirtualMic error:', e);
          return false;
        }
      }
      return false;
    },
  };
});
