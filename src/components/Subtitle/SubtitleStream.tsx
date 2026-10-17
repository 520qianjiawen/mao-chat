import React, { useEffect, useLayoutEffect, useRef, useMemo, useState } from 'react';
import ConversationRow from '../MainPanel/ConversationRow';
import { shouldShowItem } from '../MainPanel/conversationFilter';
import type { DisplayMode } from '../../stores/subtitleStore';
import { usePlaybackHighlight } from '../../stores/playbackStore';

import './SubtitleStream.scss';
import '../../styles/karaoke.scss';

interface Props {
  items: any[];
  compact: boolean;
  fontSize: number;
  speakerMode: DisplayMode;
  participantMode: DisplayMode;
  sourceLanguage: string;
  targetLanguage: string;
  sourceTextColor?: string;
  translationTextColor?: string;
  // When false, items that arrive after first mount are still tracked but
  // do not receive the `--new` modifier — the CSS highlight never fires.
  // Defaults to true; passed through from the persisted subtitle setting.
  newItemHighlightEnabled?: boolean;
}

function itemText(item: any): string {
  return item?.formatted?.transcript || item?.formatted?.text || '';
}

type LineSource = 'speaker' | 'participant';

interface CueLine {
  id: string;
  text: string;
  live: boolean;
  sequence: number;
}

/**
 * One bilingual cue card — origin (source) over translation, kiss-translator
 * style. Built by pairing consecutive user→assistant items per side.
 */
export interface BilingualCue {
  id: string;
  side: LineSource;
  origin?: CueLine;
  translation?: CueLine;
  sequence: number;
}

/**
 * Stable identity for a cue across the local-native ASR refine pass: the
 * origin (user) item keeps its id from the first partial through every
 * rewrite, while the translation is re-emitted under a fresh assistant id.
 */
export function stableCueKey(cue: Pick<BilingualCue, 'side' | 'origin' | 'translation'>): string {
  return `${cue.side}:${cue.origin?.id ?? cue.translation?.id}`;
}

/** How many recent cue cards to keep per side (current + one previous). */
const MAX_CUES_PER_SIDE = 2;

/**
 * Reading window for a completed compact cue. Four seconds was too short for
 * bilingual captions because the viewer has two lines to scan. Keep short
 * cues for at least eight seconds and give longer lines proportionally more
 * time, capped so stale subtitles do not linger indefinitely.
 */
export const COMPACT_CUE_HOLD_MS = 8000;
export const COMPACT_CUE_MAX_HOLD_MS = 16000;

export function compactCueHoldMs(cue: BilingualCue | undefined): number {
  if (!cue) return COMPACT_CUE_HOLD_MS;

  const readTimeFor = (text: string | undefined): number => {
    const value = String(text || '').trim();
    if (!value) return 0;
    const cjk = value.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu)?.length ?? 0;
    const words = value.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
    // Approx. 6 CJK chars/sec or 2.5 spaced words/sec, plus eye-movement time.
    return 2200 + Math.max((cjk / 6) * 1000, (words / 2.5) * 1000);
  };

  // A bilingual viewer normally reads one line then checks the other. The
  // longest line is the useful baseline; the generous 8s floor covers the
  // second-line glance without doubling long-caption duration.
  const estimated = Math.max(
    readTimeFor(cue.origin?.text),
    readTimeFor(cue.translation?.text),
  );
  return Math.round(Math.min(
    COMPACT_CUE_MAX_HOLD_MS,
    Math.max(COMPACT_CUE_HOLD_MS, estimated),
  ));
}

/**
 * Pair chronological user/assistant items into bilingual cues.
 * Exported for unit tests.
 */
export function buildBilingualCues(
  items: any[],
  maxPerSide = MAX_CUES_PER_SIDE,
): BilingualCue[] {
  const bySide: Record<LineSource, BilingualCue[]> = {
    speaker: [],
    participant: [],
  };
  const pendingOrigin: Partial<Record<LineSource, CueLine>> = {};

  items.forEach((item, sequence) => {
    const text = itemText(item).trim();
    if (!text) return;
    const side: LineSource = item.source === 'participant' ? 'participant' : 'speaker';
    const live = item.status === 'in_progress';

    if (item.role === 'user') {
      // A new origin starts a new cue; flush any previous unpaired origin.
      if (pendingOrigin[side]) {
        bySide[side].push({
          id: `cue-o-${pendingOrigin[side]!.id}`,
          side,
          origin: pendingOrigin[side],
          sequence: pendingOrigin[side]!.sequence,
        });
      }
      pendingOrigin[side] = { id: item.id, text, live, sequence };
      return;
    }

    if (item.role === 'assistant' || item.type === 'error' || item.role === 'system') {
      const origin = pendingOrigin[side];
      delete pendingOrigin[side];
      bySide[side].push({
        id: `cue-t-${item.id}`,
        side,
        origin,
        translation: { id: item.id, text, live, sequence },
        sequence,
      });
    }
  });

  (['speaker', 'participant'] as LineSource[]).forEach((side) => {
    if (pendingOrigin[side]) {
      bySide[side].push({
        id: `cue-o-${pendingOrigin[side]!.id}`,
        side,
        origin: pendingOrigin[side],
        sequence: pendingOrigin[side]!.sequence,
      });
    }
  });

  // Speaker cues first, then participant — each side keeps only the tail.
  return [
    ...bySide.speaker.slice(-maxPerSide),
    ...bySide.participant.slice(-maxPerSide),
  ].sort((a, b) => a.sequence - b.sequence);
}

