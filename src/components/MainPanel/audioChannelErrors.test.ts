import { describe, expect, it } from 'vitest';
import {
  classifyParticipantAudioFailure,
  participantAudioErrorText,
  shouldShowAudioCaptureDeniedModal,
} from './audioChannelErrors';

describe('shouldShowAudioCaptureDeniedModal', () => {
  it('shows the modal only until the user has dismissed it', () => {
    expect(shouldShowAudioCaptureDeniedModal(false)).toBe(true);
    expect(shouldShowAudioCaptureDeniedModal(true)).toBe(false);
  });
});

describe('participant audio error classification', () => {
  it('recognizes denied macOS screen/system-audio permission', () => {
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    expect(classifyParticipantAudioFailure(denied)).toBe('screen-permission');
    expect(classifyParticipantAudioFailure(new Error('screen-capture-permission-denied')))
      .toBe('screen-permission');
  });

  it('recognizes a previous loopback stream that is still closing', () => {
    expect(classifyParticipantAudioFailure(
      new Error('Cannot capture: The previous tab-audio stream is still closing.'),
    )).toBe('stream-closing');
  });

  it('recognizes a display stream without system audio', () => {
    expect(classifyParticipantAudioFailure(
      new Error('No audio track in loopback stream. Ensure system audio is available.'),
    )).toBe('no-audio-track');
  });

  it('preserves an unknown underlying error for the UI fallback', () => {
    const error = new Error('Native ASR failed');
    expect(classifyParticipantAudioFailure(error)).toBe('other');
    expect(participantAudioErrorText(error)).toBe('Native ASR failed');
  });
});
