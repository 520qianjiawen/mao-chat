// src/components/MainPanel/CicadaMainDetail.tsx
import React, { useState, useEffect, useRef } from 'react';
import { Download, Columns, Copy, Check, FileText, Mic, Monitor, ArrowLeftRight, Minus, Maximize2, AlertCircle, X } from 'lucide-react';
import { useMeetingStore } from '../../stores/meetingStore';
import { formatClock, formatSessionDuration } from '../../types/meeting';
import NotesContentView from '../Notes/NotesContentView';
import CicadaTranscriptView from '../Transcript/CicadaTranscriptView';
import LanguagePairPicker from '../LanguagePairPicker/LanguagePairPicker';
import useSessionStore from '../../stores/sessionStore';
import useAudioStore, { useMode } from '../../stores/audioStore';
import { useCurrentTurnDetectionMode, useSetCurrentTurnDetectionMode } from '../../stores/settingsStore';
import { useSpeakStore } from '../../stores/speakStore';
import './CicadaMainDetail.scss';

const formatShortcutKey = (key: string) => {
  if (key === 'RightOption' || key === 'AltRight') return '右 ⌥';
  if (key === 'Space') return '空格';
  if (key === 'MetaRight') return '右 ⌘';
  return key;
};

const SplitColumnsIcon: React.FC<{ filled?: boolean }> = ({ filled }) => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
    <rect x="2" y="3" width="12" height="10" rx="2" fill={filled ? 'currentColor' : 'none'} fillOpacity={filled ? 0.15 : 0} />
    <line x1="8" y1="3" x2="8" y2="13" />
  </svg>
);