/**
 * Subtitle stream has two display modes driven by `compact`:
 *
 * - compact (default) — kiss-translator style bilingual cue cards:
 *   each card stacks origin over translation inside a semi-transparent
 *   caption window. Only the latest 1–2 cues per side stay on screen.
 *
 * - expanded — per-item ConversationRow log for full history.
 */
const SubtitleStream: React.FC<Props> = ({
  items,
  compact,
  fontSize,
  speakerMode,
  participantMode,
  sourceLanguage,
  targetLanguage,
  sourceTextColor,
  translationTextColor,
  newItemHighlightEnabled = true,
}) => {
  const filtered = useMemo(
    () => items.filter((item) => shouldShowItem(item, speakerMode, participantMode)),
    [items, speakerMode, participantMode],
  );

  const youtubeHistory = filtered.some((item) => String(item.id || '').startsWith('yt_src_'));
  const cues = useMemo(
    () => buildBilingualCues(filtered, youtubeHistory ? 500 : MAX_CUES_PER_SIDE),
    [filtered, youtubeHistory],
  );

  // A subtitle overlay is a live reading surface, not conversation history.
  // Keep only the latest bilingual cue across both audio channels. Once both
  // lines have settled, leave it on-screen just long enough to read and then
  // clear it until the next utterance arrives.
  const latestCue = cues[cues.length - 1];
  const latestCueLive = Boolean(latestCue?.origin?.live || latestCue?.translation?.live);
  const latestCueComplete = Boolean(
    latestCue?.origin && latestCue.translation
    && !latestCue.origin.live && !latestCue.translation.live,
  );
  const latestCueHoldMs = compactCueHoldMs(latestCue);
  const settledAtRef = useRef<Map<string, number>>(new Map());
  const [expiryClock, setExpiryClock] = useState(() => Date.now());

  // Last complete rendering of each settled cue, keyed by stableCueKey. The
  // local-native ASR keeps refining a committed group — the transcript is
  // rewritten and the translation re-run, so the live cue briefly collapses
  // to origin-only (the "bilingual mode shows only English" flicker) and then
  // lands on different text. The compact band ignores that churn: a cue that
  // has already been shown complete keeps displaying its settled text, and
  // the frozen pair stays up while the NEXT cue is still forming so the band
  // never degrades to a bare source line mid-speech.
  const frozenRef = useRef<Map<string, BilingualCue & { frozenAt: number; holdMs: number }>>(new Map());

  useEffect(() => {
    if (!compact || !latestCue) return;
    if (latestCueLive) {
      settledAtRef.current.delete(latestCue.id);
      return;
    }

    const settledAt = settledAtRef.current.get(latestCue.id) ?? Date.now();
    settledAtRef.current.set(latestCue.id, settledAt);
    setExpiryClock(Date.now());
    const remaining = Math.max(0, latestCueHoldMs - (Date.now() - settledAt));
    const timer = setTimeout(() => setExpiryClock(Date.now()), remaining + 20);
    return () => clearTimeout(timer);
  }, [compact, latestCue?.id, latestCueLive, latestCueHoldMs]);

  // Refresh the frozen cache before the selection below reads it — during
  // the very render that first shows a forming cue (idempotent: the text
  // guard keeps repeat renders from resetting the reading window).
  if (compact) {
    for (const cue of cues) {
      if (!cue.origin || !cue.translation) continue;
      if (cue.origin.live || cue.translation.live) continue;
      const key = stableCueKey(cue);
      const prev = frozenRef.current.get(key);
      if (prev
        && prev.origin?.text === cue.origin.text
        && prev.translation?.text === cue.translation.text) continue;
      // Texts changed (first settle or a refined re-translation finished
      // landing) — restart the frozen card's reading window.
      frozenRef.current.set(key, {
        ...cue,
        id: key,
        frozenAt: Date.now(),
        holdMs: compactCueHoldMs(cue),
      });
    }
    if (frozenRef.current.size > 8) {
      const excess = [...frozenRef.current.keys()].slice(0, frozenRef.current.size - 8);
      for (const k of excess) frozenRef.current.delete(k);
    }
  }

  const currentKey = latestCue ? stableCueKey(latestCue) : null;
  // A line the display modes would hide anyway (e.g. participant "source"
  // mode filters assistant rows) never arrives — that incompleteness is
  // permanent, not a translation in flight, so it must not trigger the
  // frozen fallback (the band then keeps honoring the mode switch).
  const lineHiddenByMode = (role: 'user' | 'assistant', side: LineSource): boolean => {
    const probe = { type: 'message', role, source: side } as any;
    return !shouldShowItem(probe, speakerMode, participantMode);
  };
  const latestCueCompletable = Boolean(
    latestCue
    && (latestCue.origin || !lineHiddenByMode('user', latestCue.side))
    && (latestCue.translation || !lineHiddenByMode('assistant', latestCue.side)),
  );
  // The refined pass of a cue already on screen must not flash through: while
  // its replacement translation is in flight, keep showing the frozen card.
  const frozenSelf = currentKey && latestCueCompletable
    ? frozenRef.current.get(currentKey)
    : undefined;
  const unfrozenOthers = currentKey && latestCueCompletable
    ? [...frozenRef.current.values()]
        .filter((f) => stableCueKey(f) !== currentKey && expiryClock - f.frozenAt < f.holdMs)
        .sort((a, b) => a.sequence - b.sequence)
    : [];
  const frozenCompanion = unfrozenOthers.length > 0
    ? unfrozenOthers[unfrozenOthers.length - 1]
    : undefined;

  // Re-render when a displayed frozen card reaches its reading window so it
  // can be dropped (mirrors the current-cue expiry timer above).
  useEffect(() => {
    if (!compact || !frozenCompanion) return;
    const remaining = Math.max(0, frozenCompanion.holdMs - (Date.now() - frozenCompanion.frozenAt));
    const timer = setTimeout(() => setExpiryClock(Date.now()), remaining + 20);
    return () => clearTimeout(timer);
  }, [compact, frozenCompanion?.id, frozenCompanion?.frozenAt, frozenCompanion?.holdMs]);

  const settledAt = latestCue ? settledAtRef.current.get(latestCue.id) : undefined;
  const sameSideCues = latestCue
    ? cues.filter((cue) => cue.side === latestCue.side)
    : [];
  const itemsById = useMemo(
    () => new Map<string, any>(items.map((it) => [it.id, it])),
    [items],
  );
  const youtubeCues = sameSideCues.filter((cue) => cue.origin?.id.startsWith('yt_src_'));
  const hasActiveYoutubeFlag = youtubeCues.some((cue) => (
    typeof itemsById.get(cue.origin!.id)?.active === 'boolean'
  ));
  const liveYoutubeCues = hasActiveYoutubeFlag
    ? youtubeCues.filter((cue) => itemsById.get(cue.origin!.id)?.active)
    : youtubeCues.slice(-2);
  let compactCues: BilingualCue[] = [];
  if (latestCue && (latestCueLive || settledAt === undefined || expiryClock - settledAt < latestCueHoldMs)) {
    if (youtubeCues.length > 0) {
      compactCues = liveYoutubeCues;
    } else if (latestCueLive || !latestCueComplete) {
      // Still forming. A cue already shown complete keeps its frozen card —
      // either its own pre-refine rendering (refine churn) or the previous
      // cue's settled pair (next utterance still translating) — so the band
      // keeps showing bilingual content instead of a bare source line.
      if (frozenSelf) compactCues = [frozenSelf];
      else if (frozenCompanion) compactCues = [frozenCompanion, latestCue];
      else compactCues = [latestCue];
    } else {
      compactCues = [latestCue];
    }
  }

  // Stick to bottom only in expanded mode.
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (compact) return;
    if (endRef.current && typeof endRef.current.scrollIntoView === 'function') {
      endRef.current.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }, [compact, filtered.length]);

  // Item "new" highlight state — locked on first sight.
  const itemStatesRef = useRef<Map<string, 'existing' | 'new'>>(new Map());
  const isFirstRenderRef = useRef(true);

  const itemStateFor = (id: string): 'existing' | 'new' => {
    const known = itemStatesRef.current.get(id);
    if (known !== undefined) return known;
    return isFirstRenderRef.current ? 'existing' : 'new';
  };

  useLayoutEffect(() => {
    for (const cue of cues) {
      if (cue.origin && !itemStatesRef.current.has(cue.origin.id)) {
        itemStatesRef.current.set(
          cue.origin.id,
          isFirstRenderRef.current ? 'existing' : 'new',
        );
      }
      if (cue.translation && !itemStatesRef.current.has(cue.translation.id)) {
        itemStatesRef.current.set(
          cue.translation.id,
          isFirstRenderRef.current ? 'existing' : 'new',
        );
      }
    }
    isFirstRenderRef.current = false;
  });

  // container-type: inline-size so cue font can use cqw (kiss clamp style).
  const style: React.CSSProperties & Record<string, string> = {
    fontSize: `${fontSize}px`,
    '--conversation-font-size': `${fontSize}px`,
    '--subtitle-base-size': `${fontSize}px`,
  };
  if (sourceTextColor) style['--subtitle-source-color'] = sourceTextColor;
  if (translationTextColor) style['--subtitle-translation-color'] = translationTextColor;

  return (
    <div className={`subtitle-stream ${compact ? 'compact' : 'expanded'}`} style={style}>
      {compact
        ? (
          <div className="subtitle-stream__stage">
            {compactCues.map((cue, index) => (
              <div
                key={cue.id}
                className={`subtitle-cue subtitle-cue--${cue.side}${index === compactCues.length - 1 && compactCues.length > 1 ? ' subtitle-cue--ahead' : ''}`}
                data-side={cue.side}
              >
                <div className="subtitle-cue__window">
                  {cue.origin && (
                    <p
                      className={[
                        'subtitle-stream__line',
                        'subtitle-stream__line--source',
                        `subtitle-stream__line--${cue.side}`,
                        cue.origin.live ? 'is-live' : '',
                      ].filter(Boolean).join(' ')}
                    >
                      <CueText
                        line={cue.origin}
                        item={itemsById.get(cue.origin.id)}
                        showNewHighlight={
                          newItemHighlightEnabled && itemStateFor(cue.origin.id) === 'new'
                        }
                      />
                    </p>
                  )}
                  {cue.translation && (
                    <p
                      className={[
                        'subtitle-stream__line',
                        'subtitle-stream__line--translation',
                        `subtitle-stream__line--${cue.side}`,
                        cue.translation.live ? 'is-live' : '',
                      ].filter(Boolean).join(' ')}
                    >
                      <CueText
                        line={cue.translation}
                        item={itemsById.get(cue.translation.id)}
                        showNewHighlight={
                          newItemHighlightEnabled
                          && itemStateFor(cue.translation.id) === 'new'
                        }
                      />
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
        : filtered.map((item, i) => (
            <SubtitleConversationRow
              key={item.id}
              item={item}
              prevItem={filtered[i - 1] ?? null}
              sourceLanguage={sourceLanguage}
              targetLanguage={targetLanguage}
            />
          ))}
      <div ref={endRef} />
    </div>
  );
};

interface CueTextProps {
  line: CueLine;
  item: any | undefined;
  showNewHighlight: boolean;
}

const CueText: React.FC<CueTextProps> = ({ line, item, showNewHighlight }) => {
  const displayText = line.text;
  const { isPlaying, highlightedChars } = usePlaybackHighlight(item, line.text);
  const classes = [
    'subtitle-stream__item',
    showNewHighlight ? 'subtitle-stream__item--new' : '',
    line.live ? 'subtitle-stream__item--live' : '',
    isPlaying ? 'subtitle-stream__item--playing' : '',
  ].filter(Boolean).join(' ');

  if (!isPlaying || highlightedChars <= 0) {
    return <span className={classes}>{displayText}</span>;
  }
  if (highlightedChars >= line.text.length) {
    return (
      <span className={classes}>
        <span className="karaoke-played">{line.text}</span>
      </span>
    );
  }
  return (
    <span className={classes}>
      <span className="karaoke-played">{line.text.slice(0, highlightedChars)}</span>
      <span className="subtitle-stream__unplayed">{line.text.slice(highlightedChars)}</span>
    </span>
  );
};

const SubtitleConversationRow: React.FC<{
  item: any;
  prevItem: any;
  sourceLanguage: string;
  targetLanguage: string;
}> = ({ item, prevItem, sourceLanguage, targetLanguage }) => {
  const { isPlaying, highlightedChars } = usePlaybackHighlight(item);
  return (
    <ConversationRow
      item={item}
      prevItem={prevItem}
      compact={false}
      sourceLanguage={sourceLanguage}
      targetLanguage={targetLanguage}
      isPlaying={isPlaying}
      highlightedChars={highlightedChars}
      canPlay={false}
    />
  );
};

export default SubtitleStream;
