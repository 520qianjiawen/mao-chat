// src/components/Notes/NotesContentView.tsx
import React, { useState, useEffect, useRef } from 'react';
import { CheckCircle2, Circle, Clock, Sparkles, ArrowDown } from 'lucide-react';
import type { MeetingNotes, NoteTopic, NoteItem, NoteTerm } from '../../types/meeting';
import { formatClock } from '../../types/meeting';
import useSessionStore from '../../stores/sessionStore';
import { useMeetingStore } from '../../stores/meetingStore';
import './NotesContentView.scss';

interface NotesContentViewProps {
  sessionId?: string;
  notes: MeetingNotes;
  isLive: boolean;
  freshPoints?: Set<string>;
  totalLinesCount?: number;
  elapsedSeconds?: number;
  onJumpToTranscript?: (seconds: number) => void;
}

export const NotesContentView: React.FC<NotesContentViewProps> = ({
  sessionId,
  notes,
  isLive,
  freshPoints = new Set(),
  totalLinesCount = 0,
  elapsedSeconds = 0,
  onJumpToTranscript,
}) => {
  const requestSessionStop = useSessionStore((s) => s.requestSessionStop);
  const setTab = useMeetingStore((s) => s.setTab);
  const setJumpToTimestamp = useMeetingStore((s) => s.setJumpToTimestamp);
  const updateSessionNotes = useMeetingStore((s) => s.updateSessionNotes);

  const [editingField, setEditingField] = useState<{ kind: 'summary' | 'conclusion' | 'todo'; index?: number } | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const startEdit = (kind: 'summary' | 'conclusion' | 'todo', value: string, index?: number) => {
    if (!sessionId || isLive) return;
    setEditingField({ kind, index });
    setEditDraft(value);
  };

  const commitEdit = () => {
    if (!editingField || !sessionId) {
      setEditingField(null);
      return;
    }
    const trimmed = editDraft.trim();
    if (trimmed) {
      updateSessionNotes(sessionId, (curr) => {
        if (editingField.kind === 'summary') {
          return { ...curr, summary: trimmed };
        }
        if (editingField.kind === 'conclusion' && editingField.index !== undefined) {
          const nextConclusions = curr.conclusions.map((c, i) =>
            i === editingField.index ? { ...c, text: trimmed } : c
          );
          return { ...curr, conclusions: nextConclusions };
        }
        if (editingField.kind === 'todo' && editingField.index !== undefined) {
          const nextTodos = curr.todos.map((td, i) =>
            i === editingField.index ? { ...td, text: trimmed } : td
          );
          return { ...curr, todos: nextTodos };
        }
        return curr;
      });
    }
    setEditingField(null);
  };

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef(false);
  const [showScrollBottomPill, setShowScrollBottomPill] = useState(false);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isUp = distanceToBottom > 120;
    isUserScrolledUpRef.current = isUp;
    setShowScrollBottomPill(isLive && isUp);
  };

  // Auto-scroll down when new notes/topics arrive during live session
  useEffect(() => {
    if (!isLive || isUserScrolledUpRef.current) return;
    const el = scrollContainerRef.current;
    if (el) {
      requestAnimationFrame(() => {
        if (bottomAnchorRef.current) {
          bottomAnchorRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
        } else {
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        }
      });
    }
  }, [
    isLive,
    notes.topics.length,
    notes.topics[notes.topics.length - 1]?.points?.length,
    notes.topics[notes.topics.length - 1]?.summary,
    notes.summary,
  ]);

  const handleJump = (t: number | null | undefined) => {
    if (t === null || t === undefined) return;
    setJumpToTimestamp(t);
    setTab('transcript');
    onJumpToTranscript?.(t);
  };

  const hasSummary = Boolean(notes.summary && notes.summary.trim().length > 0);
  const hasTopics = notes.topics && notes.topics.length > 0;
  const hasConclusions = notes.conclusions && notes.conclusions.length > 0;
  const hasTodos = notes.todos && notes.todos.length > 0;
  const hasTerms = notes.terms && notes.terms.length > 0;

  return (
    <div
      className="notes-content-view"
      ref={scrollContainerRef}
      onScroll={handleScroll}
    >
      {/* End Meeting Prompt Card (When live) */}
      {isLive && (
        <div className="notes-end-banner">
          <div className="notes-end-banner__header">
            <h4>结束这场会议？</h4>
          </div>
          <p className="notes-end-banner__desc">
            已记录 {formatClock(elapsedSeconds)} · {totalLinesCount} 句。结束后停止收听，并整理一份完整版纪要。
          </p>
          <div className="notes-end-banner__actions">
            <button
              type="button"
              className="notes-end-banner__continue"
              onClick={() => {
                /* User keeps recording */
              }}
            >
              继续记录
            </button>
            <button
              type="button"
              className="notes-end-banner__stop"
              onClick={() => requestSessionStop()}
            >
              结束会议
            </button>
          </div>
        </div>
      )}

      {/* 总结 Card */}
      {hasSummary && (
        <section className="notes-card notes-card--summary">
          <div className="notes-card__header">
            <h3 className="notes-card__title">总结</h3>
            <span className="notes-badge notes-badge--tag">
              {notes.final ? '完整版' : isLive ? '速记版' : '速记版'}
            </span>
          </div>
          {editingField?.kind === 'summary' ? (
            <textarea
              className="notes-inline-editor"
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditingField(null);
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') commitEdit();
              }}
              rows={3}
              autoFocus
              style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #8b5cf6', font: 'inherit', resize: 'vertical' }}
            />
          ) : (
            <p
              className="notes-card__text"
              onClick={() => startEdit('summary', notes.summary)}
              title={!isLive && sessionId ? '点击原地编辑总结' : undefined}
              style={!isLive && sessionId ? { cursor: 'text' } : undefined}
            >
              {notes.summary}
            </p>
          )}
        </section>
      )}

      {/* 议题 Section */}
      {hasTopics && (
        <section className="notes-section notes-section--topics">
          <h3 className="notes-section__title">议题</h3>
          <div className="notes-topics-list">
            {notes.topics.map((topic, index) => {
              const isCurrentTopic = isLive && index === notes.topics.length - 1;
              const isFreshTopic = freshPoints.has(topic.title);

              return (
                <article key={`${topic.start}-${topic.title}-${index}`} className="notes-topic-card">
                  <div className="notes-topic-card__header">
                    <button
                      type="button"
                      className="notes-topic-card__time-btn"
                      onClick={() => handleJump(topic.start)}
                      title="看原话"
                    >
                      {formatClock(topic.start)} 起
                    </button>
                    <h4 className="notes-topic-card__title">{topic.title}</h4>
                    {isCurrentTopic && (
                      <span className="notes-badge notes-badge--live">正在讲</span>
                    )}
                    {isFreshTopic && !isCurrentTopic && (
                      <span className="notes-badge notes-badge--fresh">新</span>
                    )}
                  </div>

                  {topic.summary && (
                    <p className="notes-topic-card__summary">{topic.summary}</p>
                  )}

                  {topic.points && topic.points.length > 0 && (
                    <ul className="notes-topic-card__points">
                      {topic.points.map((point, pIdx) => {
                        const pointTime = topic.pointTimes?.[pIdx];
                        const isFreshPoint = freshPoints.has(point);

                        return (
                          <li key={`${pIdx}-${point}`} className="notes-point-row">
                            <span
                              className={`notes-point-row__bullet ${
                                isFreshPoint ? 'is-fresh' : ''
                              }`}
                            />
                            <span className="notes-point-row__text">{point}</span>
                            {isFreshPoint && (
                              <span className="notes-badge notes-badge--fresh">新</span>
                            )}
                            <span className="notes-point-row__spacer" />
                            {pointTime !== null && pointTime !== undefined && (
                              <button
                                type="button"
                                className="notes-point-row__time-link"
                                onClick={() => handleJump(pointTime)}
                                title="跳转到原文"
                              >
                                {formatClock(pointTime)}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* 结论和待办 Section */}
      {(hasConclusions || hasTodos) && (
        <section className="notes-section notes-section--conclusions">
          <h3 className="notes-section__title">
            {hasTodos ? '结论和待办' : '结论'}
          </h3>
          <div className="notes-card notes-card--list">
            {notes.conclusions.map((item, idx) => (
              <div key={`conclusion-${idx}`} className="notes-item-row">
                <CheckCircle2 size={15} className="notes-item-row__icon icon-check" />
                {editingField?.kind === 'conclusion' && editingField.index === idx ? (
                  <input
                    type="text"
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit();
                      if (e.key === 'Escape') setEditingField(null);
                    }}
                    autoFocus
                    style={{ flex: 1, padding: '2px 6px', borderRadius: '4px', border: '1px solid #8b5cf6', font: 'inherit' }}
                  />
                ) : (
                  <span
                    className="notes-item-row__text"
                    onClick={() => startEdit('conclusion', item.text, idx)}
                    title={!isLive && sessionId ? '点击原地编辑结论' : undefined}
                    style={!isLive && sessionId ? { cursor: 'text' } : undefined}
                  >
                    {item.text}
                  </span>
                )}
                {item.t !== null && item.t !== undefined && (
                  <button
                    type="button"
                    className="notes-item-row__time"
                    onClick={() => handleJump(item.t)}
                  >
                    {formatClock(item.t)}
                  </button>
                )}
              </div>
            ))}
            {notes.todos.map((item, idx) => (
              <div key={`todo-${idx}`} className="notes-item-row">
                <Circle size={15} className="notes-item-row__icon icon-todo" />
                {editingField?.kind === 'todo' && editingField.index === idx ? (
                  <input
                    type="text"
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit();
                      if (e.key === 'Escape') setEditingField(null);
                    }}
                    autoFocus
                    style={{ flex: 1, padding: '2px 6px', borderRadius: '4px', border: '1px solid #8b5cf6', font: 'inherit' }}
                  />
                ) : (
                  <span
                    className="notes-item-row__text"
                    onClick={() => startEdit('todo', item.text, idx)}
                    title={!isLive && sessionId ? '点击原地编辑待办' : undefined}
                    style={!isLive && sessionId ? { cursor: 'text' } : undefined}
                  >
                    {item.text}
                    {item.owner && (
                      <span className="notes-item-row__owner">（{item.owner}）</span>
                    )}
                  </span>
                )}
                {item.t !== null && item.t !== undefined && (
                  <button
                    type="button"
                    className="notes-item-row__time"
                    onClick={() => handleJump(item.t)}
                  >
                    {formatClock(item.t)}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 人名和术语 Section */}
      {hasTerms && (
        <section className="notes-section notes-section--terms">
          <h3 className="notes-section__title">人名和术语</h3>
          <div className="notes-terms-container">
            {notes.terms.map((term, idx) => (
              <div key={`term-${idx}`} className="notes-term-chip">
                <span className="notes-term-chip__name">{term.name}</span>
                {term.note && (
                  <span className="notes-term-chip__note">{term.note}</span>
                )}
                {term.heard && term.heard.length > 0 && (
                  <span className="notes-term-chip__heard">
                    误识: {term.heard.join(', ')}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {!hasSummary && !hasTopics && (
        <div className="notes-empty-state">
          <Sparkles size={28} className="notes-empty-state__icon" />
          <p className="notes-empty-state__title">
            {isLive ? '正在聆听发言，纪要将实时生成…' : '该会议暂无纪要'}
          </p>
        </div>
      )}

      {/* Bottom anchor for smooth auto-scroll */}
      <div ref={bottomAnchorRef} style={{ height: 1, width: '100%', pointerEvents: 'none' }} />

      {/* Floating Pill when user scrolls up during live recording */}
      {showScrollBottomPill && (
        <button
          type="button"
          className="notes-scroll-bottom-pill"
          onClick={() => {
            isUserScrolledUpRef.current = false;
            setShowScrollBottomPill(false);
            bottomAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
          }}
        >
          <ArrowDown size={13} />
          <span>最新纪要</span>
        </button>
      )}
    </div>
  );
};

export default NotesContentView;
