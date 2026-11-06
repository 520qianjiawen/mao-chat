// src/components/Sidebar/SessionSidebar.tsx
import React, { useRef, useEffect, useState, useMemo } from 'react';
import { Search, X, Trash2, ChevronDown, ChevronRight, Mic } from 'lucide-react';
import { useMeetingStore } from '../../stores/meetingStore';
import { getDateGroupTitle, formatSessionDuration } from '../../types/meeting';
import type { MeetingSession } from '../../types/meeting';
import './SessionSidebar.scss';

export const SessionSidebar: React.FC = () => {
  const sessions = useMeetingStore((s) => s.sessions);
  const activeSessionId = useMeetingStore((s) => s.activeSessionId);
  const selectedSessionId = useMeetingStore((s) => s.selectedSessionId);
  const searchQuery = useMeetingStore((s) => s.searchQuery);
  const selectSession = useMeetingStore((s) => s.selectSession);
  const deleteSession = useMeetingStore((s) => s.deleteSession);
  const setSearchQuery = useMeetingStore((s) => s.setSearchQuery);
  const createSampleSessionIfEmpty = useMeetingStore((s) => s.createSampleSessionIfEmpty);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showOlder, setShowOlder] = useState(false);

  // Global shortcut ⌘F / Ctrl+F to focus search input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Filter sessions by query
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) => {
      const matchTitle = s.title.toLowerCase().includes(q);
      const matchLines = s.lines.some(
        (l) => l.src.toLowerCase().includes(q) || (l.dst && l.dst.toLowerCase().includes(q))
      );
      const matchSummary = s.notes?.summary.toLowerCase().includes(q) || false;
      return matchTitle || matchLines || matchSummary;
    });
  }, [sessions, searchQuery]);

  // Group by date: "今天", "昨天", "本周", etc.
  const groupedSessions = useMemo(() => {
    const groups: { title: string; sessions: MeetingSession[] }[] = [];
    for (const session of filteredSessions) {
      const groupTitle = getDateGroupTitle(session.startedAt);
      const existing = groups.find((g) => g.title === groupTitle);
      if (existing) {
        existing.sessions.push(session);
      } else {
        groups.push({ title: groupTitle, sessions: [session] });
      }
    }
    return groups;
  }, [filteredSessions]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  return (
    <aside className="session-sidebar" aria-label="会议记录列表">
      {/* Search Header */}
      <div className="session-sidebar__search-bar">
        <Search size={14} className="session-sidebar__search-icon" aria-hidden="true" />
        <input
          ref={searchInputRef}
          type="text"
          className="session-sidebar__search-input"
          placeholder="搜索"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery ? (
          <button
            type="button"
            className="session-sidebar__search-clear"
            onClick={() => setSearchQuery('')}
            title="清除搜索"
          >
            <X size={12} />
          </button>
        ) : (
          <span className="session-sidebar__search-badge">⌘F</span>
        )}
      </div>

      {/* Sessions List */}
      <div className="session-sidebar__scroll-area">
        {filteredSessions.length === 0 ? (
          <div className="session-sidebar__empty">
            {searchQuery ? `未找到匹配 "${searchQuery}" 的会议` : '暂无历史会议'}
          </div>
        ) : (
          <div className="session-sidebar__groups">
            {(showOlder || searchQuery || groupedSessions.length <= 1
              ? groupedSessions
              : groupedSessions.slice(0, 1)
            ).map((group) => (
              <div key={group.title} className="session-sidebar__group">
                <div className="session-sidebar__group-title">{group.title}</div>
                <div className="session-sidebar__group-items">
                  {group.sessions.map((session) => {
                    const isSelected = (selectedSessionId || sessions[0]?.id) === session.id;
                    const isLive = session.id === activeSessionId;

                    return (
                      <div
                        key={session.id}
                        role="button"
                        tabIndex={0}
                        className={`session-sidebar__row ${isSelected ? 'is-selected' : ''} ${
                          isLive ? 'is-live' : ''
                        }`}
                        onClick={() => selectSession(session.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            selectSession(session.id);
                          }
                        }}
                        title={`${new Date(session.startedAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })} · ${formatSessionDuration(session.duration)}`}
                      >
                        {isLive && <span className="session-sidebar__live-dot" />}
                        <span className="session-sidebar__row-title">{session.title}</span>
                        {!isLive && (
                          <button
                            type="button"
                            className="session-sidebar__delete-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteSession(session.id);
                            }}
                            title="删除"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {!searchQuery && groupedSessions.length > 1 && (
              <button
                type="button"
                className="session-sidebar__toggle-older"
                onClick={() => setShowOlder(!showOlder)}
              >
                <span>{showOlder ? '收起更早的会议' : '更早的会议'}</span>
                {showOlder ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Bottom Live Streaming Indicator */}
      {activeSession && (
        <div className="session-sidebar__footer-live">
          <span className="session-sidebar__live-dot" />
          <span className="session-sidebar__footer-text">此刻</span>
          <span className="session-sidebar__footer-anim">.</span>
        </div>
      )}
    </aside>
  );
};

export default SessionSidebar;
