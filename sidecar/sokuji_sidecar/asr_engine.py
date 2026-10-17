import asyncio
import dataclasses
import os
import queue
import re
import time
import numpy as np

TARGET_RATE = 16000
SRC_RATE = 24000
# Live subtitles need completed chunks before translation can begin. Prefer a
# natural sentence ending after a short phrase; continuous speech is capped so
# news/live streams do not wait for a long silence (pause-the-video) to flush.
LIVE_SENTENCE_MIN_SECONDS = 2.5
LIVE_SEGMENT_MAX_SECONDS = 1.5
# Batch ASR (Qwen3 / SenseVoice / Whisper): emit a growing partial every
# 500ms of speech so the UI is not stuck waiting for a VAD endpoint.
LIVE_PARTIAL_MIN_SECONDS = 0.4
LIVE_PARTIAL_INTERVAL_SECONDS = 0.5
LIVE_PARTIAL_WINDOW_SECONDS = 8.0
BATCH_PREROLL_SECONDS = 1.0
HAYAMIMI_GROUP_GAP_SECONDS = 2.0
HAYAMIMI_GROUP_MAX_SECONDS = 25.0
HAYAMIMI_REFINE_MIN_SECONDS = 0.5
_FLUSH = object()  # live-pipeline sentinel: drain the current utterance
_SENTENCE_END_RE = re.compile(r'[.!?。！？…][\"\'”’）)]?\s*$')
_CLOSED_CLASS = {
    'the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'by', 'for',
    'and', 'or', 'but', 'is', 'are', 'was', 'be', 'it', 'as',
}
_INCOMPLETE_LAST = _CLOSED_CLASS | {
    'because', 'if', 'when', 'while', 'from', 'into', 'onto',
    'including', 'that', 'which', 'who', 'have', 'has', 'will',
    'would', 'can', 'could', 'should',
}


def _share_stem(a, b):
    if not a or not b:
        return False
    if a == b:
        return True
    if a in _CLOSED_CLASS or b in _CLOSED_CLASS:
        return False
    if len(a) < 4 or len(b) < 4:
        return False
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    if longer.startswith(shorter):
        return True
    n = 0
    for ca, cb in zip(shorter, longer):
        if ca != cb:
            break
        n += 1
    return n >= 3 and abs(len(a) - len(b)) <= 2


def _ends_sentence(text):
    """True only for a period that is long enough to be a real sentence.

    Streaming ASR appends '.' at VAD cuts ('the Navy.', 'allies by.'); those
    must not end the stream — the JS segmenter merges the next tail.
    """
    if not text or not _SENTENCE_END_RE.search(text):
        return False
    core = _TRAIL_PUNCT_RE.sub('', text).strip()
    words = [w.strip('.,;:!?\"\'') for w in core.split() if w.strip('.,;:!?\"\'')]
    if len(words) < 12:
        return False
    last = words[-1].lower() if words else ''
    if last in _INCOMPLETE_LAST:
        return False
    return True


_CJK_RE = re.compile(r'[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]')
_HAN_KANA_RE = re.compile(r'[\u3400-\u9fff\u3040-\u30ff]')
_TRAIL_PUNCT_RE = re.compile(r'[.!?。！？…、,;；]+$')


def _mostly_cjk(text):
    visible = [ch for ch in str(text or '') if not ch.isspace()]
    if not visible:
        return False
    cjk = sum(1 for ch in visible if _CJK_RE.match(ch))
    return cjk / len(visible) >= 0.5


def _mostly_han_kana(text):
    visible = [ch for ch in str(text or '') if not ch.isspace()]
    if not visible:
        return False
    return sum(1 for ch in visible if _HAN_KANA_RE.match(ch)) / len(visible) >= 0.5


def collapse_long_repetition(text):
    """Remove long, immediately repeated ASR spans.

    Hayamimi's whole-group second pass occasionally emits ``A A`` or
    ``B B+tail``. The thresholds deliberately ignore ordinary conversational
    repeats such as ``はいはい`` and ``very very``.
    """
    source = str(text or '').strip()
    if not source:
        return ''

    if _mostly_han_kana(source):
        units = list(re.sub(r'\s+', '', source))
        normalized = units.copy()
        minimum = 12
    else:
        units = source.split()
        normalized = [
            re.sub(r'^[^\w\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+|'
                   r'[^\w\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+$', '', token).lower()
            for token in units
        ]
        minimum = 5

    while len(units) >= minimum * 2:
        best = None
        for boundary in range(minimum, len(units) - minimum + 1):
            largest = min(boundary, len(units) - boundary, 300)
            for width in range(largest, minimum - 1, -1):
                if normalized[boundary - width:boundary] == normalized[boundary:boundary + width]:
                    if any(normalized[boundary - width:boundary]):
                        if best is None or width > best[1]:
                            best = (boundary, width)
                    break
        if best is None:
            break
        boundary, width = best
        # Keep the second copy because it may continue with the non-repeated
        # tail (``B B+tail``) and usually has the better final punctuation.
        del units[boundary - width:boundary]
        del normalized[boundary - width:boundary]

    return ''.join(units) if _mostly_han_kana(source) else ' '.join(units)


def _is_exact_long_double(text):
    """True for a complete long ``A A`` transcript, not ``A A + tail``.

    An exact repeated utterance can be real speech, so the refinement guard
    preserves it when both the live and refined passes agree. Repetition with
    a continuation is the rolling/hallucinated shape we should collapse.
    """
    source = str(text or '').strip()
    if _mostly_han_kana(source):
        units = list(re.sub(r'\s+', '', source))
        minimum = 12
    else:
        units = [
            re.sub(r'^[^\w\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+|'
                   r'[^\w\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+$', '', token).lower()
            for token in source.split()
        ]
        units = [unit for unit in units if unit]
        minimum = 5
    half = len(units) // 2
    return len(units) >= minimum * 2 and len(units) % 2 == 0 \
        and units[:half] == units[half:]


def guarded_refined_text(refined, fast_text):
    """Deduplicate a second pass without allowing substantial content loss."""
    fast = str(fast_text or '').strip()
    refined_source = str(refined or '').strip()
    if (_is_exact_long_double(refined_source)
            and collapse_long_repetition(refined_source) == collapse_long_repetition(fast)):
        return refined_source
    # The live pass may itself contain rolling-window overlap. Compare the
    # polished candidate with a clean baseline; otherwise a valid dedupe can
    # look 30% shorter and the old guard restores the duplicated live text.
    clean_fast = collapse_long_repetition(fast)
    candidate = collapse_long_repetition(refined)
    baseline = clean_fast or fast
    if len(candidate.strip()) < 0.7 * len(baseline):
        return baseline
    return candidate or baseline


def hayamimi_final_delta(previous, incoming):
    """Strip only a clear ``previous + new tail`` Hayamimi final overlap.

    Equal consecutive finals are retained because the speaker may genuinely
    repeat a phrase. Independent utterances are also retained unchanged.
    """
    prev = str(previous or '').strip()
    nxt = str(incoming or '').strip()
    if not prev or not nxt or nxt == prev:
        return nxt
    prev_core = _TRAIL_PUNCT_RE.sub('', prev).strip()
    if prev_core and len(nxt) > len(prev_core) and nxt.lower().startswith(prev_core.lower()):
        tail = nxt[len(prev_core):].lstrip(' \t.,;:!?。！？…、')
        if tail:
            return tail
    return nxt


