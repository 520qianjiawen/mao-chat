// src/components/Transcript/CicadaTranscriptView.tsx
import React, { useState, useEffect, useRef } from 'react';
import { ArrowDown } from 'lucide-react';
import type { MeetingTranscriptLine } from '../../types/meeting';
import { formatClock } from '../../types/meeting';
import { useMeetingStore } from '../../stores/meetingStore';
import './CicadaTranscriptView.scss';

interface CicadaTranscriptViewProps {
  lines: MeetingTranscriptLine[];
  isLive: boolean;
  viewMode?: 'both' | 'src' | 'dst';
  liveSource?: string;
  liveTranslation?: string;
}

export const CicadaTranscriptView: React.FC<CicadaTranscriptViewProps> = ({
  lines,
  isLive,
  viewMode = 'both',
  liveSource = '',
  liveTranslation = '',
}) => {
  const jumpToTimestamp = useMeetingStore((s) => s.jumpToTimestamp);
  const setJumpToTimestamp = useMeetingStore((s) => s.setJumpToTimestamp);

  const containerRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string | number, HTMLDivElement>>(new Map());
  const isUserScrolledUpRef = useRef(false);
  const [showScrollBottomPill, setShowScrollBottomPill] = useState(false);

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

  if (lines.length === 0 && !liveSource) {
    return (
      <div className="cicada-transcript-view__empty">
        <p>{isLive ? '正在听，说话的内容会出现在这里…' : '这场会议没有记录到内容'}</p>
      </div>
    );
  }

  return (
    <div
      className="cicada-transcript-view"
      ref={containerRef}
      onScroll={handleScroll}
    >
      <div className="cicada-transcript-view__list">
        {lines.map((line, idx) => {
          const isMe = line.speaker === 'me';
          const speakerName = isMe ? '你' : (line.speakerName || '对方');

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
                <div className={`cicada-transcript-row__speaker ${isMe ? 'speaker--me' : 'speaker--other'}`}>
                  {speakerName}
                </div>

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
