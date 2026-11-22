// src/components/Transcript/CicadaTranscriptView.tsx
import React, { useState, useEffect, useRef } from 'react';
import { ArrowDown, Pencil, Check, X, RotateCcw, Replace } from 'lucide-react';
import type { MeetingTranscriptLine } from '../../types/meeting';
import { formatClock } from '../../types/meeting';
import { useMeetingStore } from '../../stores/meetingStore';
import './CicadaTranscriptView.scss';

interface CicadaTranscriptViewProps {
  sessionId?: string;
  lines: MeetingTranscriptLine[];
  isLive: boolean;
  viewMode?: 'both' | 'src' | 'dst';
  liveSource?: string;
  liveTranslation?: string;
}

export const CicadaTranscriptView: React.FC<CicadaTranscriptViewProps> = ({
  sessionId,
  lines,
  isLive,
  viewMode = 'both',
  liveSource = '',
  liveTranslation = '',
}) => {
  const jumpToTimestamp = useMeetingStore((s) => s.jumpToTimestamp);
  const setJumpToTimestamp = useMeetingStore((s) => s.setJumpToTimestamp);
  const editTranscriptLine = useMeetingStore((s) => s.editTranscriptLine);
  const batchReplaceInSession = useMeetingStore((s) => s.batchReplaceInSession);
  const undoLastTranscriptEdit = useMeetingStore((s) => s.undoLastTranscriptEdit);
  const canUndoTranscriptEdit = useMeetingStore((s) => s.canUndoTranscriptEdit);

  const containerRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string | number, HTMLDivElement>>(new Map());
  const isUserScrolledUpRef = useRef(false);
  const [showScrollBottomPill, setShowScrollBottomPill] = useState(false);

  // Single-line edit state
  const [editingLineId, setEditingLineId] = useState<string | number | null>(null);
  const [editSrcDraft, setEditSrcDraft] = useState('');
  const [editDstDraft, setEditDstDraft] = useState('');

  // Batch find & replace state
  const [batchOpen, setBatchOpen] = useState(false);
  const [findDraft, setFindDraft] = useState('');
  const [replaceDraft, setReplaceDraft] = useState('');
  const [learnWordList, setLearnWordList] = useState(true);
  const [toastMsg, setToastMsg] = useState('');

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 2800);
  };

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isUp = distanceToBottom > 120;
    isUserScrolledUpRef.current = isUp;
    setShowScrollBottomPill(isLive && isUp);
  };

  // Scroll to targeted line when jumpToTimestamp is set
  useEffect(() => {
    if (jumpToTimestamp === null || lines.length === 0) return;
    const targetLine = lines.find((l) => Math.abs(l.t - jumpToTimestamp) <= 1.5) || lines[lines.length - 1];
    if (targetLine) {
      const el = rowRefs.current.get(targetLine.id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('is-highlighted');
        setTimeout(() => el.classList.remove('is-highlighted'), 2500);
      }
    }
    setJumpToTimestamp(null);
  }, [jumpToTimestamp, lines, setJumpToTimestamp]);

  // Auto-scroll to bottom during live recording
  useEffect(() => {
    if (isLive && jumpToTimestamp === null && !isUserScrolledUpRef.current) {
      requestAnimationFrame(() => {
        if (bottomAnchorRef.current) {
          bottomAnchorRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
        } else if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
      });
    }
  }, [lines.length, isLive, jumpToTimestamp, liveSource, liveTranslation]);

  const handleStartEditLine = (line: MeetingTranscriptLine) => {
    if (!sessionId) return;
    setEditingLineId(line.id);
    setEditSrcDraft(line.src || '');
    setEditDstDraft(line.dst || '');
  };

  const handleSaveEditLine = (lineId: string | number) => {
    if (!sessionId) return;
    editTranscriptLine(sessionId, lineId, {
      src: editSrcDraft.trim(),
      dst: editDstDraft.trim(),
    });
    setEditingLineId(null);
    showToast('已更新该句文字');
  };

  const handleBatchReplace = () => {
    if (!sessionId || !findDraft.trim() || !replaceDraft.trim()) return;
    const count = batchReplaceInSession(sessionId, findDraft, replaceDraft, learnWordList);
    if (count > 0) {
      showToast(`已替换 ${count} 处${learnWordList ? '（并已加入全局词表）' : ''}`);
      setFindDraft('');
      setReplaceDraft('');
      setBatchOpen(false);
    } else {
      showToast('未在当前记录中找到匹配词');
    }
  };

  const handleUndo = () => {
    if (!sessionId) return;
    if (undoLastTranscriptEdit(sessionId)) {
      showToast('已撤销上次修改');
    }
  };

  if (lines.length === 0 && !liveSource) {
    return (
      <div className="cicada-transcript-view__empty">
        <p>{isLive ? '正在听，说话的内容会出现在这里…' : '这场会议没有记录到内容'}</p>
      </div>
    );
  }

  const canUndo = Boolean(sessionId && canUndoTranscriptEdit(sessionId));

  return (
    <div
      className="cicada-transcript-view"
      ref={containerRef}
      onScroll={handleScroll}
    >
      {/* Toolbar: Batch Fix Misheard Word & Undo */}
      {sessionId && lines.length > 0 && (
        <div
          className="cicada-transcript-toolbar"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
            padding: '8px 16px',
            borderBottom: '1px solid rgba(128, 128, 128, 0.12)',
            fontSize: '12px',
          }}
        >
          <button
            type="button"
            onClick={() => setBatchOpen((v) => !v)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 10px',
              borderRadius: '6px',
              border: '1px solid rgba(128,128,128,0.25)',
              background: batchOpen ? 'rgba(139, 92, 246, 0.12)' : 'transparent',
              cursor: 'pointer',
              fontSize: '12px',
              color: 'inherit',
            }}
          >
            <Replace size={12} />
            <span>整场批量改错词</span>
          </button>

          {canUndo && (
            <button
              type="button"
              onClick={handleUndo}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '4px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(128,128,128,0.25)',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: '12px',
                color: 'inherit',
              }}
            >
              <RotateCcw size={12} />
              <span>撤销</span>
            </button>
          )}

          {toastMsg && (
            <span style={{ color: '#8b5cf6', fontWeight: 500, marginLeft: 'auto' }}>{toastMsg}</span>
          )}

          {batchOpen && (
            <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
              <input
                type="text"
                placeholder="误听词（如：张伟）"
                value={findDraft}
                onChange={(e) => setFindDraft(e.target.value)}
                style={{ padding: '4px 8px', borderRadius: '5px', border: '1px solid rgba(128,128,128,0.3)', fontSize: '12px', width: '140px' }}
              />
              <span>→</span>
              <input
                type="text"
                placeholder="正确写法（如：章炜）"
                value={replaceDraft}
                onChange={(e) => setReplaceDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleBatchReplace(); }}
                style={{ padding: '4px 8px', borderRadius: '5px', border: '1px solid rgba(128,128,128,0.3)', fontSize: '12px', width: '140px' }}
              />
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={learnWordList}
                  onChange={(e) => setLearnWordList(e.target.checked)}
                />
                <span>记住到词表</span>
              </label>
              <button
                type="button"
                onClick={handleBatchReplace}
                disabled={!findDraft.trim() || !replaceDraft.trim()}
                style={{
                  padding: '4px 10px',
                  borderRadius: '5px',
                  border: 'none',
                  background: '#8b5cf6',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '12px',
                }}
              >
                全部替换
              </button>
            </div>
          )}
        </div>
      )}

      <div className="cicada-transcript-view__list">
        {lines.map((line, idx) => {
          const isMe = line.speaker === 'me';
          const speakerName = isMe ? '你' : (line.speakerName || '对方');
          const isEditing = editingLineId === line.id;

          return (
            <div
              key={line.id || idx}
              ref={(el) => {
                if (el) rowRefs.current.set(line.id, el);
                else rowRefs.current.delete(line.id);
              }}
              className={`cicada-transcript-row ${isMe ? 'is-me' : 'is-other'}`}
            >
              {/* Left Column: Timestamp */}
              <div className="cicada-transcript-row__time">
                {formatClock(line.t)}
              </div>

              {/* Right Column: Speaker & Texts */}
              <div className="cicada-transcript-row__content">
                <div
                  className={`cicada-transcript-row__speaker ${isMe ? 'speaker--me' : 'speaker--other'}`}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <span>{speakerName}</span>
                  {sessionId && !isLive && !isEditing && (
                    <button
                      type="button"
                      onClick={() => handleStartEditLine(line)}
                      title="编辑本句"
                      style={{
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        opacity: 0.55,
                        padding: '2px',
                        color: 'inherit',
                      }}
                    >
                      <Pencil size={12} />
                    </button>
                  )}
                </div>

                {isEditing ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
                    <input
                      type="text"
                      value={editSrcDraft}
                      onChange={(e) => setEditSrcDraft(e.target.value)}
                      placeholder="原文"
                      style={{ padding: '5px 8px', borderRadius: '5px', border: '1px solid #8b5cf6', fontSize: '13px' }}
                    />
                    <input
                      type="text"
                      value={editDstDraft}
                      onChange={(e) => setEditDstDraft(e.target.value)}
                      placeholder="译文"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveEditLine(line.id);
                        if (e.key === 'Escape') setEditingLineId(null);
                      }}
                      style={{ padding: '5px 8px', borderRadius: '5px', border: '1px solid #8b5cf6', fontSize: '13px' }}
                    />
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={() => handleSaveEditLine(line.id)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', padding: '3px 8px', borderRadius: '4px', border: 'none', background: '#8b5cf6', color: '#fff', cursor: 'pointer', fontSize: '12px' }}
                      >
                        <Check size={12} /> 保存
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingLineId(null)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', padding: '3px 8px', borderRadius: '4px', border: '1px solid rgba(128,128,128,0.3)', background: 'transparent', cursor: 'pointer', fontSize: '12px', color: 'inherit' }}
                      >
                        <X size={12} /> 取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {viewMode !== 'dst' && Boolean(line.src) && (
                      <div
                        className={`cicada-transcript-row__src ${
                          viewMode === 'src' ? 'text--prominent' : 'text--secondary'
                        }`}
                      >
                        {line.src}
                      </div>
                    )}

                    {viewMode !== 'src' && (line.dst ? line.dst !== line.src : line.isLive) && (
                      <div
                        className={`cicada-transcript-row__dst ${
                          viewMode === 'dst' ? 'text--prominent' : 'text--primary'
                        }`}
                      >
                        {line.dst || '翻译中…'}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Pinned Bottom "此刻" row if live */}
      {isLive && (liveSource || liveTranslation) && (
        <div className="cicada-transcript-live-pin">
          <div className="cicada-transcript-live-pin__label">
            <span className="live-dot" />
            <span>此刻</span>
          </div>
          <div className="cicada-transcript-live-pin__content">
            {liveSource && (
              <div className="live-src">{liveSource}</div>
            )}
            {liveTranslation && (
              <div className="live-dst">{liveTranslation}</div>
            )}
          </div>
        </div>
      )}

      {/* Bottom anchor for auto-scroll */}
      <div ref={bottomAnchorRef} style={{ height: 1, width: '100%', pointerEvents: 'none' }} />

      {/* Floating pill when user scrolls up during live session */}
      {showScrollBottomPill && (
        <button
          type="button"
          className="cicada-scroll-bottom-pill"
          onClick={() => {
            isUserScrolledUpRef.current = false;
            setShowScrollBottomPill(false);
            bottomAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
          }}
        >
          <ArrowDown size={13} />
          <span>最新字幕</span>
        </button>
      )}
    </div>
  );
};

export default CicadaTranscriptView;
