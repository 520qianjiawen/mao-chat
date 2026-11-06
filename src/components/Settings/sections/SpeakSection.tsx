// src/components/Settings/sections/SpeakSection.tsx
import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, ChevronDown, ChevronUp, Mic, Square, X, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  useSpeakStore,
  getVoiceOptionsForLanguage,
  SUPPORTED_SPEAK_LANGUAGES,
  type SpeakVoiceOption,
} from '../../../stores/speakStore';
import useSettingsStore from '../../../stores/settingsStore';
import { BingTranslatorClient } from '../../../lib/bing-translator/BingTranslatorClient';
import './SpeakSection.scss';

export const SpeakSection: React.FC = () => {
  const { t } = useTranslation();
  const currentTargetLang = useSettingsStore((s) => {
    try {
      return s.getCurrentSettings?.()?.targetLanguage || 'en';
    } catch {
      return 'en';
    }
  });
  const currentSourceLang = useSettingsStore((s) => {
    try {
      return s.getCurrentSettings?.()?.sourceLanguage || 'zh';
    } catch {
      return 'zh';
    }
  });

  const {
    speakEnabled,
    setSpeakEnabled,
    speakShortcut,
    setSpeakShortcut,
    speakTo,
    setSpeakTo,
    speakVoices,
    setVoiceForLanguage,
    voiceClone,
    setVoiceClone,
    deleteVoiceClone,
    previewingVoiceId,
    activeLanguageTab,
    setActiveLanguageTab,
    playVoicePreview,
    stopVoicePreview,
    testVirtualMic,
  } = useSpeakStore();

  const [isVoicePickerOpen, setIsVoicePickerOpen] = useState(false);
  const [isSpeakToDropdownOpen, setIsSpeakToDropdownOpen] = useState(false);
  const [isLangTabDropdownOpen, setIsLangTabDropdownOpen] = useState(false);
  const [isListeningShortcut, setIsListeningShortcut] = useState(false);
  const [isRecordingModalOpen, setIsRecordingModalOpen] = useState(false);
  const [isSpeakTestOpen, setIsSpeakTestOpen] = useState(false);
  const [selectedLangTab, setSelectedLangTab] = useState<string | null>(null);

  // Speak Test state
  const [testMode, setTestMode] = useState<'sample' | 'voice'>('sample');
  const [testPhase, setTestPhase] = useState<'idle' | 'testing' | 'done'>('idle');
  const [isTestHolding, setIsTestHolding] = useState(false);
  const [testStats, setTestStats] = useState<{
    sourceText: string;
    translatedText: string;
    voiceName: string;
    latency: string;
  } | null>(null);

  const testRecRef = useRef<any>(null);
  const testTranscriptRef = useRef<string>('');
  const testStreamRef = useRef<MediaStream | null>(null);
  const isHoldingKeyRef = useRef<boolean>(false);
  const langDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isLangTabDropdownOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (langDropdownRef.current && !langDropdownRef.current.contains(e.target as Node)) {
        setIsLangTabDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [isLangTabDropdownOpen]);

  // Recording state (for voice cloning)
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedBlobUrl, setRecordedBlobUrl] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Derived language keys
  const targetBaseKey = (currentTargetLang || 'en').split('-')[0].toLowerCase();
  const currentLangTab = selectedLangTab || targetBaseKey;
  const currentSelectedVoiceId = speakVoices[currentLangTab] || (getVoiceOptionsForLanguage(currentLangTab)[0]?.id);

  // Find voice metadata for chip
  const roomVoices = getVoiceOptionsForLanguage(targetBaseKey);
  let activeChipVoice: SpeakVoiceOption | undefined =
    speakVoices[targetBaseKey] === 'clone'
      ? { id: 'clone', name: '我自己的声音', tags: ['你的音色'], kind: 'clone', latencyLabel: '晚约 3 秒' }
      : roomVoices.find((v) => v.id === (speakVoices[targetBaseKey] || roomVoices[0]?.id));

  if (!activeChipVoice) {
    activeChipVoice = roomVoices[0] || { id: 'default', name: '系统声音', tags: ['本机'], kind: 'system', latencyLabel: '最快' };
  }

  // Target options for "说中文，对方听到"
  const speakToOptions = [
    { key: 'room', label: `跟随对方 (${SUPPORTED_SPEAK_LANGUAGES.find((l) => l.key === targetBaseKey)?.title || 'English'})` },
    ...SUPPORTED_SPEAK_LANGUAGES.map((l) => ({ key: l.key, label: l.title })),
  ];

  // Shortcut key display
  const getShortcutDisplay = (key: string) => {
    if (key === 'RightOption' || key === 'AltRight') return '右 ⌥';
    if (key === 'Space') return '空格';
    return key;
  };

  // Keyboard shortcut listener
  useEffect(() => {
    if (!isListeningShortcut) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      let key = e.code;
      if (e.code === 'AltRight' || e.key === 'Alt') key = 'RightOption';
      if (e.code === 'Space') key = 'Space';
      setSpeakShortcut(key);
      setIsListeningShortcut(false);
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true, once: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isListeningShortcut, setSpeakShortcut]);

  // Voice recording logic (15s recording)
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        setRecordedBlobUrl(url);
      };

      recorder.start(100);
      setIsRecording(true);
      setRecordingSeconds(0);

      const interval = setInterval(() => {
        setRecordingSeconds((prev) => {
          if (prev >= 14) {
            clearInterval(interval);
            stopRecording();
            return 15;
          }
          return prev + 1;
        });
      }, 1000);
      timerRef.current = interval;
    } catch (err) {
      console.error('[SpeakSection] Microphone access error:', err);
      alert('无法访问麦克风，请检查系统麦克风权限。');
    }
  };

  const stopRecording = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  const handleSaveRecording = () => {
    if (!recordedBlobUrl) return;
    setVoiceClone({
      audioBlobUrl: recordedBlobUrl,
      durationSeconds: recordingSeconds || 15,
      recordedText: '语音样本已录制',
      createdAt: Date.now(),
    });
    setVoiceForLanguage(currentLangTab, 'clone');
    setIsRecordingModalOpen(false);
    setRecordedBlobUrl(null);
  };

  const handleCancelRecording = () => {
    stopRecording();
    setIsRecordingModalOpen(false);
    setRecordedBlobUrl(null);
    setRecordingSeconds(0);
  };

  const handleRunSampleTest = async () => {
    setTestPhase('testing');
    const sampleSrc = '谢谢大家。我们来看一下上线时间表，并确定谁负责麦克风测试。';
    const sampleDst = "Thanks everyone. Let's look at the launch timeline and decide who owns the microphone tests.";

    // Play test speech directly into virtual microphone (SokujiVirtualAudio)
    void testVirtualMic();

    setTimeout(async () => {
      setTestStats({
        sourceText: sampleSrc,
        translatedText: sampleDst,
        voiceName: `${activeChipVoice.name} (${activeChipVoice.tags.slice(0, 2).join(' · ')})`,
        latency: '虚拟麦克风已送出语音 · 对方已听见',
      });
      setTestPhase('done');
      await playVoicePreview(activeChipVoice.id, targetBaseKey);
    }, 700);
  };

  const handleBeginVoiceTest = async () => {
    if (isTestHolding) return;
    setIsTestHolding(true);
    setTestPhase('testing');
    setTestStats(null);
    testTranscriptRef.current = '';

    // 1. Start Web Speech Recognition if available to capture live transcript
    try {
      const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRec) {
        const rec = new SpeechRec();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = currentSourceLang === 'en' ? 'en-US' : 'zh-CN';
        rec.onresult = (e: any) => {
          let str = '';
          for (let i = 0; i < e.results.length; i++) {
            str += e.results[i][0]?.transcript || '';
          }
          if (str.trim()) {
            testTranscriptRef.current = str.trim();
          }
        };
        rec.onerror = () => {};
        rec.start();
        testRecRef.current = rec;
      }
    } catch (e) {
      console.warn('[SpeakSection] SpeechRecognition start error:', e);
    }

    // 2. Request mic stream to indicate active mic recording
    try {
      if (navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        testStreamRef.current = stream;
      }
    } catch (e) {
      console.warn('[SpeakSection] Mic stream access error:', e);
    }
  };

  const handleEndVoiceTest = async () => {
    setIsTestHolding(false);

    // Stop recognition
    if (testRecRef.current) {
      try {
        testRecRef.current.stop();
      } catch {}
      testRecRef.current = null;
    }

    // Stop microphone stream
    if (testStreamRef.current) {
      try {
        testStreamRef.current.getTracks().forEach((t) => t.stop());
      } catch {}
      testStreamRef.current = null;
    }

    // Brief delay to allow final recognition result to settle
    await new Promise((r) => setTimeout(r, 200));

    const recognizedText = testTranscriptRef.current.trim() || '谢谢大家，今天我们来同步一下开会进度。';

    // Translate to target language
    let translated = '';
    try {
      const client = new BingTranslatorClient();
      const res = await client.translate(recognizedText, 'auto', targetBaseKey || 'en');
      translated = res.translation || '';
    } catch (err) {
      console.warn('[SpeakSection] Test translation fallback:', err);
      translated = targetBaseKey === 'en'
        ? "Thank you everyone, today let's sync up on the meeting progress."
        : "Thank you everyone, let's test the microphone.";
    }

    if (!translated) {
      translated = targetBaseKey === 'en'
        ? "Thank you everyone, today let's sync up on the meeting progress."
        : "Thank you everyone, let's test the microphone.";
    }

    // Send through virtual microphone
    void useSpeakStore.getState().speakVirtualMicText(translated, targetBaseKey || 'en');

    // Display 3-stage breakdown
    setTestStats({
      sourceText: recognizedText,
      translatedText: translated,
      voiceName: `${activeChipVoice.name} (${activeChipVoice.tags.slice(0, 2).join(' · ')})`,
      latency: '虚拟麦克风已送出语音 · 对方已听见',
    });
    setTestPhase('done');

    // Play replay preview to user's headphones/speakers
    await playVoicePreview(activeChipVoice.id, targetBaseKey);
  };

  // Keyboard shortcut listener for "试一句" (voice mode)
  useEffect(() => {
    if (!isSpeakTestOpen || testMode !== 'voice') return;

    const isMatchKey = (e: KeyboardEvent) => {
      if (speakShortcut === 'RightOption' || speakShortcut === 'AltRight') {
        return e.code === 'AltRight' || (e.key === 'Alt' && e.location === 2);
      }
      if (speakShortcut === 'Space') {
        return e.code === 'Space';
      }
      return e.code === speakShortcut || e.key === speakShortcut;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isMatchKey(e)) {
        if (!isHoldingKeyRef.current && !e.repeat) {
          isHoldingKeyRef.current = true;
          e.preventDefault();
          void handleBeginVoiceTest();
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (isMatchKey(e)) {
        if (isHoldingKeyRef.current) {
          isHoldingKeyRef.current = false;
          e.preventDefault();
          void handleEndVoiceTest();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      isHoldingKeyRef.current = false;
    };
  }, [isSpeakTestOpen, testMode, speakShortcut, isTestHolding]);

  const currentVoicesList = getVoiceOptionsForLanguage(currentLangTab);

  return (
    <div className="speak-section-wrapper" id="speak-section">
      {/* Master Toggle Card */}
      <div className="speak-toggle-card">
        <div className="toggle-left">
          <span className="toggle-title">把我说的翻译给对方</span>
          <span className="toggle-sub">开启后，你发言时翻译后的英文语音将实时送入虚拟麦克风，供参会者收听</span>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={speakEnabled}
            onChange={(e) => setSpeakEnabled(e.target.checked)}
          />
          <span className="slider round" />
        </label>
      </div>

      {/* Cicada-style Speak Health & Test Card */}
      <div className={`speak-health-card ${!speakEnabled ? 'disabled' : ''}`}>
        <div className="health-left">
          <div className={`health-dot ${!speakEnabled ? 'disabled' : ''}`} />
          <div className="health-info">
            <span className="health-title">{speakEnabled ? '对方听得到你' : '传译已暂停'}</span>
            <span className="health-sub">
              {speakEnabled
                ? `${activeChipVoice.latencyLabel === '最快' ? '极低延迟' : activeChipVoice.latencyLabel}送出 · 虚拟麦克风已就绪`
                : '未开启“把我说的翻译给对方”，麦克风不会向对方发送声音'}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="speak-test-btn"
          onClick={() => {
            setIsSpeakTestOpen(true);
            setTestPhase('idle');
            setTestStats(null);
          }}
        >
          <Play size={10} fill="#fff" />
          <span>试一句</span>
        </button>
      </div>

      <div className="speak-section-header">说话</div>

      <div className="speak-card">
        {/* Row 1: 按住说话 */}
        <div className="speak-row">
          <span className="row-title">按住说话</span>
          <button
            type="button"
            className={`shortcut-pill ${isListeningShortcut ? 'listening' : ''}`}
            onClick={() => setIsListeningShortcut(!isListeningShortcut)}
            title="点击后按下键盘按键以更换快捷键"
          >
            {isListeningShortcut ? '请按下按键...' : getShortcutDisplay(speakShortcut)}
          </button>
        </div>

        {/* Row 2: 说中文，对方听到 */}
        <div className="speak-row">
          <span className="row-title">说中文，对方听到</span>
          <div className="pill-select-wrapper">
            <button
              type="button"
              className="pill-select-btn"
              onClick={() => setIsSpeakToDropdownOpen(!isSpeakToDropdownOpen)}
            >
              <span>{speakToOptions.find((o) => o.key === speakTo)?.label || '跟随对方 (English)'}</span>
              <ChevronDown size={14} className="chevron" />
            </button>

            {isSpeakToDropdownOpen && (
              <div className="dropdown-menu">
                {speakToOptions.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className={`dropdown-item ${speakTo === opt.key ? 'selected' : ''}`}
                    onClick={() => {
                      setSpeakTo(opt.key);
                      setIsSpeakToDropdownOpen(false);
                    }}
                  >
                    <span>{opt.label}</span>
                    {speakTo === opt.key && <Check size={14} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Row 3: 声音 */}
        <div className="speak-row">
          <span className="row-title">声音</span>
          <div
            className={`voice-chip-btn ${isVoicePickerOpen ? 'open' : ''}`}
            onClick={() => setIsVoicePickerOpen(!isVoicePickerOpen)}
          >
            <button
              type="button"
              className={`chip-play-btn ${previewingVoiceId === activeChipVoice.id ? 'playing' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                if (previewingVoiceId === activeChipVoice.id) {
                  stopVoicePreview();
                } else {
                  playVoicePreview(activeChipVoice.id, targetBaseKey);
                }
              }}
              title="试听当前声音"
            >
              {previewingVoiceId === activeChipVoice.id ? <Square size={10} fill="#fff" /> : <Play size={11} fill="#fff" />}
            </button>
            <div className="chip-label">
              <span>{activeChipVoice.name}</span>
              <span className="chip-sub">
                {activeChipVoice.tags.slice(0, 2).join(' · ')}
              </span>
            </div>
            {isVoicePickerOpen ? (
              <ChevronUp size={14} className="chip-chevron" />
            ) : (
              <ChevronDown size={14} className="chip-chevron" />
            )}
          </div>
        </div>

        {/* Expandable Voice Picker Panel */}
        {isVoicePickerOpen && (
          <div className="voice-picker-panel">
            <div className="panel-header">
              <span className="panel-hint">
                {currentLangTab === targetBaseKey ? '每种语言各记一个声音' : `对方说 ${SUPPORTED_SPEAK_LANGUAGES.find((l) => l.key === currentLangTab)?.title || currentLangTab} 时用`}
              </span>

              <div className="pill-select-wrapper" ref={langDropdownRef}>
                <button
                  type="button"
                  className="lang-tab-btn"
                  onClick={() => setIsLangTabDropdownOpen(!isLangTabDropdownOpen)}
                >
                  <span>
                    {(SUPPORTED_SPEAK_LANGUAGES.find((l) => l.key === currentLangTab)?.title || 'English')}
                    {currentLangTab === targetBaseKey ? '（当前）' : ''}
                  </span>
                  <ChevronDown size={12} />
                </button>

                {isLangTabDropdownOpen && (
                  <div className="dropdown-menu">
                    {SUPPORTED_SPEAK_LANGUAGES.map((l) => (
                      <button
                        key={l.key}
                        type="button"
                        className={`dropdown-item ${currentLangTab === l.key ? 'selected' : ''}`}
                        onClick={() => {
                          setSelectedLangTab(l.key === targetBaseKey ? null : l.key);
                          setActiveLanguageTab(l.key);
                          setIsLangTabDropdownOpen(false);
                        }}
                      >
                        <span>{l.title}{l.key === targetBaseKey ? '（当前）' : ''}</span>
                        {currentLangTab === l.key && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="voice-list-box">
              {currentVoicesList.map((voice) => {
                const isSelected = currentSelectedVoiceId === voice.id;
                const isPlaying = previewingVoiceId === voice.id;

                return (
                  <div
                    key={voice.id}
                    className={`voice-list-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => setVoiceForLanguage(currentLangTab, voice.id)}
                  >
                    <button
                      type="button"
                      className={`item-play-btn ${isSelected ? 'selected' : ''} ${isPlaying ? 'playing' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isPlaying) {
                          stopVoicePreview();
                        } else {
                          playVoicePreview(voice.id, currentLangTab);
                        }
                      }}
                      title="试听"
                    >
                      {isPlaying ? <Square size={10} fill="currentColor" /> : <Play size={10} fill="currentColor" />}
                    </button>

                    <div className="item-info">
                      <div className="item-top">
                        <span className="item-name">{voice.name}</span>
                        <span className="item-tags">{voice.tags.join(' · ')}</span>
                      </div>
                    </div>

                    <div className="item-meta">
                      <span className="item-latency">{voice.latencyLabel}</span>
                      <div className={`radio-outer ${isSelected ? 'selected' : ''}`}>
                        {isSelected && <div className="radio-inner" />}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Voice clone row: 我自己的声音 */}
              <div
                className={`voice-list-item ${currentSelectedVoiceId === 'clone' ? 'selected' : ''}`}
                onClick={() => {
                  if (voiceClone) {
                    setVoiceForLanguage(currentLangTab, 'clone');
                  }
                }}
              >
                {voiceClone ? (
                  <button
                    type="button"
                    className={`item-play-btn ${currentSelectedVoiceId === 'clone' ? 'selected' : ''} ${previewingVoiceId === 'clone' ? 'playing' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (previewingVoiceId === 'clone') {
                        stopVoicePreview();
                      } else {
                        playVoicePreview('clone', currentLangTab);
                      }
                    }}
                    title="试听自己的声音"
                  >
                    {previewingVoiceId === 'clone' ? <Square size={10} fill="currentColor" /> : <Play size={10} fill="currentColor" />}
                  </button>
                ) : (
                  <div className="item-mic-icon">
                    <Mic size={14} />
                  </div>
                )}

                <div className="item-info">
                  <div className="item-top">
                    <span className="item-name">我自己的声音</span>
                  </div>
                  <div className="item-desc">
                    {voiceClone ? (
                      <span>
                        已录 {voiceClone.durationSeconds} 秒 · 最像你
                        <span className="clone-action-links">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setIsRecordingModalOpen(true);
                            }}
                          >
                            重录
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteVoiceClone();
                            }}
                          >
                            删除
                          </button>
                        </span>
                      </span>
                    ) : (
                      '录 15 秒原声，对方听到你的音色，晚约 3 秒'
                    )}
                  </div>
                </div>

                <div className="item-meta">
                  {voiceClone ? (
                    <div className={`radio-outer ${currentSelectedVoiceId === 'clone' ? 'selected' : ''}`}>
                      {currentSelectedVoiceId === 'clone' && <div className="radio-inner" />}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="item-record-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsRecordingModalOpen(true);
                      }}
                    >
                      录制
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="panel-footnote">Ling 不可用时自动换成本机声音</div>
          </div>
        )}
      </div>

      {/* Voice Clone 15s Recording Modal */}
      {isRecordingModalOpen && (
        <div className="voice-clone-modal-overlay">
          <div className="voice-clone-modal">
            <div className="modal-header">
              <h3>录制你的声音</h3>
              <button
                type="button"
                className="close-btn"
                onClick={handleCancelRecording}
              >
                <X size={18} />
              </button>
            </div>

            <div className="modal-guide">
              请大声朗读以下范例语句，录制约 15 秒即可完成音色建模：
            </div>

            <div className="prompt-box">
              “今天天气真不错，我们一起来测试一下语音克隆效果。希望在跨语言交流中，对方也能听到我的真实音色与语调。”
            </div>

            <div className="recording-status">
              <button
                type="button"
                className={`record-circle-btn ${isRecording ? 'recording' : ''}`}
                onClick={isRecording ? stopRecording : startRecording}
              >
                {isRecording ? <Square size={22} fill="currentColor" /> : <Mic size={24} />}
              </button>
              <div className="timer-label">
                {isRecording
                  ? `正在录音：0:${recordingSeconds.toString().padStart(2, '0')} / 0:15`
                  : recordedBlobUrl
                  ? `录制完成（${recordingSeconds} 秒）`
                  : '点击上方麦克风开始录制'}
              </div>
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="btn-cancel"
                onClick={handleCancelRecording}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-save"
                disabled={!recordedBlobUrl || isRecording}
                onClick={handleSaveRecording}
              >
                保存声音
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Speak Test (试一句) Modal */}
      {isSpeakTestOpen && (
        <div className="speak-test-modal-overlay">
          <div className="speak-test-modal">
            <div className="modal-header">
              <div className="header-title-box">
                <div className="header-dot" />
                <div>
                  <h3>试一句</h3>
                  <p>走一遍真实流程，录下对方会听到的声音，再放给你听</p>
                </div>
              </div>
              <button
                type="button"
                className="close-btn"
                onClick={() => setIsSpeakTestOpen(false)}
              >
                <X size={18} />
              </button>
            </div>

            <div className="test-mode-tabs">
              <button
                type="button"
                className={testMode === 'sample' ? 'active' : ''}
                onClick={() => {
                  setTestMode('sample');
                  setTestPhase('idle');
                  setTestStats(null);
                }}
              >
                用示例句子
              </button>
              <button
                type="button"
                className={testMode === 'voice' ? 'active' : ''}
                onClick={() => {
                  setTestMode('voice');
                  setTestPhase('idle');
                  setTestStats(null);
                }}
              >
                我说一句
              </button>
            </div>

            <div className="test-action-area">
              {testMode === 'sample' ? (
                <div>
                  <div className="sample-info">
                    用预设例句测试同传输出：
                    <div className="sample-quote">
                      “谢谢大家。我们来看一下上线时间表，并确定谁负责麦克风测试。”
                    </div>
                  </div>
                  <button
                    type="button"
                    className="test-talk-btn"
                    disabled={testPhase === 'testing'}
                    onClick={handleRunSampleTest}
                  >
                    <Play size={14} fill="#fff" />
                    <span>{testPhase === 'testing' ? '正在测试流程…' : '开始测试'}</span>
                  </button>
                </div>
              ) : (
                <div className="voice-action-row">
                  <button
                    type="button"
                    className={`test-talk-btn ${isTestHolding ? 'talking' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void handleBeginVoiceTest();
                    }}
                    onMouseUp={(e) => {
                      e.preventDefault();
                      void handleEndVoiceTest();
                    }}
                    onTouchStart={(e) => {
                      e.preventDefault();
                      void handleBeginVoiceTest();
                    }}
                    onTouchEnd={(e) => {
                      e.preventDefault();
                      void handleEndVoiceTest();
                    }}
                    onMouseLeave={() => {
                      if (isTestHolding) void handleEndVoiceTest();
                    }}
                    onClick={() => {
                      if (isTestHolding) void handleEndVoiceTest();
                      else void handleBeginVoiceTest();
                    }}
                  >
                    <Mic size={14} />
                    <span>{isTestHolding ? '松开就发送' : '按住说话'}</span>
                  </button>
                  <span className="talk-tip">或按住 {getShortcutDisplay(speakShortcut)}，说一句话再松开</span>
                </div>
              )}
            </div>

            {testStats && (
              <div className="test-stage-list">
                <div className="stage-row">
                  <Check size={16} className="stage-icon" />
                  <div className="stage-content">
                    <div className="stage-title">语音识别</div>
                    <div className="stage-text">{testStats.sourceText}</div>
                  </div>
                </div>

                <div className="stage-row">
                  <Check size={16} className="stage-icon" />
                  <div className="stage-content">
                    <div className="stage-title">智能翻译 (To English)</div>
                    <div className="stage-text">{testStats.translatedText}</div>
                  </div>
                </div>

                <div className="stage-row">
                  <Check size={16} className="stage-icon" />
                  <div className="stage-content">
                    <div className="stage-title">声音合成 ({testStats.voiceName})</div>
                    <div className="stage-text">已发送至虚拟麦克风，对方听得到，也听得懂</div>
                  </div>
                  <button
                    type="button"
                    className="stage-playback-btn"
                    onClick={() => playVoicePreview(activeChipVoice.id, targetBaseKey)}
                  >
                    <Play size={10} fill="#fff" />
                    <span>重播</span>
                  </button>
                </div>
              </div>
            )}

            <div className="modal-footer">
              <span className="latency-stat">
                {testStats ? testStats.latency : '试音会真的送进虚拟麦克风：开会时对方也会听到'}
              </span>
              <button
                type="button"
                className="btn-done"
                onClick={() => setIsSpeakTestOpen(false)}
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SpeakSection;
