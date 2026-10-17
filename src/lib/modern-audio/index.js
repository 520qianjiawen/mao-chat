/**
 * Modern Audio Library
 * Echo cancellation friendly audio processing using standard browser APIs
 */

export { ModernAudioRecorder } from './ModernAudioRecorder';
export { ModernAudioPlayer } from './ModernAudioPlayer.js';
export { ModernBrowserAudioService } from './ModernBrowserAudioService';
export { LoopbackRecorder } from './LoopbackRecorder';
export { TabAudioRecorder } from './TabAudioRecorder';
export { AppAudioRecorder } from './AppAudioRecorder';
export { DeviceCaptureRecorder } from './DeviceCaptureRecorder';
export { resolveParticipantSourceId, isApplicationSource, needsLoopbackStream, SYSTEM_PARTICIPANT_SOURCE_ID } from './participantSource';

// Participant audio interface and base classes
export { IParticipantAudioRecorder, ParticipantAudioOptions, AudioDataCallback, isParticipantAudioRecorder } from './IParticipantAudioRecorder';
export { BaseAudioRecorder } from './BaseAudioRecorder';
export { ParticipantRecorder } from './ParticipantRecorder';
export { WebRTCAudioBridge } from './WebRTCAudioBridge';

// Re-export for compatibility
export const WavRecorder = ModernAudioRecorder;
export const WavStreamPlayer = ModernAudioPlayer;