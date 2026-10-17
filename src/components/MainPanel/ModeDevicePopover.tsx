import React, { useState, useMemo, useEffect } from 'react';
import {
  useFloating,
  useDismiss,
  useInteractions,
  FloatingPortal,
  offset,
  flip,
  shift,
  size,
  autoUpdate,
} from '@floating-ui/react';
import { Mic, AudioLines, Volume2, Power, PowerOff, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';
import {
  useAudioContext,
  useIsMicMuted, useIsMonitorMuted, useIsParticipantMuted,
  useSetMicMuted, useSetMonitorMuted, useSetParticipantMuted,
  useParticipantSources, useSelectedParticipantSource, useSelectParticipantSource,
} from '../../stores/audioStore';
import { isExtension } from '../../utils/environment';
import { useNavigateToSettings } from '../../stores/settingsStore';
import { isVirtualDevice, type AudioDevice } from '../Settings/shared/hooks';
import { describeDeviceOnHover } from '../../utils/audioDevices';
import './ModeDevicePopover.scss';

interface ModeDevicePopoverProps {
  mode: 'speaker' | 'participant' | 'both';
  open: boolean;
  anchorEl: HTMLElement | null;
  onClose: () => void;
}

type ChannelKey = 'mic' | 'participant' | 'monitor';

interface ChannelRowSpec {
  key: ChannelKey;
  icon: LucideIcon;
  label: string;
  // Mic + monitor: hardware devices. Extension participant: browser tabs.
  devices: AudioDevice[];
  selectedDevice: AudioDevice | null;
  /** Fallback subtitle when there is no selectable device list (desktop participant). */
  subtitle?: string;
  isMuted: boolean;
  onMuteToggle: () => void;
  onSelectDevice?: (d: AudioDevice) => void;
  /** True when row is in scope and has no device picked. */
  isMissing: boolean;
  /** Extension participant: allow expanding a tab list. */
  expandable?: boolean;
}

const ModeDevicePopover: React.FC<ModeDevicePopoverProps> = ({ mode, open, anchorEl, onClose }) => {
  const { t } = useTranslation();
  const navigateToSettings = useNavigateToSettings();

  const {
    audioInputDevices,
    audioMonitorDevices,
    selectedInputDevice,
    selectedMonitorDevice,
    selectInputDevice,
    selectMonitorDevice,
    browserTabs,
    selectedCaptureTab,
    selectCaptureTab,
    refreshBrowserTabs,
  } = useAudioContext();

  const isMicMuted = useIsMicMuted();
  const isMonitorMuted = useIsMonitorMuted();
  const isParticipantMuted = useIsParticipantMuted();
  const setMicMuted = useSetMicMuted();
  const setMonitorMuted = useSetMonitorMuted();
  const setParticipantMuted = useSetParticipantMuted();
  const participantSources = useParticipantSources();
  const selectedParticipantSource = useSelectedParticipantSource();
  const selectParticipantSource = useSelectParticipantSource();

  // Only one row expanded at a time. Default: none expanded.
  const [expanded, setExpanded] = useState<ChannelKey | null>(null);
  const [tabSwitchError, setTabSwitchError] = useState<string | null>(null);
  const [refreshingTabs, setRefreshingTabs] = useState(false);

  // When the popover opens on extension, refresh the tab list so audible tabs show up.
  useEffect(() => {
    if (!open || !isExtension()) return;
    void refreshBrowserTabs();
  }, [open, refreshBrowserTabs]);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (next) => { if (!next) onClose(); },
    placement: 'top',
    // autoUpdate watches anchor/floating size changes so expanding a row
    // (which grows the popover) triggers a re-position and re-clamp.
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      flip(),
      shift({ padding: 8 }),
      // size clamps the popover's max-height to the available space so a
      // tall expansion can't push the bottom off-screen. The popover's
      // scrollable middle section handles overflow internally.
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          // Clamp to availableHeight so the popover never exceeds the viewport
          // (an internal scroll handles overflow). The Math.max with 0 guards
          // against floating-ui handing us a transient negative value.
          Object.assign(elements.floating.style, {
            maxHeight: `${Math.max(0, availableHeight)}px`,
          });
        },
      }),
    ],
    elements: { reference: anchorEl ?? undefined },
  });

  // Exclude clicks on the anchor (the active mode-picker segment) from
  // triggering dismiss. The segment's own onClick handler in MainPanel
  // toggles the popover open/closed.
  const dismiss = useDismiss(context, {
    outsidePress: (event) => {
      const target = event.target as Node | null;
      if (anchorEl && target && anchorEl.contains(target)) return false;
      return true;
    },
  });
  const { getFloatingProps } = useInteractions([dismiss]);

  // Build the list of rows the popover should render based on mode.
  // Channel order: mic → monitor → participant
  const rows = useMemo<ChannelRowSpec[]>(() => {
    const list: ChannelRowSpec[] = [];

    const showMic = mode === 'speaker' || mode === 'both';
    // Speaker monitor is mutually exclusive with participant capture
    // (enforced in audioStore). In Both mode participant is always on,
    // so monitor cannot be on — hide the row entirely to avoid showing
    // a permanently-muted control.
    const showMonitor = mode === 'speaker';
    const showParticipant = mode === 'participant' || mode === 'both';

    // Hide Sokuji virtual devices from the device lists — they're not
    // user-selectable (they're internal routing). Mirrors what
    // AudioDeviceSection's DeviceList does in Settings.
    const filteredInputDevices = audioInputDevices.filter(d => !isVirtualDevice(d as any));
    const filteredMonitorDevices = audioMonitorDevices.filter(d => !isVirtualDevice(d as any));

    if (showMic) {
      list.push({
        key: 'mic',
        icon: Mic,
        label: t('modePicker.deviceMic', 'Microphone'),
        devices: filteredInputDevices,
        selectedDevice: selectedInputDevice,
        isMuted: isMicMuted,
        onMuteToggle: () => setMicMuted(!isMicMuted),
        onSelectDevice: (d) => { selectInputDevice(d); setMicMuted(false); },
        isMissing: !selectedInputDevice,
      });
    }

    if (showMonitor) {
      list.push({
        key: 'monitor',
        icon: Volume2,
        label: t('modePicker.deviceSpeakerMonitor', 'Speaker monitor'),
        devices: filteredMonitorDevices,
        selectedDevice: selectedMonitorDevice,
        isMuted: isMonitorMuted,
        onMuteToggle: () => setMonitorMuted(!isMonitorMuted),
        onSelectDevice: (d) => { selectMonitorDevice(d); setMonitorMuted(false); },
        isMissing: false, // monitor is optional
      });
    }

    if (showParticipant) {
      if (isExtension()) {
        // Browser tabs as selectable capture targets (one tab only at a time).
        list.push({
          key: 'participant',
          icon: AudioLines,
          label: t('modePicker.deviceTabAudio', 'Tab audio'),
          devices: browserTabs,
          selectedDevice: selectedCaptureTab,
          isMuted: isParticipantMuted,
          onMuteToggle: () => setParticipantMuted(!isParticipantMuted),
          onSelectDevice: (d) => {
            setTabSwitchError(null);
            void selectCaptureTab(d).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              setTabSwitchError(msg);
            });
          },
          isMissing: !selectedCaptureTab,
          expandable: true,
        });
      } else {
        // Desktop: whole-system capture plus one row per playing application
        // when the helper reported any. Without extra sources the old
        // "All system audio" subtitle is still the honest answer.
        const canPickSource = participantSources.length > 1;
        list.push({
          key: 'participant',
          icon: AudioLines,
          label: t('modePicker.deviceParticipantAudio', 'Participant audio'),
          devices: canPickSource ? participantSources : [],
          selectedDevice: canPickSource ? selectedParticipantSource : null,
          subtitle: canPickSource
            ? undefined
            : t('popover.participantSubtitleElectron', 'All system audio'),
          isMuted: isParticipantMuted,
          onMuteToggle: () => setParticipantMuted(!isParticipantMuted),
          onSelectDevice: canPickSource
            ? (d) => { selectParticipantSource(d); setParticipantMuted(false); }
            : undefined,
          isMissing: false,
          expandable: canPickSource,
        });
      }
    }

    return list;
  }, [
    mode,
    audioInputDevices, selectedInputDevice, isMicMuted,
    audioMonitorDevices, selectedMonitorDevice, isMonitorMuted,
    isParticipantMuted, browserTabs, selectedCaptureTab,
    participantSources, selectedParticipantSource, selectParticipantSource,
    selectInputDevice, selectMonitorDevice, selectCaptureTab,
    setMicMuted, setMonitorMuted, setParticipantMuted,
    t,
  ]);

  if (!open || !anchorEl) return null;

  const headerLabel = mode === 'speaker'
    ? t('modePicker.popoverHeaderYou', 'You — devices')
    : mode === 'participant'
      ? t('modePicker.popoverHeaderParticipants', 'Participants — devices')
      : t('modePicker.popoverHeaderBoth', 'Both — devices');

  const summaryText = (row: ChannelRowSpec): { text: string; cls: string } => {
    if (row.subtitle && !row.expandable) {
      return { text: row.subtitle, cls: row.isMuted ? 'mode-device-popover__summary--off' : '' };
    }
    if (row.isMuted) {
      return { text: t('popover.statusOff', 'Off'), cls: 'mode-device-popover__summary--off' };
    }
    if (!row.selectedDevice) {
      if (row.isMissing) {
        return { text: t('modePicker.notSelected', 'Not selected'), cls: 'mode-device-popover__summary--missing' };
      }
      return { text: t('modePicker.notSelected', 'Not selected'), cls: '' };
    }
    // Strip leading emoji markers for the one-line summary
    const raw = row.selectedDevice.label || row.selectedDevice.deviceId;
    const text = raw.replace(/^[🔊•\s]+/, '');
    return { text, cls: '' };
  };

  const handleRefreshTabs = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setRefreshingTabs(true);
    setTabSwitchError(null);
    try {
      await refreshBrowserTabs();
    } finally {
      setRefreshingTabs(false);
    }
  };

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        className="mode-device-popover"
        style={floatingStyles}
        {...getFloatingProps()}
      >
        <div className="mode-device-popover__header">{headerLabel}</div>

        <div className="mode-device-popover__scroll">
        {rows.map((row) => {
          const Icon = row.icon;
          const summary = summaryText(row);
          const isExpanded = expanded === row.key;
          // Mic/monitor: expandable by default. Desktop participant: false. Extension tab list: true.
          const canExpand = row.expandable !== false;

          return (
            <React.Fragment key={row.key}>
              <div className={`mode-device-popover__row${isExpanded ? ' mode-device-popover__row--expanded' : ''}${row.key === 'participant' ? ' mode-device-popover__row--participant' : ''}`}>
                <button
                  type="button"
                  className="mode-device-popover__row-main"
                  onClick={canExpand ? () => setExpanded(isExpanded ? null : row.key) : undefined}
                  aria-expanded={canExpand ? isExpanded : undefined}
                >
                  <Icon size={14} className="mode-device-popover__row-icon" />
                  <span className="mode-device-popover__row-label">{row.label}</span>
                  <span className={`mode-device-popover__summary ${summary.cls}`}>{summary.text}</span>
                  {canExpand ? (isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : null}
                </button>
                {row.key === 'participant' && isExtension() && (
                  <button
                    type="button"
                    className="mode-device-popover__mute-btn"
                    onClick={handleRefreshTabs}
                    title={t('popover.refreshTabs', 'Refresh tab list')}
                    aria-label={t('popover.refreshTabs', 'Refresh tab list')}
                    disabled={refreshingTabs}
                  >
                    <RefreshCw size={14} className={refreshingTabs ? 'spinning' : undefined} />
                  </button>
                )}
                <button
                  type="button"
                  className={`mode-device-popover__mute-btn${row.isMuted ? ' mode-device-popover__mute-btn--off' : ''}`}
                  onClick={(e) => { e.stopPropagation(); row.onMuteToggle(); }}
                  aria-pressed={!row.isMuted}
                  aria-label={row.isMuted
                    ? t('popover.toggleOn', 'Turn on {{label}}', { label: row.label })
                    : t('popover.toggleOff', 'Turn off {{label}}', { label: row.label })}
                  title={row.isMuted
                    ? t('popover.toggleOn', 'Turn on {{label}}', { label: row.label })
                    : t('popover.toggleOff', 'Turn off {{label}}', { label: row.label })}
                >
                  {row.isMuted ? <PowerOff size={14} /> : <Power size={14} />}
                </button>
              </div>

              {isExpanded && canExpand && (
                <div className="mode-device-popover__device-list" role="listbox" aria-label={row.label}>
                  {row.devices.length === 0 && row.key === 'participant' && (
                    <div className="mode-device-popover__device-row" style={{ opacity: 0.7, cursor: 'default' }}>
                      <span>{t('popover.noTabs', 'No capturable tabs. Open a video page and refresh.')}</span>
                    </div>
                  )}
                  {row.devices.map((d) => {
                    const selected = row.selectedDevice?.deviceId === d.deviceId;
                    return (
                      <button
                        key={d.deviceId}
                        type="button"
                        className={`mode-device-popover__device-row${selected ? ' mode-device-popover__device-row--selected' : ''}`}
                        onClick={() => row.onSelectDevice?.(d)}
                      >
                        <span title={describeDeviceOnHover(d)}>{d.label || d.deviceId}</span>
                        {selected && <span className="mode-device-popover__indicator" />}
                      </button>
                    );
                  })}
                  {row.key === 'participant' && tabSwitchError && (
                    <div className="mode-device-popover__device-row" style={{ color: '#f66', fontSize: 11, cursor: 'default' }}>
                      <span>{tabSwitchError}</span>
                    </div>
                  )}
                </div>
              )}
            </React.Fragment>
          );
        })}
        </div>

        <div className="mode-device-popover__divider" />
        <div className="mode-device-popover__footer">
          <button
            type="button"
            className="mode-device-popover__footer-link"
            onClick={() => {
              // navigateToSettings(null) is a no-op — MainLayout opens the
              // panel only on a truthy target. Pass the popover's current
              // mode as the section anchor so the user lands on the most
              // relevant section.
              const target = mode === 'speaker' ? 'microphone'
                : mode === 'participant' ? 'participant'
                : 'microphone';
              navigateToSettings(target);
              onClose();
            }}
          >
            {t('modePicker.popoverFooter', 'Full settings →')}
          </button>
        </div>
      </div>
    </FloatingPortal>
  );
};

export default ModeDevicePopover;
