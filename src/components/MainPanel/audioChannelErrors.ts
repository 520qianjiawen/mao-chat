/** Persisted after the user dismisses the audio-capture permission modal. */
export const AUDIO_CAPTURE_WARNING_DISMISSED_KEY = 'audio.audioCaptureWarningDismissed';

/** The helper infers a TCC denial from silence. Once the user has seen that
 *  explanation, do not block every later session with the same modal. */
export function shouldShowAudioCaptureDeniedModal(alreadyDismissed: boolean): boolean {
  return !alreadyDismissed;
}

export type ParticipantAudioFailureKind =
  | 'screen-permission'
  | 'stream-closing'
  | 'no-audio-track'
  | 'other';

/** Keep browser/Electron media errors useful after they cross async layers. */
export function participantAudioErrorText(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  if (typeof error === 'string') return error.trim();
  return '';
}

/** Classify the common macOS loopback failures for concise, actionable UI copy. */
export function classifyParticipantAudioFailure(error: unknown): ParticipantAudioFailureKind {
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  const message = participantAudioErrorText(error).toLowerCase();

  if (
    name === 'notallowederror' ||
    message.includes('screen-capture-permission-denied') ||
    message.includes('screen capture permission denied') ||
    message.includes('screen recording permission denied') ||
    message.includes('permission denied')
  ) {
    return 'screen-permission';
  }

  if (
    message.includes('active stream') ||
    message.includes('stream is still closing') ||
    message.includes('stream still closing')
  ) {
    return 'stream-closing';
  }

  if (
    name === 'notfounderror' ||
    message.includes('no audio track') ||
    message.includes('no screen source') ||
    message.includes('no suitable capture source')
  ) {
    return 'no-audio-track';
  }

  return 'other';
}