def novel_asr_text(published, incoming):
    """Return the suffix of `incoming` not already covered by `published`.

    Rolling-window ASR re-emits the whole hypothesis; committed tokens must
    never be appended again. Empty string means the incoming span is covered.
    """
    prev = str(published or '').strip()
    nxt = str(incoming or '').strip()
    if not nxt:
        return ''
    if not prev:
        return nxt
    if nxt == prev:
        return ''
    prev_core = _TRAIL_PUNCT_RE.sub('', prev)
    if nxt == prev_core:
        return ''
    prev_cmp = prev_core.lower()
    nxt_cmp = nxt.lower()
    if nxt_cmp == prev_cmp:
        return ''
    if nxt_cmp.startswith(prev_cmp):
        return nxt[len(prev_core):].strip()
    if prev_cmp.endswith(nxt_cmp) and len(prev_core) >= len(nxt):
        return ''
    cjk = _mostly_cjk(prev_core + nxt)
    if cjk:
        a = list(prev_core.replace(' ', ''))
        b = list(_TRAIL_PUNCT_RE.sub('', nxt).replace(' ', ''))
    else:
        a = [w.strip('.,;:!?\"\'') for w in prev_core.lower().split() if w.strip('.,;:!?\"\'')]
        b = [w.strip('.,;:!?\"\'') for w in _TRAIL_PUNCT_RE.sub('', nxt).lower().split() if w.strip('.,;:!?\"\'')]
    max_k = min(len(a), len(b))
    min_k = 2 if cjk else 1
    for k in range(max_k, min_k - 1, -1):
        stem_at = None
        match = True
        for i in range(k):
            pa = a[-k + i]
            pb = b[i]
            if pa == pb:
                continue
            if not cjk and i == k - 1 and _share_stem(pa, pb):
                stem_at = i
                continue
            match = False
            break
        if match:
            from_i = stem_at if stem_at is not None else k
            rest = b[from_i:]
            tail = ''.join(rest) if cjk else ' '.join(rest)
            punct = _TRAIL_PUNCT_RE.search(nxt)
            if tail and punct and not _TRAIL_PUNCT_RE.search(tail):
                tail += punct.group(0)
            return tail
    return nxt


# Gated-streaming pre-roll: silero confirms speech 300-600ms after the true
# onset (threshold ramp + min_speech_duration) — keep this much audio to
# replay into a fresh stream so utterances don't lose their first words.
PREROLL_SAMPLES = int(0.7 * TARGET_RATE)

