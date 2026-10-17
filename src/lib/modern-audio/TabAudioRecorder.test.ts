import { describe, expect, it } from 'vitest';
import { humanizeTabCaptureError } from './TabAudioRecorder';

describe('humanizeTabCaptureError', () => {
  it('guides the user when Chrome activeTab was never granted', () => {
    const msg = humanizeTabCaptureError(
      'Extension has not been invoked for the current page (see activeTab permission).',
    );
    expect(msg.toLowerCase()).toContain('toolbar icon');
    expect(msg.toLowerCase()).toContain('start');
  });

  it('mentions stream expiry for invalid stream ids', () => {
    const msg = humanizeTabCaptureError('Invalid stream id');
    expect(msg.toLowerCase()).toMatch(/stream|start again/);
  });

  it('keeps unknown chrome messages', () => {
    expect(humanizeTabCaptureError('weird chrome bug XYZ')).toContain('weird chrome bug XYZ');
  });

  it('handles empty input', () => {
    expect(humanizeTabCaptureError('')).toMatch(/MAO Chat icon/i);
  });
});
