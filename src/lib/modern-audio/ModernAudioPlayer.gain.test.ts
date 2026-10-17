import { describe, expect, it } from 'vitest';
import { ModernAudioPlayer } from './ModernAudioPlayer.js';

describe('ModernAudioPlayer output gain', () => {
  it('multiplies monitor mute by outputGain for the virtual-mic path', () => {
    const player = new ModernAudioPlayer({ outputGain: 2.5 });
    expect(player._effectiveGain()).toBe(0);
    player.setGlobalVolume(1);
    expect(player._effectiveGain()).toBe(2.5);
    player.setGlobalVolume(0);
    expect(player._effectiveGain()).toBe(0);
  });

  it('reports pending audio for every non-drained queue it tracks', () => {
    const player = new ModernAudioPlayer();
    expect(player.hasPendingAudio()).toBe(false);

    // Unflushed streaming accumulator.
    player.streamingBuffers.set('ai-assistant', { chunks: [new Int16Array(480)], totalLength: 480 });
    expect(player.hasPendingAudio()).toBe(true);

    // Overflow write queue.
    player.streamingBuffers.clear();
    player._pendingWrites.push(new Float32Array(480));
    expect(player.hasPendingAudio()).toBe(true);

    // Ring-queue entries not yet fully played.
    player._pendingWrites = [];
    player.itemQueue.push({ itemId: 'asst-1', startSample: 0, totalSamples: 480 });
    expect(player.hasPendingAudio()).toBe(true);

    // Currently audible item.
    player.itemQueue = [];
    player._audibleItemId = 'asst-1';
    expect(player.hasPendingAudio()).toBe(true);

    // Everything drained.
    player._audibleItemId = null;
    expect(player.hasPendingAudio()).toBe(false);
  });
});