# sherpa-onnx silero VAD is documented in the k2-fsa releases (the same GitHub-release
# source as scripts/download-sherpa-wasm.sh). No clean HuggingFace mirror matches the
# exact signature sherpa expects, so resolve it from the release (override via env).
VAD_URL = os.environ.get(
    "SOKUJI_VAD_URL",
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx")


class AudioHistory:
    """Rolling batch-audio history used to restore VAD's missed onset."""

    def __init__(self, sample_rate=TARGET_RATE, keep_seconds=30.0):
        self.sample_rate = sample_rate
        self.keep = int(keep_seconds * sample_rate)
        self.buffer = np.zeros(0, dtype=np.float32)
        self.offset = 0
        self.last_segment_end = 0

    def push(self, samples):
        pcm = np.asarray(samples, dtype=np.float32).reshape(-1)
        self.buffer = np.concatenate([self.buffer, pcm])
        if self.buffer.size > self.keep:
            drop = self.buffer.size - self.keep
            self.buffer = self.buffer[drop:]
            self.offset += drop

    def with_preroll(self, segment_start, segment_samples):
        pcm = np.asarray(segment_samples, dtype=np.float32).reshape(-1)
        wanted = max(
            int(segment_start) - int(BATCH_PREROLL_SECONDS * self.sample_rate),
            self.last_segment_end,
            self.offset,
        )
        before = self.buffer[
            max(0, wanted - self.offset):max(0, int(segment_start) - self.offset)
        ]
        self.last_segment_end = int(segment_start) + pcm.size
        return np.concatenate([before, pcm]) if before.size else pcm

    def slice(self, start, end):
        """Copy an absolute sample range that is still present in history."""
        lo = max(int(start), self.offset)
        hi = min(int(end), self.offset + self.buffer.size)
        if hi <= lo:
            return np.zeros(0, dtype=np.float32)
        return self.buffer[lo - self.offset:hi - self.offset].copy()


def _downsample_int16_to_f32_16k(int16_bytes, src_rate=SRC_RATE):
    if not int16_bytes:
        return np.zeros(0, dtype=np.float32)
    x = np.frombuffer(int16_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    if src_rate == TARGET_RATE:
        return x
    ratio = TARGET_RATE / src_rate
    n = round(len(x) * ratio)
    pos = np.arange(n) / ratio
    i0 = np.floor(pos).astype(np.int64)
    frac = (pos - i0).astype(np.float32)
    a = x[np.clip(i0, 0, len(x) - 1)]
    b = x[np.clip(i0 + 1, 0, len(x) - 1)]
    return (a + (b - a) * frac).astype(np.float32)


def _resolve_vad_model(model_dir=None):
    """Order: explicit SOKUJI_VAD_FILE → silero_vad.onnx shipped in the model dir →
    download the canonical file from the k2-fsa release into the HF cache."""
    explicit = os.environ.get("SOKUJI_VAD_FILE")
    if explicit and os.path.exists(explicit):
        return explicit
    if model_dir and os.path.exists(f"{model_dir}/silero_vad.onnx"):
        return f"{model_dir}/silero_vad.onnx"
    import urllib.request
    cache = os.path.join(
        os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface")), "sokuji-vad")
    os.makedirs(cache, exist_ok=True)
    dst = os.path.join(cache, "silero_vad.onnx")
    if not os.path.exists(dst):
        urllib.request.urlretrieve(VAD_URL, dst)
    return dst


class AsrEngine:
    """silero VAD segmentation + a pluggable recognizer. Feed Int16 bytes, get text per VAD segment.

    The silero VAD must be fed in fixed window_size (512-sample @16k) chunks, so feed()
    buffers the downsampled audio and only consumes whole windows; the remainder carries
    over to the next feed().
    """

    def __init__(self):
        self._vad = None
        self._backend = None
        self._language = None
        # Hayamimi's second pass is optional: subtitle mode toggles it at
        # runtime so the live surface only receives the fast transcript.
        self._refinement_enabled = True
        self._refinement_generation = 0
        self.resolved = None
        self._window = 512
        self._buf = np.zeros(0, np.float32)
        self._src_rate = SRC_RATE
        # Pre-roll ring (gated streaming): the last ~0.7s of audio, replayed
        # into a fresh stream at silero's rising edge — detection lags the true
        # onset by 300-600ms and that audio used to be silently dropped.
        self._preroll = []
        self._preroll_len = 0
        self._history = AudioHistory()

    def _init_vad(self, sample_rate, vad_threshold, vad_min_silence, vad_min_speech,
                  vad_max_speech=None):
        import sherpa_onnx  # lazy: native lib pulled here
        self._src_rate = int(sample_rate)
        vad_cfg = sherpa_onnx.VadModelConfig()
        vad_cfg.silero_vad.model = _resolve_vad_model()
        if vad_threshold is not None:
            vad_cfg.silero_vad.threshold = float(vad_threshold)
        if vad_min_silence is not None:
            vad_cfg.silero_vad.min_silence_duration = float(vad_min_silence)
        if vad_min_speech is not None:
            vad_cfg.silero_vad.min_speech_duration = float(vad_min_speech)
        # Batch models only emit when Silero closes a segment. Cap continuous
        # speech so live video does not wait for a pause (or the old 6–20s
        # utterance) before the first subtitle.
        max_speech = float(vad_max_speech) if vad_max_speech else LIVE_SEGMENT_MAX_SECONDS
        max_speech = max(0.6, min(max_speech, 30.0))
        vad_cfg.silero_vad.max_speech_duration = max_speech
        vad_cfg.sample_rate = TARGET_RATE
        self._window = vad_cfg.silero_vad.window_size
        self._buf = np.zeros(0, np.float32)
        self._vad = sherpa_onnx.VoiceActivityDetector(vad_cfg, buffer_size_in_seconds=30)
        self._max_speech_seconds = max_speech
        self._max_speech_samples = int(max_speech * TARGET_RATE)
        self._partial_interval = int(LIVE_PARTIAL_INTERVAL_SECONDS * TARGET_RATE)
        self._partial_min = int(LIVE_PARTIAL_MIN_SECONDS * TARGET_RATE)
        self._utt_pcm = []
        self._utt_samples = 0
        self._next_partial = self._partial_min
        self._last_partial_text = ""
        self._pcm_cursor = 0
        self._utt_start_sample = 0
        self._published_text = ""
        self._history = AudioHistory(TARGET_RATE)

    def init(self, model_id=None, language="", sample_rate=SRC_RATE,
             vad_threshold=None, vad_min_silence=None, vad_min_speech=None, device="auto",
             pin=None, vad_max_speech=None, refinement_enabled=True):
        from . import accel
        t0 = time.time()
        # Free any previously-loaded model BEFORE loading the next. The engine is a
        # process singleton reused across sessions; without this, re-init piles a second
        # model into VRAM (PyTorch's caching allocator never returns it) and usage climbs.
        self.close()
        self._init_vad(sample_rate, vad_threshold, vad_min_silence, vad_min_speech,
                       vad_max_speech=vad_max_speech)
        # Resolve the fastest available backend+device; CPU floor guaranteed.
        resolved_model = model_id or "hayamimi-asr"
        self._model_id = resolved_model
        self._is_hayamimi = resolved_model == "hayamimi-asr"
        self._hayamimi_last_final_text = ""
        self._hayamimi_spans = []
        self._refinement_enabled = bool(refinement_enabled)
        self._refinement_generation += 1
        self._next_segment_id = 1
        plans = accel.resolve(resolved_model, override=device or "auto", pin=pin)
        plans = [
            dataclasses.replace(
                plan,
                config=dataclasses.replace(plan.config, asr_language=language or ""),
            ) if hasattr(plan, "config") else plan
            for plan in plans
        ]
        self._backend, plan, notice, mem = accel.load_measured(plans, stage="asr")
        self._language = language or None
        # Hayamimi Auto loads its specialist lazily after LID. The generic
        # synthetic benchmark would include that one-time model load, publish
        # a misleading ~1x RTF, and preload a random tone-selected language.
        bench = not (resolved_model == "hayamimi-asr" and language == "auto")
        rtf = (accel.measure_rtf(self._backend, plan, resolved_model, accel.probe())
               if bench else None)
        reset_session = getattr(self._backend, "reset_session", None)
        if reset_session is not None:
            reset_session()
        self.resolved = {"backend": plan.backend, "device": plan.device,
                         "computeType": plan.compute_type}
        if rtf is not None:
            self.resolved["rtf"] = round(rtf, 3)
        if mem is not None:
            self.resolved["memoryBytes"] = mem
        if notice:
            self.resolved["fallbackReason"] = notice
        # Surface the ACTUAL backend/device the session resolved to. A non-'auto'
        # compute-device choice only reorders plans, so a GPU-only model still loads
        # on CUDA even when 'cpu' was requested — this line makes that visible.
        import sys
        print(f"[sokuji-sidecar] ASR ready: model={resolved_model} "
              f"backend={plan.backend} device={plan.device} compute={plan.compute_type}"
              + (f" rtf={rtf:.3f} (~{1 / rtf:.0f}x realtime)" if rtf else "")
              + f"  [requested device={device or 'auto'}]", file=sys.stderr, flush=True)
        # Batch engines share the same live pipeline as streaming engines:
        # audio is queued, recognition runs off the websocket thread.
        self._attach_live_queue()
        self._mode = "batch_live"
        self._stream = None
        return int((time.time() - t0) * 1000)

    def _attach_live_queue(self):
        import queue as _queue
        self._audio_q = _queue.Queue()
        self._stop = False
        self._asr_busy = False
        self._partial_dirty = False

    def close(self):
        """Free the loaded ASR model and its GPU memory. Idempotent — called at the start
        of each init() and when a session connection closes, so VRAM never accumulates.
        Also ends any open streaming session (its generate thread holds an independent
        model reference that unload() alone cannot reclaim)."""
        from . import accel
        accel.ledger_release("asr")
        self._stop = True
        stream = getattr(self, "_stream", None)
        if stream is not None:
            try:
                stream.abort()
            except Exception:
                pass
            self._stream = None
        q = getattr(self, "_audio_q", None)   # unblock run_stream's queue.get promptly
        if q is not None:
            try:
                q.put_nowait(None)
            except Exception:
                pass
        backend = self._backend
        self._backend = None
        if backend is not None:
            try:
                backend.unload()
            except Exception:
                pass
        self._hayamimi_spans = []
        self._is_hayamimi = False
        self._model_id = None

    def _reset_utterance(self):
        self._utt_pcm = []
        self._utt_samples = 0
        self._next_partial = getattr(self, "_partial_min", 0)
        self._last_partial_text = ""

    def _transcribe_pcm(self, chunks):
        if not chunks:
            return ""
        samples = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
        return self._transcribe_samples(samples)

    def _recognize_samples(self, samples, partial=False):
        from .backends import AsrResult

        if samples is None:
            return AsrResult("", self._language)
        pcm = np.asarray(samples, dtype=np.float32).reshape(-1)
        min_samples = getattr(self, "_partial_min", int(LIVE_PARTIAL_MIN_SECONDS * TARGET_RATE))
        if pcm.size < min_samples:
            return AsrResult("", self._language)
        try:
            method = (getattr(self._backend, "transcribe_partial", None)
                      if partial else None)
            result = (method(pcm, self._language) if method is not None
                      else self._backend.transcribe(pcm, self._language))
            if isinstance(result, str):
                return AsrResult(result.strip(), self._language)
            return AsrResult(
                str(getattr(result, "text", "") or "").strip(),
                getattr(result, "language", None) or self._language,
            )
        except Exception:
            return AsrResult("", self._language)

    def _transcribe_samples(self, samples):
        """Compatibility helper retained for backend-agnostic unit tests."""
        return self._recognize_samples(samples).text

    def _pop_vad_segments(self, with_preroll=True):
        segs = []
        while not self._vad.empty():
            segment = self._vad.front
            samples = np.asarray(segment.samples, dtype=np.float32).copy()
            if with_preroll:
                start = int(getattr(segment, "start", max(
                    0, getattr(self, "_pcm_cursor", 0) - samples.size,
                )))
                samples = self._history.with_preroll(start, samples)
                self._utt_start_sample = max(
                    self._history.last_segment_end - samples.size, 0
                )
            segs.append(samples)
            self._vad.pop()
        return segs

    def _drain(self):
        """Transcribe VAD-closed segments. Tests and flush() use this; the live
        pipeline prefers _pop_vad_segments + executor transcribe instead."""
        out = []
        for samples in self._pop_vad_segments():
            t0 = time.time()
            result = self._recognize_samples(samples)
            if result.text:
                ev = self._result_from_pcm(
                    samples, result.text, (time.time() - t0) * 1000,
                    language=result.language,
                )
                if ev:
                    out.append(ev)
        if out:
            self._reset_utterance()
        return out

    def _batch_ingest(self, int16_bytes):
        """Fast VAD + utterance PCM. Never calls the recognizer — recognition
        is the engine's job and must run off the audio intake path."""
        self._buf = np.concatenate([self._buf, _downsample_int16_to_f32_16k(int16_bytes, self._src_rate)])
        events = []
        want_partial = False
        want_final = False
        final_pcm = None
        while len(self._buf) >= self._window:
            win = np.ascontiguousarray(self._buf[:self._window])
            self._history.push(win)
            was_detected = self._vad.is_speech_detected()
            self._vad.accept_waveform(win)
            self._buf = self._buf[self._window:]
            now_detected = self._vad.is_speech_detected()
            if not was_detected and now_detected:
                events.append("speech_start")
                self._reset_utterance()
                self._utt_start_sample = int(getattr(self, "_pcm_cursor", 0))
                self._utt_pcm = [win]
                self._utt_samples = int(win.size)
            elif now_detected:
                self._utt_pcm.append(win)
                self._utt_samples += int(win.size)
            segs = self._pop_vad_segments()
            if segs:
                want_final = True
                final_pcm = np.concatenate(segs) if len(segs) > 1 else segs[0]
                self._reset_utterance()
            elif now_detected and self._utt_samples >= self._next_partial:
                want_partial = True
                self._next_partial = self._utt_samples + self._partial_interval
            cap = getattr(self, "_max_speech_samples", int(LIVE_SEGMENT_MAX_SECONDS * TARGET_RATE))
            if now_detected and not segs and self._utt_samples >= cap:
                want_final = True
                final_pcm = np.concatenate(self._utt_pcm) if self._utt_pcm else None
                if final_pcm is not None:
                    final_pcm = self._history.with_preroll(
                        self._utt_start_sample, final_pcm,
                    )
                    self._utt_start_sample = max(
                        self._history.last_segment_end - final_pcm.size, 0
                    )
                self._reset_utterance()
            self._pcm_cursor = int(getattr(self, "_pcm_cursor", 0)) + int(win.size)
        partial_pcm = None
        if want_partial and not want_final and self._utt_pcm:
            partial_pcm = np.concatenate(self._utt_pcm)
            window = int(LIVE_PARTIAL_WINDOW_SECONDS * TARGET_RATE)
            if partial_pcm.size > window:
                partial_pcm = partial_pcm[-window:]
        return events, want_partial, want_final, final_pcm, partial_pcm

    def _publish_text(self, full_text):
        """Keep only tokens not already emitted as a result. Updates the cursor."""
        delta = novel_asr_text(getattr(self, "_published_text", ""), full_text)
        if not delta:
            return ""
        prev = getattr(self, "_published_text", "") or ""
        if prev and _mostly_cjk(prev + delta):
            self._published_text = _TRAIL_PUNCT_RE.sub('', prev) + delta
        elif prev:
            self._published_text = f"{prev} {delta}".strip()
        else:
            self._published_text = delta
        return delta

    def _display_text(self, full_text):
        """Novel tail for live partials — does not advance the committed cursor."""
        return novel_asr_text(getattr(self, "_published_text", ""), full_text)

    def _result_from_pcm(self, pcm, text, recognition_time_ms=0, language=None):
        # Hayamimi's VAD finals are independent utterances. Applying the
        # rolling-window novelty filter here drops legitimate repeated phrases.
        if getattr(self, "_is_hayamimi", False):
            raw = str(text or '').strip()
            delta = hayamimi_final_delta(
                getattr(self, "_hayamimi_last_final_text", ""), raw,
            )
            self._hayamimi_last_final_text = raw
        else:
            delta = self._publish_text(text)
        if not delta:
            return None
        n = int(np.asarray(pcm).size) if pcm is not None else 0
        event = {"type": "result", "text": delta,
                "startSample": int(getattr(self, "_utt_start_sample", 0)),
                "durationMs": int(n / TARGET_RATE * 1000) if n else 0,
                "recognitionTimeMs": int(recognition_time_ms)}
        if getattr(self, "_is_hayamimi", False):
            event["segmentId"] = int(getattr(self, "_next_segment_id", 1))
            self._next_segment_id = event["segmentId"] + 1
        if language:
            event["language"] = language
        return event

    def _remember_hayamimi_result(self, event, pcm):
        if (not getattr(self, "_is_hayamimi", False)
                or not getattr(self, "_refinement_enabled", True)
                or not event):
            return
        n = int(np.asarray(pcm).size) if pcm is not None else 0
        if n <= 0 or "segmentId" not in event:
            return
        start = int(event.get("startSample", 0))
        self._hayamimi_spans.append({
            "start": start,
            "end": start + n,
            "language": event.get("language") or self._language,
            "text": str(event.get("text", "")).strip(),
            "segmentId": int(event["segmentId"]),
        })

    def set_refinement_enabled(self, enabled):
        """Toggle Hayamimi's whole-group second pass for this ASR session.

        The generation token invalidates a refinement already running in an
        executor: when subtitle mode turns it off, that stale result is dropped
        even if the mode is toggled back before the worker returns.
        """
        self._refinement_enabled = bool(enabled)
        self._refinement_generation += 1
        if not self._refinement_enabled:
            # Do not carry subtitle-mode audio into a later conversation-mode
            # refinement when the user toggles the display while speaking.
            self._hayamimi_spans = []

    def _recognize_refined(self, samples, language):
        """Whole-group Hayamimi decode without mutating live LID hysteresis."""
        from .backends import AsrResult

        method = getattr(self._backend, "transcribe_refined", None)
        try:
            result = (method(samples, language) if method is not None
                      else self._backend.transcribe(samples, language))
            if isinstance(result, str):
                return AsrResult(result.strip(), language)
            return AsrResult(
                str(getattr(result, "text", "") or "").strip(),
                getattr(result, "language", None) or language,
            )
        except Exception:
            return AsrResult("", language)

    async def _maybe_refine_hayamimi(self, send, force=False):
        spans = getattr(self, "_hayamimi_spans", [])
        if not getattr(self, "_refinement_enabled", True):
            # A disabled session does not record or retain a pending group.
            self._hayamimi_spans = []
            return
        if not getattr(self, "_is_hayamimi", False) or not spans:
            return
        if not force and self._vad.is_speech_detected():
            return
        first_start = spans[0]["start"]
        last_end = spans[-1]["end"]
        now = int(getattr(self, "_pcm_cursor", last_end))
        due = (force
               or now - last_end >= int(HAYAMIMI_GROUP_GAP_SECONDS * TARGET_RATE)
               or last_end - first_start >= int(HAYAMIMI_GROUP_MAX_SECONDS * TARGET_RATE))
        if not due:
            return

        lo = max(
            first_start - int(BATCH_PREROLL_SECONDS * TARGET_RATE),
            self._history.offset,
        )
        pcm = self._history.slice(lo, last_end)
        group = spans[:]
        self._hayamimi_spans = []
        if pcm.size < int(HAYAMIMI_REFINE_MIN_SECONDS * TARGET_RATE):
            return

        correct_language = getattr(self._backend, "correct_language", None)
        languages = []
        for span in group:
            language = span["language"] or self._language or ""
            if correct_language is not None:
                language = correct_language(language, span["text"])
            languages.append(language)
        languages = [lang for lang in languages if lang]
        language = (max(dict.fromkeys(languages), key=languages.count)
                    if languages else self._language)
        mixed = (len(set(languages)) > 1
                 and min(languages.count(lang) for lang in set(languages)) / len(languages) >= 0.25)
        fast_joined = " ".join(
            span["text"] for span in group if span["text"].strip()
        ).strip()

        t0 = time.time()
        refine_generation = self._refinement_generation
        if mixed:
            result_text = fast_joined
        else:
            loop = asyncio.get_running_loop()
            refined = await loop.run_in_executor(
                None, self._recognize_refined, pcm, language,
            )
            result_text = refined.text.strip()
            language = refined.language or language
        recognition_ms = int((time.time() - t0) * 1000)
        if not mixed:
            # A second pass may improve punctuation and cross-cut context, but
            # it must neither duplicate nor erase substantial spoken content.
            result_text = guarded_refined_text(result_text, fast_joined)
        if not result_text:
            return
        # Subtitle mode can be entered while this executor job is running.
        # Check both the current flag and generation immediately before the
        # wire send so a late second-pass result can never reach the UI.
        if (not self._refinement_enabled
                or refine_generation != self._refinement_generation):
            return
        event = {
            "type": "refine",
            "text": result_text,
            "segmentIds": [span["segmentId"] for span in group],
            "startSample": int(lo),
            "durationMs": int(pcm.size / TARGET_RATE * 1000),
            "recognitionTimeMs": recognition_ms,
        }
        if language:
            event["language"] = language
        await send(event)

    def feed(self, int16_bytes):
        """Sync helper for tests. Production uses feed_stream + run_stream so
        transcribe never blocks audio intake."""
        events, want_partial, want_final, final_pcm, partial_pcm = self._batch_ingest(int16_bytes)
        out = [{"type": "speech_start"} for _ in range(events.count("speech_start"))]
        if want_final and final_pcm is not None:
            t0 = time.time()
            result = self._recognize_samples(final_pcm)
            if result.text:
                ev = self._result_from_pcm(
                    final_pcm, result.text, (time.time() - t0) * 1000,
                    language=result.language,
                )
                if ev:
                    out.append(ev)
        elif want_partial and partial_pcm is not None:
            text = self._display_text(
                self._recognize_samples(partial_pcm, partial=True).text
            )
            if text and text != self._last_partial_text:
                out.append({"type": "partial", "text": text})
                self._last_partial_text = text
        return out

    def flush(self):
        self._buf = np.zeros(0, np.float32)
        self._vad.flush()
        segs = self._pop_vad_segments()
        pcm = None
        if segs:
            pcm = np.concatenate(segs) if len(segs) > 1 else segs[0]
        elif self._utt_pcm:
            pcm = np.concatenate(self._utt_pcm)
            pcm = self._history.with_preroll(self._utt_start_sample, pcm)
            self._utt_start_sample = max(
                self._history.last_segment_end - pcm.size, 0
            )
        self._reset_utterance()
        if pcm is None:
            return []
        t0 = time.time()
        result = self._recognize_samples(pcm)
        if not result.text:
            return []
        ev = self._result_from_pcm(
            pcm, result.text, (time.time() - t0) * 1000,
            language=result.language,
        )
        return [ev] if ev else []

    # ── Streaming branch (STREAMING backends only; offline path above is unchanged) ──

    def is_streaming(self):
        return bool(getattr(self._backend, "STREAMING", False))

    def init_streaming(self, model_id=None, language="", sample_rate=SRC_RATE,
                       vad_threshold=None, vad_min_silence=None, vad_min_speech=None, device="auto",
                       pin=None, vad_max_speech=None, refinement_enabled=True):
        """Like init(), but for a STREAMING backend: resolve+load, set up VAD for
        endpointing, and prepare the audio queue + always-stream state (default mode)."""
        import queue as _queue
        self.close()
        self._init_vad(sample_rate, vad_threshold, vad_min_silence, vad_min_speech,
                       vad_max_speech=vad_max_speech)
        self._backend, plan, notice, mem = self._resolve_streaming_backend(model_id, device, pin)
        self._refinement_enabled = bool(refinement_enabled)
        self._refinement_generation += 1
        self.resolved = {"backend": plan.backend, "device": plan.device,
                         "computeType": plan.compute_type}
        if mem is not None:
            self.resolved["memoryBytes"] = mem
        if notice:
            self.resolved["fallbackReason"] = notice
        self._language = language or None
        self._audio_q = _queue.Queue()
        self._mode = "always_stream"
        self._stream = self._open_stream()   # always-stream: one long-lived session
        self._preroll = []
        self._preroll_len = 0
        self._pending = ""           # text drained since the last cut (the partial)
        self._partial_acc = []       # per-utterance fallback accumulator
        self._utt_start_sample = 0
        self._sample_cursor = 0
        self._utt_samples = 0        # per-utterance fallback (its own cap)
        self._speech_samples = 0     # speech in the current live-subtitle segment
        self._stop = False

    def _open_stream(self):
        """Open a stream on the loaded backend, forwarding the user's source
        language — the same hint the batch path gives session.run(). Every
        stream (re)open goes through here: init, endpoint-reopen, salvage."""
        return self._backend.open_stream(self._language)

    def _preroll_push(self, samples):
        """Roll `samples` into the pre-roll ring (keeps >= PREROLL_SAMPLES)."""
        self._preroll.append(samples)
        self._preroll_len += len(samples)
        while (len(self._preroll) > 1
               and self._preroll_len - len(self._preroll[0]) >= PREROLL_SAMPLES):
            self._preroll_len -= len(self._preroll.pop(0))

    def _preroll_take(self):
        """Drain the ring: the buffered onset audio (or None), resetting it."""
        if not self._preroll:
            return None
        out = np.concatenate(self._preroll)
        self._preroll, self._preroll_len = [], 0
        return out

    def feed_stream(self, int16_bytes):
        """Non-blocking: hand raw audio to the live loop (called from on_binary).
        Returns [] — events are pushed asynchronously by run_stream, so the
        websocket feeder never waits on transcribe()."""
        q = getattr(self, "_audio_q", None)
        if q is not None:
            q.put_nowait(int16_bytes)
        return []

    def request_flush(self, done=None):
        """Ask the live loop to finalize the current utterance. Non-blocking."""
        q = getattr(self, "_audio_q", None)
        if q is not None:
            q.put_nowait((_FLUSH, done))
            return True
        return False

    async def run_stream(self, send):
        """The asyncio live loop. Audio intake is a queue; recognition — streaming
        decode OR batch transcribe — never runs on the websocket thread."""
        loop = asyncio.get_running_loop()
        while not getattr(self, "_stop", False):
            try:
                data = await loop.run_in_executor(None, self._audio_q.get, True, 0.1)
            except queue.Empty:
                continue
            if data is None:
                break
            if isinstance(data, tuple) and data[0] is _FLUSH:
                try:
                    await self.flush_live(send)
                finally:
                    ev = data[1] if len(data) > 1 else None
                    if ev is not None:
                        ev.set()
                continue
            if self.is_streaming():
                if self._mode == "always_stream":
                    await self._drive_always(send, data)
                else:
                    await self._drive_utterance(send, data)
            else:
                await self._drive_batch(send, data)
        if self._mode == "always_stream":
            # Flush the last stream if it saw speech (its tail text may still be held by the
            # model with _pending empty) — gating on speech, not _pending, mirrors the pause-cut.
            if self._stream is not None and self._speech_samples > 0:
                try:
                    final = await loop.run_in_executor(None, self._stream.end)
                except Exception:
                    final = ""
                self._stream = None
                if final.strip():
                    ev = self._result_event(final)
                    if ev:
                        await send(ev)
        elif self._stream is not None:
            await self._finalize(send)
        else:
            await self.flush_live(send)

    async def _drive_batch(self, send, int16_bytes):
        """Batch recognizers (Qwen3-ASR, SenseVoice, Whisper, …) sit behind the
        same live pipeline as streaming models. VAD is cheap; transcribe() runs
        in a worker thread so a slow engine cannot stall audio or subtitles."""
        events, want_partial, want_final, final_pcm, partial_pcm = self._batch_ingest(int16_bytes)
        for _ in range(events.count("speech_start")):
            await send({"type": "speech_start"})
        loop = asyncio.get_running_loop()
        if want_final and final_pcm is not None:
            t0 = time.time()
            result = await loop.run_in_executor(
                None, self._recognize_samples, final_pcm, False,
            )
            if result.text:
                ev = self._result_from_pcm(
                    final_pcm, result.text, (time.time() - t0) * 1000,
                    language=result.language,
                )
                if ev:
                    await send(ev)
                    self._remember_hayamimi_result(ev, final_pcm)
            await self._maybe_refine_hayamimi(send)
            return
        if want_partial and partial_pcm is not None:
            if getattr(self, "_asr_busy", False):
                self._partial_dirty = True
                await self._maybe_refine_hayamimi(send)
                return
            self._asr_busy = True
            try:
                result = await loop.run_in_executor(
                    None, self._recognize_samples, partial_pcm, True,
                )
                text = self._display_text(result.text)
                if text and text != self._last_partial_text:
                    self._last_partial_text = text
                    event = {"type": "partial", "text": text}
                    if result.language:
                        event["language"] = result.language
                    await send(event)
            finally:
                self._asr_busy = False
        await self._maybe_refine_hayamimi(send)

    async def flush_live(self, send):
        """Finalize whatever the live pipeline is holding. Used by asr_flush
        (PTT) and by run_stream teardown."""
        if self.is_streaming() and getattr(self, "_stream", None) is not None:
            if self._mode == "always_stream":
                await self._end_and_reopen(send)
            else:
                await self._finalize(send)
            return
        if getattr(self, "_vad", None) is None:
            return
        self._vad.flush()
        segs = self._pop_vad_segments()
        pcm = None
        if segs:
            pcm = np.concatenate(segs) if len(segs) > 1 else segs[0]
        elif self._utt_pcm:
            pcm = np.concatenate(self._utt_pcm)
            pcm = self._history.with_preroll(self._utt_start_sample, pcm)
            self._utt_start_sample = max(
                self._history.last_segment_end - pcm.size, 0
            )
        self._reset_utterance()
        if pcm is None:
            await self._maybe_refine_hayamimi(send, force=True)
            return
        loop = asyncio.get_running_loop()
        t0 = time.time()
        result = await loop.run_in_executor(None, self._recognize_samples, pcm, False)
        if result.text:
            ev = self._result_from_pcm(
                pcm, result.text, (time.time() - t0) * 1000,
                language=result.language,
            )
            if ev:
                await send(ev)
                self._remember_hayamimi_result(ev, pcm)
        await self._maybe_refine_hayamimi(send, force=True)

    async def _drive_utterance(self, send, int16_bytes):
        """Process one audio buffer: VAD → manage session → emit events. Factored so
        tests can call _drive_once with scripted VAD. Feeds the buffer to the stream
        ONCE per call — a single buffer spans several VAD windows, so feeding per-event
        would duplicate the audio and scramble the streaming model's features.

        Silero's rising edge lags the true onset by 300-600ms (threshold ramp +
        min_speech_duration): the pre-roll ring replays that audio into the fresh
        stream so utterances keep their first words. A fast utterance (recognition
        quicker than realtime) flips the engine back to the lossless always-stream
        mode — a degrade is not a one-way door."""
        samples = _downsample_int16_to_f32_16k(int16_bytes, self._src_rate)
        events = self._vad_events(samples)
        if "start" in events:
            # Defensive: in practice _stream is already None here (an "end" precedes every
            # "start", and degrade nulls it) — abort + reopen guards against a stale stream
            # from any source.
            if self._stream is not None:
                try:
                    self._stream.abort()
                except Exception:
                    pass
                self._stream = None
                self._partial_acc = []
            self._utt_start_sample = max(0, self._sample_cursor - self._preroll_len)
            self._stream = self._open_stream()
            pre = self._preroll_take()
            if pre is not None:
                self._stream.feed(pre)     # onset audio silero's latency would drop
            await send({"type": "speech_start"})
        if self._stream is not None and "speech" in events:
            self._stream.feed(samples)
            deltas = self._stream.drain()
            if deltas:
                if getattr(self._stream, "partial_mode", "append") == "replace":
                    self._partial_acc = [deltas[-1]]
                else:
                    self._partial_acc += deltas
                shown = self._display_text("".join(self._partial_acc))
                if shown:
                    await send({"type": "partial", "text": shown})
        ended = False
        if "end" in events and self._stream is not None:
            dur_ms, rec_ms = await self._finalize(send)
            ended = True
            self._preroll, self._preroll_len = [], 0   # ring restarts post-utterance
            if rec_ms < dur_ms:
                import sys
                print("[sokuji-sidecar] streaming caught up — back to always-stream mode",
                      file=sys.stderr, flush=True)
                self._mode = "always_stream"
                self._pending = ""
                self._speech_samples = 0
                self._stream = self._open_stream()
        self._sample_cursor += len(samples)
        if not ended:
            # Ring holds strictly-previous buffers at "start" time; the buffer
            # that ENDED an utterance is excluded so the next pre-roll can't
            # replay the previous utterance's tail.
            self._preroll_push(samples)

    async def _finalize(self, send):
        """end() the stream and emit the result. Returns (dur_ms, rec_ms) so the
        gated drive can decide whether the model runs faster than realtime."""
        import time as _time
        t0 = _time.time()
        loop = asyncio.get_running_loop()
        final = await loop.run_in_executor(None, self._stream.end)
        dur_ms = int((self._sample_cursor - self._utt_start_sample) / TARGET_RATE * 1000)
        rec_ms = int((_time.time() - t0) * 1000)
        if final.strip():
            delta = self._publish_text(final.strip())
            if delta:
                await send({"type": "result", "text": delta,
                            "startSample": int(self._utt_start_sample),
                            "durationMs": dur_ms,
                            "recognitionTimeMs": rec_ms})
        self._stream = None
        self._partial_acc = []
        return dur_ms, rec_ms

    async def _drive_once(self, send):
        """Test seam: drive exactly the buffers currently queued, once."""
        while not self._audio_q.empty():
            data = self._audio_q.get_nowait()
            if self._mode == "always_stream":
                await self._drive_always(send, data)
            else:
                await self._drive_utterance(send, data)

    def _vad_state(self, samples):
        """Run silero VAD over `samples` for STATE only (always-stream): return
        (had_speech, rising, falling). `falling` = silero's endpoint (is_speech_detected
        True->False this buffer), governed by the user's min_silence_duration. Does not
        gate input."""
        had_speech = False
        rising = False
        falling = False
        self._buf = np.concatenate([self._buf, samples])
        while len(self._buf) >= self._window:
            was = self._vad.is_speech_detected()
            self._vad.accept_waveform(self._buf[:self._window])
            self._buf = self._buf[self._window:]
            now = self._vad.is_speech_detected()
            if now:
                had_speech = True
            if not was and now:
                rising = True
            if was and not now:
                falling = True
        return had_speech, rising, falling

    def _result_event(self, text):
        """A `result` envelope. startSample/durationMs are approximate in always-stream."""
        delta = self._publish_text(text)
        if not delta:
            return None
        dur_ms = int(getattr(self, "_speech_samples", 0) / TARGET_RATE * 1000)
        return {"type": "result", "text": delta,
                "startSample": int(getattr(self, "_utt_start_sample", 0)),
                "durationMs": dur_ms,
                "recognitionTimeMs": 0}

    async def _end_and_reopen(self, send):
        """Pause-cut: end() the stream to flush the COMPLETE held tail, emit it as the
        result, then open a fresh stream. Audio arriving during the ~1s end() backs up in
        _audio_q and feeds the new stream after — no leading loss. Per-stream backpressure
        counters reset (end()'s flushed tokens aren't counted via drain())."""
        loop = asyncio.get_running_loop()
        try:
            final = await loop.run_in_executor(None, self._stream.end)
        except Exception:                                # end() failed -> drop this final, still recover
            final = ""
        if final.strip():
            ev = self._result_event(final)
            if ev:
                await send(ev)
        self._stream = self._open_stream()
        self._pending = ""
        self._speech_samples = 0
        self._utt_start_sample = int(getattr(self, "_sample_cursor", 0))

    async def _drive_always(self, send, int16_bytes):
        """Always-stream: feed every buffer (no gating); cut a final on silero's endpoint
        (the falling edge, governed by the user's min_silence_duration), a natural
        sentence ending, or the live-caption run-on cap — via end()+reopen, which
        flushes the COMPLETE held tail. Continuous feed means no leading loss."""
        samples = _downsample_int16_to_f32_16k(int16_bytes, self._src_rate)
        self._sample_cursor += len(samples)
        self._preroll_push(samples)          # rolling onset copy (consumed at degrade)
        self._stream.feed(samples)                       # continuous, never gated
        try:
            had_speech, rising, falling = self._vad_state(samples)
        except Exception:                                # VAD failure -> assume speech, no edges
            had_speech, rising, falling = True, False, False
        if rising:
            await send({"type": "speech_start"})
        if had_speech:
            self._speech_samples += len(samples)
        deltas = self._stream.drain()
        if deltas:
            if getattr(self._stream, "partial_mode", "append") == "replace":
                self._pending = deltas[-1]
            else:
                self._pending += "".join(deltas)
            shown = self._display_text(self._pending.strip())
            if shown:
                await send({"type": "partial", "text": shown})
        if getattr(self._stream, "aborted", False):      # generate died -> salvage + reopen
            if self._pending.strip():
                ev = self._result_event(self._pending)
                if ev:
                    await send(ev)
            try:
                self._stream.abort()
            except Exception:
                pass
            self._stream = self._open_stream()
            self._pending = ""; self._speech_samples = 0
            return
        # Cut on a silero endpoint, a stable sentence boundary, or the run-on cap
        # whenever this stream has SEEN SPEECH —
        # NOT when _pending has text. The model can hold a short utterance's text until end(),
        # so gating on _pending would drop/merge short or slow-first-token utterances. end()
        # flushes the held text and _end_and_reopen's `if final.strip()` skips truly-empty finals.
        sentence_boundary = (
            self._speech_samples >= LIVE_SENTENCE_MIN_SECONDS * TARGET_RATE
            and _ends_sentence(self._pending)
        )
        if (falling
                or sentence_boundary
                or self._speech_samples >= getattr(self, "_max_speech_seconds", LIVE_SEGMENT_MAX_SECONDS) * TARGET_RATE) \
                and self._speech_samples > 0:
            await self._end_and_reopen(send)
            return
        # Backpressure = un-processed audio backed up in the queue. This is the
        # only cadence-independent signal: a genuinely slow model makes the
        # run_stream loop fall behind feed_stream, so the queue grows. The two
        # earlier heuristics both mis-fired — counting fed seconds degraded on
        # SILENCE (the model rightly emits nothing), and crediting drained
        # deltas at 80ms/each degraded on transcribe.cpp's committed-prefix
        # adapter (one MERGED delta per drain, committed in 1-2s bursts).
        lag = self._audio_q.qsize() * (len(samples) / TARGET_RATE)
        if self._mode == "always_stream" and lag > 3.0:
            import sys
            print(f"[sokuji-sidecar] streaming has {lag:.1f}s of audio backed up — "
                  "degrading to VAD-gated mode", file=sys.stderr, flush=True)
            if self._pending.strip():
                ev = self._result_event(self._pending)
                if ev:
                    await send(ev)
            try:
                self._stream.abort()
            except Exception:
                pass
            self._stream = None
            self._mode = "per_utterance"
            self._pending = ""
            if had_speech:
                # Backlog usually builds while the model chews on SPEECH, so
                # the degrade typically lands mid-utterance. Without a
                # continuation stream the VAD stays in-speech and no rising
                # edge would ever open one — the rest of the utterance would
                # be dropped. Open it now and replay the ring.
                self._utt_start_sample = max(0, self._sample_cursor - self._preroll_len)
                self._partial_acc = []
                self._stream = self._open_stream()
                pre = self._preroll_take()
                if pre is not None:
                    self._stream.feed(pre)
                await send({"type": "speech_start"})

    def resolves_to_streaming(self, model_id, device, pin=None):
        """Cheap pre-check (no model load): does this model resolve to a STREAMING backend?

        Instantiates a bare backend object (no load()) and reads its STREAMING class flag.
        Only the top-ranked plan is checked; `pin` (the user-pinned quant) must match what
        init/init_streaming will load so both resolve the same plan. Returns False on any
        resolution error so the caller can safely fall back to the offline path."""
        from . import accel, backends
        try:
            plans = accel.resolve(model_id or "hayamimi-asr", override=device or "auto", pin=pin)
        except Exception:
            return False
        if not plans:
            return False
        try:
            # make_backend() instantiates the class — no model load, no I/O.
            obj = backends.make_backend(plans[0].backend)
            return bool(getattr(obj, "STREAMING", False))
        except Exception:
            return False

    def _resolve_streaming_backend(self, model_id, device, pin=None):
        from . import accel
        plans = accel.resolve(model_id or "voxtral-mini-4b-realtime", override=device or "auto", pin=pin)
        return accel.load_measured(plans, stage="asr")   # (backend, plan, notice, memory_bytes)

    def _vad_events(self, samples):
        """Feed `samples` to silero VAD; yield 'start' on rising edge, 'speech' while
        active, 'end' on endpoint (silence) or the live-caption max-segment cap."""
        events = []
        cap = getattr(self, "_max_speech_seconds", LIVE_SEGMENT_MAX_SECONDS) * TARGET_RATE
        self._buf = np.concatenate([self._buf, samples])
        while len(self._buf) >= self._window:
            was = self._vad.is_speech_detected()
            self._vad.accept_waveform(self._buf[:self._window])
            self._buf = self._buf[self._window:]
            now = self._vad.is_speech_detected()
            if not was and now:
                self._utt_samples = 0
                events.append("start")
            if now:
                self._utt_samples += self._window
                events.append("speech")
                if self._utt_samples >= cap:          # force endpoint to bound VRAM
                    events.append("end")
                    self._utt_samples = 0
            if was and not now:
                events.append("end")
        return events


def _bind_asr_engine(state, conn):
    """Return the AsrEngine this connection should use.

    Both mode opens two WebSocket clients (mic + system audio) against one
    sidecar process. They used to share state["asr_engine"], so the second
    asr_init closed the first stream and mixed both PCM queues — neither
    channel recognized speech. The first connection keeps the process
    prototype (tests and single-channel sessions); later connections get
    their own engine.
    """
    proto = state["asr_engine"]
    if conn is None:
        return proto
    existing = conn.ctx.get("asr_engine")
    if existing is not None:
        return existing
    owners = state.setdefault("_asr_engine_owners", set())
    if id(proto) not in owners:
        owners.add(id(proto))
        conn.ctx["asr_engine"] = proto
        return proto
    eng = type(proto)()
    conn.ctx["asr_engine"] = eng
    owners.add(id(eng))
    return eng


def _asr_teardown(state, conn):
    """Free this connection's ASR model when the connection closes (stop = release VRAM).

    Reads the stream task from conn.ctx at close time — the offline path never creates one.
    """
    task = conn.ctx.get("stream_task")
    if task is not None:
        task.cancel()
    eng = conn.ctx.pop("asr_engine", None) or state.get("asr_engine")
    if eng is not None:
        try:
            eng.close()
        except Exception:
            pass
    owners = state.get("_asr_engine_owners")
    if owners is not None and eng is not None:
        owners.discard(id(eng))


async def _h_asr_init(state, msg, _b, conn=None):
    import asyncio
    eng = _bind_asr_engine(state, conn)
    model = msg.get("model")
    device = msg.get("device", "auto")
    language = msg.get("language", "")
    sample_rate = msg.get("sampleRate", SRC_RATE)
    vad_threshold = msg.get("vadThreshold")
    vad_min_silence = msg.get("vadMinSilenceDuration")
    vad_min_speech = msg.get("vadMinSpeechDuration")
    vad_max_speech = msg.get("vadMaxSpeechDuration")
    refinement_enabled = bool(msg.get("refinementEnabled", True))
    pin = msg.get("variant")   # user-pinned quant (renderer variant picker)

    # Cheap pre-check: resolve the backend NAME without loading the model, then read
    # its STREAMING flag. This ensures each branch loads the model exactly once.
    is_streaming = (hasattr(eng, "resolves_to_streaming")
                    and eng.resolves_to_streaming(model, device, pin=pin))

    if is_streaming:
        eng.init_streaming(model, language, sample_rate,
                           vad_threshold, vad_min_silence, vad_min_speech, device, pin=pin,
                           vad_max_speech=vad_max_speech,
                           refinement_enabled=refinement_enabled)
        ms = 0
    else:
        ms = eng.init(model, language, sample_rate,
                      vad_threshold, vad_min_silence, vad_min_speech, device, pin=pin,
                      vad_max_speech=vad_max_speech,
                      refinement_enabled=refinement_enabled)
    # One live pipeline for every ASR model. The recognizer (streaming decode
    # or batch transcribe) is just an engine — audio intake must not wait on it.
    if conn is not None:
        if hasattr(eng, "feed_stream"):
            conn.ctx["on_binary"] = eng.feed_stream
            conn.ctx["stream_task"] = asyncio.create_task(eng.run_stream(conn.send))
        else:
            conn.ctx["on_binary"] = eng.feed
        conn.on_close(lambda: _asr_teardown(state, conn))

    reply = {"type": "ready", "id": msg.get("id"), "loadTimeMs": ms}
    resolved = getattr(eng, "resolved", None)
    if resolved:
        reply.update(resolved)  # backend, device, computeType
    return reply, None


async def _h_asr_set_refinement(state, msg, _b, conn=None):
    """Change Hayamimi's second-pass policy without restarting ASR."""
    eng = (conn.ctx.get("asr_engine") if conn is not None else None) or state["asr_engine"]
    # NativeAsrClient uses the compact ``enabled`` key for runtime updates;
    # accept the camel-case init spelling as a compatibility fallback.
    enabled = bool(msg.get("enabled", msg.get("refinementEnabled", True)))
    setter = getattr(eng, "set_refinement_enabled", None)
    if setter is not None:
        setter(enabled)
    return {"type": "ok", "id": msg.get("id")}, None


async def _h_asr_flush(state, msg, _b, conn=None):
    import asyncio
    eng = (conn.ctx.get("asr_engine") if conn is not None else None) or state["asr_engine"]
    send = conn.send if conn is not None else (lambda *_a, **_k: None)
    if hasattr(eng, "flush_live"):
        done = asyncio.Event()
        if getattr(eng, "request_flush", None) and eng.request_flush(done):
            try:
                await asyncio.wait_for(done.wait(), timeout=8)
            except asyncio.TimeoutError:
                await eng.flush_live(send)
        else:
            await eng.flush_live(send)
    else:
        for out in eng.flush():
            if conn is not None:
                await conn.send(out)
    return {"type": "ok", "id": msg.get("id")}, None


def register(state: dict):
    state.setdefault("handlers", {}).update(
        {"asr_init": _h_asr_init, "asr_flush": _h_asr_flush,
         "asr_set_refinement": _h_asr_set_refinement})
