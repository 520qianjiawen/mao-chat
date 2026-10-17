import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, User, Users } from 'lucide-react';
import type { ConversationItem } from '../../services/interfaces/IClient';
import { isElectron, isExtension } from '../../utils/environment';
import { useProvider } from '../../stores/settingsStore';
import { useMode } from '../../stores/audioStore';
import { shouldKeepCapturedAudioDirection } from './participantDirection';
import { formatVideoTime } from '../../lib/youtube-captions/youtubeCaptions';
import './ConversationRow.scss';
import '../../styles/karaoke.scss';

interface ConversationRowProps {
  // sourceLanguage/targetLanguage are display-only fields attached by MainPanel's
  // tag(); source and detectedLanguage already live on ConversationItem.
  item: ConversationItem & {
    sourceLanguage?: string;
    targetLanguage?: string;
  };
  prevItem?: ConversationItem | null;
  sourceLanguage: string;
  targetLanguage: string;
  isPlaying: boolean;
  highlightedChars: number;
  canPlay?: boolean;
  onPlay?: () => void;
  playDisabled?: boolean;
  replayEnabled?: boolean;
  compact?: boolean;
}

export function languageForItem(
  source: 'speaker' | 'participant',
  role: 'user' | 'assistant' | 'system',
  sourceLanguage: string,
  targetLanguage: string,
  participantUsesForwardPair = false,
): string {
  // speaker/user       -> sourceLanguage  (I speak my language)
  // speaker/assistant  -> targetLanguage  (translated for others)
  // participant/user   -> targetLanguage  (they speak the other language)
  // participant/assistant -> sourceLanguage (translated back to me)
  if (source === 'speaker' || participantUsesForwardPair) {
    return role === 'user' ? sourceLanguage : targetLanguage;
  }
  return role === 'user' ? targetLanguage : sourceLanguage;
}

function formatTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function youtubeCueTimeMs(item: ConversationItem): number | null {
  const id = item.id || '';
  const prefix = id.startsWith('yt_src_')
    ? 'yt_src_'
    : id.startsWith('yt_tr_')
      ? 'yt_tr_'
      : '';
  if (!prefix) return null;
  const ms = Number(id.slice(prefix.length));
  return Number.isFinite(ms) ? ms : null;
}

