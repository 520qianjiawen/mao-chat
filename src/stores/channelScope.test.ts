import { describe, expect, it } from 'vitest';
import { participantChannelInScope, shouldStartParticipantCapture, speakerChannelInScope } from './channelScope';

describe('channelScope', () => {
  it('speaker channel is on for You and Both', () => {
    expect(speakerChannelInScope('speaker')).toBe(true);
    expect(speakerChannelInScope('both')).toBe(true);
    expect(speakerChannelInScope('participant')).toBe(false);
  });

  it('You never starts the participant channel', () => {
    expect(participantChannelInScope('speaker', { electron: true })).toBe(false);
    expect(participantChannelInScope('speaker', { electron: false })).toBe(false);
  });

  it('Others and Both always start the participant channel', () => {
    expect(participantChannelInScope('participant', { electron: true })).toBe(true);
    expect(participantChannelInScope('both', { electron: false })).toBe(true);
  });
});

describe('shouldStartParticipantCapture', () => {
  it('does not start system-audio capture for desktop You', () => {
    expect(shouldStartParticipantCapture('speaker', { electron: true }, true)).toBe(false);
  });

  it('does not start tab capture for extension You', () => {
    expect(shouldStartParticipantCapture('speaker', { electron: false }, true)).toBe(false);
  });

  it('does not start when the audio service is missing', () => {
    expect(shouldStartParticipantCapture('both', { electron: true }, false)).toBe(false);
  });
});
