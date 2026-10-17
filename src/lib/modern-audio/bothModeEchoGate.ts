/** Mean absolute amplitude in [0, 1]. */
export function pcmMeanAbs(samples: Int16Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sum += s < 0 ? -s : s;
  }
  return sum / samples.length / 32768;
}

/**
 * Both-mode isolation: computer audio must not be treated as the user's mic,
 * and our own TTS must not be treated as the other party.
 *
 * The user's screenshot (讲者 + ZH/EN both English) is the mic hearing
 * WeChat from the speakers and running 中→英 on English.
 */
export class BothModeEchoGate {
  /** System / computer audio above this counts as "they are speaking". */
  systemSpeechThreshold = 0.022;
  /** Last computer-audio level, for a relative comparison with the mic. */
  private lastSystemLevel = 0;
  private lastSystemAt = 0;
  /** Only suppress the mic while computer audio is clearly louder. */
  systemHoldMs = 280;
  /**
   * Keep suppressing the system channel this long after our TTS stops.
   * The loopback capture lags the actual output (driver + capture latency),
   * so without the hold the tail of each synthesized utterance is
   * re-transcribed and re-translated — the "system talks to itself"
   * fragments (e.g. "Okay." / "I'm." / "The."). macOS screen-capture loopback
   * can lag the output by 1-2s, so the tail must be longer than the gap.
   */
  ttsEchoHoldMs = 2000;
  private ttsEchoHoldUntil = 0;

  /** Extend the suppression window; called while assistant audio is playing/enqueued. */
  noteTtsPlayback(now = Date.now()): void {
    const until = now + this.ttsEchoHoldMs;
    if (until > this.ttsEchoHoldUntil) this.ttsEchoHoldUntil = until;
  }

  /** True while the system channel should stay suppressed (TTS active or recent). */
  isSuppressingSystemAudio(now = Date.now()): boolean {
    return now < this.ttsEchoHoldUntil;
  }

  noteSystemAudio(samples: Int16Array, now = Date.now()): void {
    const level = pcmMeanAbs(samples);
    if (level >= this.systemSpeechThreshold) {
      this.lastSystemLevel = level;
      this.lastSystemAt = now;
    }
  }

  /** True = do not send this mic chunk to the speaker (You) ASR. */
  shouldDropMic(samples: Int16Array, ttsPlaying = false, now = Date.now()): boolean {
    const micLevel = pcmMeanAbs(samples);
    // Our own TTS (or its loopback tail) must never suppress the microphone.
    // The relative-loudness test exists for real computer audio (e.g. WeChat
    // in a meeting); our synthesized voice would otherwise drown out the
    // user right after an utterance.
    if (now < this.ttsEchoHoldUntil) return false;
    void ttsPlaying;
    const systemRecent = now - this.lastSystemAt < this.systemHoldMs;
    // Near-field mic speech is usually louder than speaker bleed. Only
    // drop the mic when computer audio is at least as loud — otherwise the
    // first "你好吗" gets clipped and comes out as English.
    if (systemRecent && this.lastSystemLevel >= micLevel * 0.85) {
      return true;
    }
    return false;
  }

  /** True = do not send this computer-audio chunk to the Others ASR. */
  shouldDropSystemAudio(ttsPlaying: boolean, now = Date.now()): boolean {
    if (ttsPlaying) this.noteTtsPlayback(now);
    return now < this.ttsEchoHoldUntil;
  }
}