export const CicadaMainDetail: React.FC = () => {
  const sessions = useMeetingStore((s) => s.sessions);
  const selectedSessionId = useMeetingStore((s) => s.selectedSessionId);
  const activeSessionId = useMeetingStore((s) => s.activeSessionId);
  const currentTab = useMeetingStore((s) => s.currentTab);
  const transcriptViewMode = useMeetingStore((s) => s.transcriptViewMode);
  const showQuotesSideBySide = useMeetingStore((s) => s.showQuotesSideBySide);
  const freshPoints = useMeetingStore((s) => s.freshPoints);
  const setTab = useMeetingStore((s) => s.setTab);
  const setTranscriptViewMode = useMeetingStore((s) => s.setTranscriptViewMode);
  const setShowQuotesSideBySide = useMeetingStore((s) => s.setShowQuotesSideBySide);
  const renameSession = useMeetingStore((s) => s.renameSession);

  const sessionStartTime = useSessionStore((s) => s.sessionStartTime);
  const items = useSessionStore((s) => s.items);
  const participantItems = useSessionStore((s) => s.participantItems);
  const requestSessionStop = useSessionStore((s) => s.requestSessionStop);

  const mode = useMode();
  const setMode = useAudioStore((s) => s.setMode);

  const currentTurnDetectionMode = useCurrentTurnDetectionMode();
  const setTurnDetectionMode = useSetCurrentTurnDetectionMode();
  const speakShortcut = useSpeakStore((s) => s.speakShortcut);
  const isPttActive = currentTurnDetectionMode === 'Push-to-Talk' || currentTurnDetectionMode === 'Disabled';

  // Layout mode: 'card' (compact card) vs 'normal' (standard full window)
  const [isCardMode, setIsCardMode] = useState(false);

  // Selected session
  const currentSession = sessions.find((s) => s.id === (selectedSessionId || sessions[0]?.id));
  const isLive = Boolean(currentSession && currentSession.id === activeSessionId);

  // Editable title state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Export menu popover state
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Live timer
  const [liveElapsed, setLiveElapsed] = useState(0);
  useEffect(() => {
    if (!isLive || !sessionStartTime) {
      setLiveElapsed(0);
      return;
    }
    const update = () => {
      setLiveElapsed(Math.max(0, Math.floor((Date.now() - sessionStartTime) / 1000)));
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [isLive, sessionStartTime]);

  const lastError = items.slice().reverse().find((it) => it.type === 'error');

  if (!currentSession) {
    return (
      <div className="cicada-main-detail cicada-main-detail--empty">
        <div className="cicada-main-detail__empty-container">
          {lastError && (
            <div className="cicada-main-detail__error-card" role="alert">
              <AlertCircle size={20} className="error-icon" />
              <div className="error-text">
                <div className="error-title">无法启动会议</div>
                <div className="error-desc">{lastError.formatted?.text || '启动会议遇到错误，请检查网络或设置'}</div>
              </div>
              <button
                type="button"
                className="error-close"
                onClick={() => useSessionStore.getState().setItems([])}
                title="关闭"
              >
                <X size={15} />
              </button>
            </div>
          )}
          <div className="cicada-main-detail__empty-card">
            <div className="cicada-main-detail__empty-icon">
              <Mic size={32} />
            </div>
            <h3 className="cicada-main-detail__empty-title">暂无会议记录</h3>
            <p className="cicada-main-detail__empty-desc">
              请从左侧选择会议，或点击上方导航栏“开始听 (⌘R)”开启实时纪要
            </p>
          </div>
        </div>
      </div>
    );
  }

  const lines = currentSession.lines || [];
  const notes = currentSession.notes || {
    summary: '',
    topics: [],
    conclusions: [],
    todos: [],
    terms: [],
    covered: 0,
    final: false,
  };

  // Find live streaming line from sessionStore
  const liveItem = [...items, ...participantItems].find((it) => it.status === 'in_progress');
  const liveSrc = liveItem?.formatted?.transcript || liveItem?.formatted?.text || '';
  const liveDst = liveItem?.formatted?.text || '';

  const handleTitleSubmit = () => {
    if (titleDraft.trim() && currentSession) {
      renameSession(currentSession.id, titleDraft.trim());
    }
    setIsEditingTitle(false);
  };

  const handleExportMarkdown = (copyOnly = false) => {
    let md = `# ${currentSession.title}\n\n`;
    md += `*时间: ${new Date(currentSession.startedAt).toLocaleString()} · 时长: ${formatSessionDuration(currentSession.duration)}*\n\n`;

    if (notes.summary) {
      md += `## 总结\n\n${notes.summary}\n\n`;
    }

    if (notes.topics.length > 0) {
      md += `## 议题\n\n`;
      notes.topics.forEach((t) => {
        md += `### ${formatClock(t.start)} ${t.title}\n`;
        if (t.summary) md += `${t.summary}\n\n`;
        t.points.forEach((p, idx) => {
          const pt = t.pointTimes?.[idx];
          md += `- ${p} ${pt !== null && pt !== undefined ? `(${formatClock(pt)})` : ''}\n`;
        });
        md += `\n`;
      });
    }

    if (notes.conclusions.length > 0) {
      md += `## 结论\n\n`;
      notes.conclusions.forEach((c) => {
        md += `- ${c.text}\n`;
      });
      md += `\n`;
    }

    if (notes.todos.length > 0) {
      md += `## 待办事项\n\n`;
      notes.todos.forEach((td) => {
        md += `- [ ] ${td.text} ${td.owner ? `(@${td.owner})` : ''}\n`;
      });
      md += `\n`;
    }

    md += `## 文字记录\n\n`;
    lines.forEach((l) => {
      md += `**[${formatClock(l.t)}] ${l.speaker === 'me' ? '你' : '对方'}:**\n`;
      if (l.src) md += `${l.src}\n`;
      if (l.dst && l.dst !== l.src) md += `*${l.dst}*\n`;
      md += `\n`;
    });

    if (copyOnly) {
      void navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      setExportMenuOpen(false);
    } else {
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentSession.title}.md`;
      a.click();
      URL.revokeObjectURL(url);
      setExportMenuOpen(false);
    }
  };

  return (
    <div className="cicada-main-detail">
      {/* Header */}
      <header className="cicada-main-detail__header">
        {/* Top Control Bar: Title on left, [EN -> 中] [结束] [◫] [—] on right */}
        <div className="cicada-main-detail__top-bar">
          <div className="cicada-main-detail__title-container">
            {isEditingTitle ? (
              <input
                ref={titleInputRef}
                type="text"
                className="cicada-main-detail__title-input"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={handleTitleSubmit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleTitleSubmit();
                  if (e.key === 'Escape') setIsEditingTitle(false);
                }}
                autoFocus
              />
            ) : (
              <div
                className="cicada-main-detail__title-wrapper"
                onClick={() => {
                  setTitleDraft(currentSession.title);
                  setIsEditingTitle(true);
                }}
                title="点击修改会议标题"
              >
                <h1 className="cicada-main-detail__title">
                  {isLive ? '实时纪要' : '会议纪要'}
                </h1>
                <span className="cicada-main-detail__subtitle">
                  {currentSession.title}
                </span>
              </div>
            )}
          </div>

          <div className="cicada-main-detail__top-actions">
            {/* Language Chip: EN -> 中 */}
            <div className="cicada-lang-chip" title="语言切换">
              <LanguagePairPicker variant="footer" showSettingsButton={false} />
            </div>

            {/* End Meeting Button (Shown while Live) */}
            {isLive && (
              <button
                type="button"
                className="cicada-top-end-btn"
                onClick={() => requestSessionStop()}
                title="结束这场会议"
              >
                结束
              </button>
            )}

            {/* ◫ Dual-column / Side-by-side Layout Toggle Button */}
            <button
              type="button"
              className={`cicada-header-icon-btn ${showQuotesSideBySide ? 'is-active' : ''}`}
              onClick={() => {
                setShowQuotesSideBySide(!showQuotesSideBySide);
                if (isCardMode) setIsCardMode(false);
              }}
              title={showQuotesSideBySide ? '收窄单栏' : '纪要和原话并排 (◫)'}
              aria-label={showQuotesSideBySide ? '收窄单栏' : '纪要和原话并排'}
            >
              <SplitColumnsIcon filled={showQuotesSideBySide} />
            </button>

            {/* — Compact Card Mode Toggle Button */}
            <button
              type="button"
              className={`cicada-header-icon-btn ${isCardMode ? 'is-active' : ''}`}
              onClick={() => {
                setIsCardMode(!isCardMode);
                if (showQuotesSideBySide) setShowQuotesSideBySide(false);
              }}
              title={isCardMode ? '展开全貌' : '收成小卡 (—)'}
              aria-label={isCardMode ? '展开全貌' : '收成小卡'}
            >
              {isCardMode ? <Maximize2 size={13} /> : <Minus size={15} />}
            </button>
          </div>
        </div>

        {/* Second Row: Live status info + audio source switch */}
        <div className="cicada-main-detail__meta-row">
          <div className="cicada-main-detail__meta-left">
            {isLive ? (
              <span className="cicada-main-detail__live-status">
                <span className="live-dot" />
                正在记录 · {formatClock(liveElapsed)} · {lines.length} 句
                {notes.covered > 0 && ` · 纪要已更新至 ${formatClock(notes.topics[notes.topics.length - 1]?.start || 0)}`}
              </span>
            ) : (
              <span className="cicada-main-detail__history-meta">
                {new Date(currentSession.startedAt).toLocaleDateString([], {
                  month: 'short',
                  day: 'numeric',
                })}{' '}
                {new Date(currentSession.startedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                · {formatSessionDuration(currentSession.duration)}
                {notes.final && ' · 完整版纪要'}
              </span>
            )}
          </div>
          <div className="cicada-main-detail__meta-right">
            <div className="cicada-mode-toggle" role="group" aria-label="音频来源">
              <button
                type="button"
                className={`cicada-mode-btn ${mode === 'participant' ? 'is-active' : ''}`}
                onClick={() => setMode('participant')}
                title="只听对方（系统/浏览器声音）"
              >
                <Monitor size={12} />
                <span>系统声音</span>
              </button>
              <button
                type="button"
                className={`cicada-mode-btn ${mode === 'speaker' ? 'is-active' : ''}`}
                onClick={() => setMode('speaker')}
                title="只听自己（麦克风）"
              >
                <Mic size={12} />
                <span>麦克风</span>
              </button>
              <button
                type="button"
                className={`cicada-mode-btn ${mode === 'both' ? 'is-active' : ''}`}
                onClick={() => setMode('both')}
                title="双向翻译（自己 + 对方）"
              >
                <ArrowLeftRight size={12} />
                <span>双向</span>
              </button>
            </div>

            {mode !== 'participant' && (
              <div className="cicada-speech-toggle" role="group" aria-label="说话收音方式">
                <button
                  type="button"
                  className={`cicada-speech-btn ${!isPttActive ? 'is-active' : ''}`}
                  onClick={() => setTurnDetectionMode('Auto')}
                  disabled={isLive}
                  title={isLive ? '会议进行中锁定，停止后可切换' : '自动收音：随时说话自动检测'}
                >
                  自动收音
                </button>
                <button
                  type="button"
                  className={`cicada-speech-btn ${isPttActive ? 'is-active' : ''}`}
                  onClick={() => setTurnDetectionMode('Push-to-Talk')}
                  disabled={isLive}
                  title={isLive ? '会议进行中锁定，停止后可切换' : '按住说话：防杂音乱翻译，按住快捷键才收音'}
                >
                  按住说话 ({formatShortcutKey(speakShortcut)})
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Push-to-Talk live banner */}
        {isLive && isPttActive && mode !== 'participant' && (
          <div className="cicada-ptt-hint-banner" role="status">
            <Mic size={14} />
            <span>按住说话已生效：平时麦克风静音，请按住键盘【{formatShortcutKey(speakShortcut)}】或【空格键】说话，松开后自动翻译并传到虚拟麦克风。</span>
          </div>
        )}

        {/* Third Row: Segmented Switcher [ 纪要 ] [ 文字记录 · N ] (when not wide and not card mode) */}
        {!showQuotesSideBySide && !isCardMode && (
          <div className="cicada-main-detail__segmented-row">
            <div className="cicada-segmented-pill">
              <button
                type="button"
                className={`cicada-segmented-pill__btn ${currentTab === 'notes' ? 'is-active' : ''}`}
                onClick={() => setTab('notes')}
              >
                纪要
              </button>
              <button
                type="button"
                className={`cicada-segmented-pill__btn ${currentTab === 'transcript' ? 'is-active' : ''}`}
                onClick={() => setTab('transcript')}
              >
                文字记录
                {lines.length > 0 && (
                  <span className="cicada-segmented-count">{lines.length}</span>
                )}
              </button>
            </div>

            <div className="cicada-main-detail__filter-actions">
              {currentTab === 'transcript' && (
                <div className="cicada-segments">
                  <button
                    type="button"
                    className={`cicada-segment-btn ${
                      transcriptViewMode === 'both' ? 'is-active' : ''
                    }`}
                    onClick={() => setTranscriptViewMode('both')}
                  >
                    双语
                  </button>
                  <button
                    type="button"
                    className={`cicada-segment-btn ${
                      transcriptViewMode === 'src' ? 'is-active' : ''
                    }`}
                    onClick={() => setTranscriptViewMode('src')}
                  >
                    原文
                  </button>
                  <button
                    type="button"
                    className={`cicada-segment-btn ${
                      transcriptViewMode === 'dst' ? 'is-active' : ''
                    }`}
                    onClick={() => setTranscriptViewMode('dst')}
                  >
                    译文
                  </button>
                </div>
              )}

              {/* Export Dropdown */}
              <div className="cicada-export-wrapper">
                <button
                  type="button"
                  className="cicada-export-btn"
                  onClick={() => setExportMenuOpen(!exportMenuOpen)}
                >
                  <span>导出...</span>
                </button>

                {exportMenuOpen && (
                  <div className="cicada-export-menu">
                    <button
                      type="button"
                      onClick={() => handleExportMarkdown(true)}
                    >
                      {copied ? <Check size={13} /> : <Copy size={13} />}
                      <span>{copied ? '已复制！' : '复制为 Markdown'}</span>
                    </button>
                    <div className="cicada-export-menu__divider" />
                    <button
                      type="button"
                      onClick={() => handleExportMarkdown(false)}
                    >
                      <Download size={13} />
                      <span>导出 Markdown (.md)</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Main Content Area */}
      <div className="cicada-main-detail__body">
        {lastError && (
          <div className="cicada-main-detail__error-card" role="alert" style={{ margin: '16px 32px 0 32px' }}>
            <AlertCircle size={20} className="error-icon" />
            <div className="error-text">
              <div className="error-title">会议连接错误</div>
              <div className="error-desc">{lastError.formatted?.text || '启动会议遇到错误，请检查网络或设置'}</div>
            </div>
            <button
              type="button"
              className="error-close"
              onClick={() => useSessionStore.getState().setItems([])}
              title="关闭"
            >
              <X size={15} />
            </button>
          </div>
        )}
        {isCardMode ? (
          <div className="cicada-card-mode-view">
            <div className="cicada-card-mode-card">
              <div className="cicada-card-mode-header">
                <span className="cicada-card-badge">
                  {notes.final ? '完整版' : '速记版'}
                </span>
                <span className="cicada-card-timer">
                  已记录 {formatClock(liveElapsed)}
                </span>
                <button
                  type="button"
                  className="cicada-card-expand-btn"
                  onClick={() => setIsCardMode(false)}
                >
                  展开全貌
                </button>
              </div>
              {notes.summary ? (
                <p className="cicada-card-summary">{notes.summary}</p>
              ) : (
                <p className="cicada-card-placeholder">正在聆听发言并整理纪要…</p>
              )}
              {notes.topics.length > 0 && (
                <div className="cicada-card-current-topic">
                  <h5>{notes.topics[notes.topics.length - 1].title}</h5>
                  <ul>
                    {notes.topics[notes.topics.length - 1].points.slice(0, 3).map((p, idx) => (
                      <li key={idx}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            {isLive && (liveSrc || liveDst) && (
              <div className="cicada-card-live-caption">
                {liveSrc && <div className="caption-src">{liveSrc}</div>}
                {liveDst && <div className="caption-dst">{liveDst}</div>}
              </div>
            )}
          </div>
        ) : showQuotesSideBySide ? (
          <div className="cicada-main-detail__side-by-side">
            <div className="cicada-side-col cicada-side-col--notes">
              <NotesContentView
                notes={notes}
                isLive={isLive}
                freshPoints={freshPoints}
                totalLinesCount={lines.length}
                elapsedSeconds={liveElapsed}
              />
            </div>
            <div className="cicada-side-divider" />
            <div className="cicada-side-col cicada-side-col--transcript">
              <CicadaTranscriptView
                lines={lines}
                isLive={isLive}
                viewMode={transcriptViewMode}
                liveSource={liveSrc}
                liveTranslation={liveDst}
              />
            </div>
          </div>
        ) : currentTab === 'notes' ? (
          <div className="cicada-main-detail__single-view">
            <NotesContentView
              notes={notes}
              isLive={isLive}
              freshPoints={freshPoints}
              totalLinesCount={lines.length}
              elapsedSeconds={liveElapsed}
            />
          </div>
        ) : (
          <div className="cicada-main-detail__single-view">
            <CicadaTranscriptView
              lines={lines}
              isLive={isLive}
              viewMode={transcriptViewMode}
              liveSource={liveSrc}
              liveTranslation={liveDst}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default CicadaMainDetail;