const ConversationRow: React.FC<ConversationRowProps> = ({
  item,
  prevItem,
  sourceLanguage,
  targetLanguage,
  isPlaying,
  highlightedChars,
  canPlay = false,
  onPlay,
  playDisabled = false,
  replayEnabled = true,
  compact = false,
}) => {
  const { t } = useTranslation();
  const source: 'speaker' | 'participant' = item.source ?? 'speaker';
  const extensionExperience = isExtension();
  const provider = useProvider();
  const audioMode = useMode();
  // Forward (source → subtitle) badges only when this channel actually kept
  // Settings' pair — video/tab capture. Meeting You/Both reverse the pair, so
  // badges must follow the meeting mapping or EN/ZH swap on the transcript.
  const capturedMediaAudio = source === 'participant'
    && shouldKeepCapturedAudioDirection(
      provider,
      audioMode,
      { electron: isElectron(), extension: extensionExperience },
    );
  const role = item.role;
  const rawText = item.formatted?.transcript || item.formatted?.text || '';
  const youtubeTimeMs = youtubeCueTimeMs(item);
  const text = rawText;

  const showHeader = !prevItem || (prevItem.source ?? 'speaker') !== source;
  const isTranslation = role === 'assistant';
  const showYoutubeTime = extensionExperience && !isTranslation && youtubeTimeMs !== null;
  // Prefer the language pair snapshotted onto the item when it was first
  // produced; fall back to current props for items that predate the snapshot
  // or for transient cases where the snapshot hasn't been attached yet.
  const itemSourceLanguage = item.sourceLanguage ?? sourceLanguage;
  const itemTargetLanguage = item.targetLanguage ?? targetLanguage;
  // Prefer the language actually detected for this item's text (Soniox and
  // other providers with per-item language identification supply it) over the
  // configured source/target pair — the configured pair is wrong for two-way
  // translation and auto-detect. Falls back to the configured mapping.
  // `||` (not `??`): an empty-string detectedLanguage from a future provider
  // must fall back to the configured mapping rather than render a blank badge —
  // a language code is never legitimately falsy.
  const detectedLanguage = item.detectedLanguage;
  const lang = useMemo(
    () => detectedLanguage || languageForItem(
      source,
      role,
      itemSourceLanguage,
      itemTargetLanguage,
      capturedMediaAudio,
    ),
    [detectedLanguage, source, role, itemSourceLanguage, itemTargetLanguage, capturedMediaAudio],
  );

  const scopeName = capturedMediaAudio
    ? t('mainPanel.displayMode.videoAudio', 'Video audio')
    : t(
      source === 'speaker' ? 'mainPanel.displayMode.speaker' : 'mainPanel.displayMode.participant',
      source === 'speaker' ? 'Speaker' : 'Participant',
    );

  const renderText = () => {
    if (!isPlaying || highlightedChars <= 0) {
      return <span>{text}</span>;
    }
    if (highlightedChars >= text.length) {
      // Fully played — color the entire text, not strip the styling.
      return <span className="karaoke-played">{text}</span>;
    }
    return (
      <>
        <span className="karaoke-played">{text.slice(0, highlightedChars)}</span>
        <span>{text.slice(highlightedChars)}</span>
      </>
    );
  };

  return (
    <div
      className={`conversation-row source-${source} ${showHeader ? 'with-header' : 'grouped'} ${compact ? 'compact' : 'expanded'}${extensionExperience ? ` extension-caption-row extension-caption-${isTranslation ? 'translation' : 'source'}` : ''}`}
    >
      {!extensionExperience && !compact && showHeader && (
        <div className="row-header">
          <div className={`row-avatar avatar-${source}`}>
            {source === 'speaker' ? <User size={12} /> : <Users size={12} />}
          </div>
          <div className="row-name">
            <span className="row-name-text">{scopeName}</span>
            <span className="row-time">{formatTime(item.createdAt)}</span>
          </div>
        </div>
      )}
      <div className={`row-body ${isPlaying ? 'playing' : ''}`}>
        {showYoutubeTime && (
          <span className="row-video-time">{formatVideoTime(youtubeTimeMs)}</span>
        )}
        {!extensionExperience && compact && showHeader && (
          <span
            className={`row-role-dot source-${source}`}
            role="img"
            aria-label={scopeName}
          />
        )}
        {!extensionExperience && !compact && (
          <span className={`lang-badge ${isTranslation ? 'tr' : 'src'} source-${source}`}>
            {lang.toUpperCase()}
          </span>
        )}
        <span
          className={`row-text ${isTranslation ? 'tr' : 'src'}`}
          lang={lang.toLowerCase().replace('_', '-')}
        >
          {renderText()}
        </span>
        {!compact && onPlay && replayEnabled && isTranslation && source === 'speaker' && (
          // The play button slot is rendered for speaker translation rows whose
          // owning setting allows replay (`replayEnabled`). Within that, `canPlay`
          // toggles enabled/disabled but does NOT gate visibility — gating
          // visibility on `canPlay` would cause text re-flow when the assistant
          // item completes and the slot suddenly appears (~22 px wide).
          // When `replayEnabled` is false the slot is absent for the whole
          // session — no per-item reflow churn.
          // User rows (source transcripts) get no button (no audio); participant
          // rows get none either (text-only channel; canPlay never true).
          <button
            type="button"
            className={`row-play-btn ${isPlaying ? 'playing' : ''}`}
            onClick={canPlay ? onPlay : undefined}
            disabled={!canPlay || playDisabled}
            aria-label={t('mainPanel.playItemAudio', 'Play this item\'s audio')}
            title={t('mainPanel.playItemAudio', 'Play this item\'s audio')}
          >
            <Play size={10} />
          </button>
        )}
      </div>
    </div>
  );
};

export default ConversationRow;
