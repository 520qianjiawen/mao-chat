/**
 * Which session channels a footer mode turns on.
 *
 * You = microphone only. Others = computer/tab audio only.
 * Both = microphone and computer/tab audio, opposite directions.
 */
export function speakerChannelInScope(mode: 'speaker' | 'participant' | 'both'): boolean {
  return mode === 'speaker' || mode === 'both';
}

/**
 * The global "Text only" toggle is a caption preference. You/Both still need
 * TTS so translated speech can leave through the virtual microphone.
 */
export function speakerChannelTextOnly(
  mode: 'speaker' | 'participant' | 'both',
  textOnly: boolean,
): boolean {
  if (speakerChannelInScope(mode)) return false;
  return textOnly;
}

export function participantChannelInScope(
  mode: 'speaker' | 'participant' | 'both',
  _environment?: { electron: boolean },
): boolean {
  return mode === 'participant' || mode === 'both';
}

/** Whether connectConversation should open the participant capture pipeline. */
export function shouldStartParticipantCapture(
  mode: 'speaker' | 'participant' | 'both',
  environment: { electron: boolean },
  audioServiceReady: boolean,
): boolean {
  return participantChannelInScope(mode, environment) && audioServiceReady;
}
