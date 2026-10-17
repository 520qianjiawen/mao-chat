import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { User, Users, ArrowLeftRight, Monitor, Mic, type LucideIcon } from 'lucide-react';
import './ModePicker.scss';

export type FooterMode = 'speaker' | 'participant' | 'both';

interface ModePickerProps {
  mode: FooterMode;
  locked: boolean;
  missingDeviceForMode: 'speaker' | 'participant' | 'both' | null;
  onSegmentClick: (segment: 'speaker' | 'participant' | 'both', el: HTMLElement) => void;
  /** Browser-video wording: participant audio is the current tab, not a person/device. */
  extensionCaptureLabels?: boolean;
  /** Restrict the rendered segments when a compact footer only needs the active source. */
  visibleModes?: FooterMode[];
}

const SEGMENTS: Array<'speaker' | 'participant' | 'both'> = ['speaker', 'participant', 'both'];
const EXTENSION_SEGMENTS: Array<'speaker' | 'participant' | 'both'> = ['participant', 'speaker', 'both'];

// Reuse the User / Users icons from DisplayModeButton for visual consistency
// with the subtitle display toggles. ArrowLeftRight for 'both' conveys
// bidirectional translation.
const SEGMENT_ICONS: Record<'speaker' | 'participant' | 'both', LucideIcon> = {
  speaker: User,
  participant: Users,
  both: ArrowLeftRight,
};

const EXTENSION_SEGMENT_ICONS: Record<'speaker' | 'participant' | 'both', LucideIcon> = {
  speaker: Mic,
  participant: Monitor,
  both: ArrowLeftRight,
};

const ModePicker: React.FC<ModePickerProps> = ({
  mode,
  locked,
  missingDeviceForMode,
  onSegmentClick,
  extensionCaptureLabels = false,
  visibleModes,
}) => {
  const { t } = useTranslation();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const labelFor = (seg: 'speaker' | 'participant' | 'both') => {
    if (extensionCaptureLabels) {
      if (seg === 'speaker') return t('modePicker.extensionMic', 'Mic');
      if (seg === 'participant') return t('modePicker.extensionTab', 'Tab');
      return t('modePicker.modeBoth', 'Both');
    }
    if (seg === 'speaker') return t('modePicker.modeYou', 'You');
    if (seg === 'participant') return t('modePicker.modeParticipants', 'Others');
    return t('modePicker.modeBoth', 'Both');
  };

  // Plain-language description of what each mode translates and in which
  // direction. Leads every tooltip so the mode's *meaning* is always
  // available on hover (the bare "You / Others / Both" labels don't convey it).
  const descFor = (seg: 'speaker' | 'participant' | 'both') => {
    if (extensionCaptureLabels) {
      if (seg === 'speaker') return t('modePicker.extensionMicDesc', 'Translate sound from your microphone.');
      if (seg === 'participant') return t('modePicker.extensionTabDesc', 'Translate sound from the video in this browser tab.');
      return t('modePicker.extensionBothDesc', 'Translate this tab and your microphone at the same time.');
    }
    if (seg === 'speaker') return t('modePicker.descYou', 'Microphone only. Source is the language you speak; target is the language others hear.');
    if (seg === 'participant') return t('modePicker.descOthers', 'Computer audio only. Source is the language they speak; target is the language you want to read.');
    return t('modePicker.descBoth', 'Two-way. Your language and their language translate into each other. Both must be set — no automatic detection.');
  };

  const titleFor = (seg: 'speaker' | 'participant' | 'both') => {
    const isActive = seg === mode;
    const desc = descFor(seg);
    if (locked) {
      // In-session: only the active segment is clickable (to open the
      // device popover for the currently-running channels). Inactive
      // segments are visually locked.
      return isActive
        ? `${desc}\n${t('modePicker.configureDevices', 'Click to configure devices.')}`
        : `${desc}\n${t('modePicker.switchDisabled', 'Mode is locked during a session.')}`;
    }
    if (missingDeviceForMode === seg || (missingDeviceForMode === 'both' && (seg === 'speaker' || seg === 'participant'))) {
      return `${desc}\n${t('modePicker.missingDevice', 'Configure devices for this mode to start.')}`;
    }
    if (isActive) return `${desc}\n${t('modePicker.configureDevices', 'Click to configure devices.')}`;
    // Inactive + switchable: the description alone tells the user what they'd
    // get; the unselected segment already signals it's clickable.
    return desc;
  };

  return (
    <div className={`mode-picker${locked ? ' mode-picker--locked' : ''}`} role="group" aria-label={t('modePicker.groupLabel', 'Translation mode')}>
      {(extensionCaptureLabels ? EXTENSION_SEGMENTS : SEGMENTS)
        .filter((seg) => !visibleModes?.length || visibleModes.includes(seg))
        .map((seg) => {
          const isActive = mode === seg;
          const isWarn =
            missingDeviceForMode === seg ||
            (missingDeviceForMode === 'both' && (seg === 'speaker' || seg === 'participant'));
          const classes = [
            'mode-picker__segment',
            isActive ? 'mode-picker__segment--active' : '',
            isWarn ? 'mode-picker__segment--warn' : '',
          ].filter(Boolean).join(' ');
          const Icon = (extensionCaptureLabels ? EXTENSION_SEGMENT_ICONS : SEGMENT_ICONS)[seg];
          const label = labelFor(seg);
          // When locked, only the active segment stays clickable (opens
          // the device popover). Inactive segments are disabled so the
          // user can't accidentally try to switch mid-session.
          const isDisabled = locked && !isActive;
          return (
            <button
              key={seg}
              ref={(el) => { refs.current[seg] = el; }}
              type="button"
              className={classes}
              aria-pressed={isActive}
              aria-label={label}
              disabled={isDisabled}
              title={titleFor(seg)}
              onClick={() => {
                if (isDisabled) return;
                const el = refs.current[seg];
                if (el) onSegmentClick(seg, el);
              }}
            >
              <Icon size={14} />
              <span className="mode-picker__label">{label}</span>
            </button>
          );
        })}
    </div>
  );
};

export default ModePicker;
