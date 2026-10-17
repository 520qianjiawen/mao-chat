"""Native sherpa-onnx streaming transducer backend.

The model manager downloads a complete Hugging Face snapshot.  This adapter
discovers the recognizer assets inside that snapshot, creates sherpa's native
``OnlineRecognizer`` and exposes the stream contract consumed by
``AsrEngine``.  No model is bundled into the application package.
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np

from .backends import BackendLoadError, register_backend


def _pick_asset(root: Path, kind: str, *, prefer_int8: bool = False) -> Path:
    """Pick one recognizer asset while ignoring demo/test directories."""
    candidates = [
        path for path in root.rglob("*.onnx")
        if kind in path.name.lower() and "test_wavs" not in path.parts
    ]
    if prefer_int8:
        candidates.sort(key=lambda path: ("int8" not in path.name.lower(), len(path.parts), path.name))
    else:
        candidates.sort(key=lambda path: (len(path.parts), path.name))
    if not candidates:
        raise BackendLoadError(f"missing {kind} ONNX file in {root}")
    return candidates[0]


def _pick_tokens(root: Path) -> Path:
    candidates = sorted(root.rglob("tokens.txt"), key=lambda path: (len(path.parts), path.name))
    if not candidates:
        raise BackendLoadError(f"missing tokens.txt in {root}")
    return candidates[0]


def _result_text(recognizer, stream) -> str:
    result = recognizer.get_result(stream)
    text = getattr(result, "text", result)
    return str(text or "").strip()


class _SherpaStream:
    """One native online recognizer stream.

    Sherpa partial hypotheses may revise their unfinished suffix.  ``drain``
    therefore returns the complete current partial and declares ``replace``
    mode; AsrEngine replaces its displayed partial instead of appending stale
    text.  This is what keeps Japanese captions responsive and correct while
    the speaker is still talking.
    """

    partial_mode = "replace"

    def __init__(self, recognizer):
        self._recognizer = recognizer
        self._stream = recognizer.create_stream()
        self._last_partial = ""
        self._done = False
        self.aborted = False

    def _decode_ready(self) -> None:
        while self._recognizer.is_ready(self._stream):
            self._recognizer.decode_stream(self._stream)

    def feed(self, samples_f32_16k) -> None:
        if self._done:
            return
        pcm = np.ascontiguousarray(
            np.asarray(samples_f32_16k, dtype=np.float32).reshape(-1)
        )
        if not pcm.size:
            return
        self._stream.accept_waveform(16000, pcm)
        self._decode_ready()

    def drain(self) -> list[str]:
        if self._done:
            return []
        current = _result_text(self._recognizer, self._stream)
        if not current or current == self._last_partial:
            return []
        self._last_partial = current
        return [current]

    def end(self) -> str:
        if self._done:
            return self._last_partial
        try:
            # Sherpa's official streaming example uses 0.66 s of tail padding;
            # Kroko's 128-frame decode chunks otherwise keep the last chunk
            # uncommitted (and short clips can come back completely blank).
            self._stream.accept_waveform(16000, np.zeros(10560, dtype=np.float32))
            self._stream.input_finished()
            self._decode_ready()
            final = _result_text(self._recognizer, self._stream)
            if final:
                self._last_partial = final
            return self._last_partial.strip()
        finally:
            self._done = True
            self._stream = None

    def abort(self) -> None:
        self.aborted = True
        self._done = True
        self._stream = None


@register_backend
class SherpaOnlineBackend:
    """CPU-native streaming Zipformer recognizer backed by sherpa-onnx."""

    NAME = "sherpa_online"
    STREAMING = True

    def __init__(self):
        self._recognizer = None
        self._model_dir: str | None = None

    def load(self, model_ref: str, device: str, compute_type: str, config=None) -> None:
        self.unload()
        if device != "cpu":
            raise BackendLoadError(f"sherpa_online currently supports CPU, got {device!r}")
        try:
            import sherpa_onnx
            from huggingface_hub import snapshot_download

            root = Path(snapshot_download(repo_id=model_ref, local_files_only=True))
            tokens = _pick_tokens(root)
            default_threads = max(1, min(4, (os.cpu_count() or 2) // 2))
            # Loader plans carry the typed planner.PlanConfig, while a few
            # direct/legacy callers may still pass a mapping.  PlanConfig has
            # no dict-style .get(), so treating every config as a mapping made
            # every Sherpa CPU plan fail before the recognizer was constructed.
            if hasattr(config, "get"):
                configured_threads = config.get("num_threads", default_threads)
            else:
                configured_threads = getattr(config, "num_threads", default_threads)
            threads = int(configured_threads)
            ref_lower = model_ref.lower()
            is_nemo_ctc = "nemo" in ref_lower and "ctc" in ref_lower

            if is_nemo_ctc:
                # This is the native equivalent of the extension's proven
                # stream-nemo-ctc-en-80ms-int8 route: one online CTC model plus
                # tokens, not an encoder/decoder/joiner transducer trio.
                model = _pick_asset(root, "model", prefer_int8=compute_type == "int8")
                self._recognizer = sherpa_onnx.OnlineRecognizer.from_nemo_ctc(
                    tokens=str(tokens),
                    model=str(model),
                    num_threads=threads,
                    provider="cpu",
                    sample_rate=16000,
                    feature_dim=80,
                    decoding_method="greedy_search",
                )
                self._model_dir = str(root)
                return

            encoder = _pick_asset(root, "encoder", prefer_int8=compute_type == "int8")
            decoder = _pick_asset(root, "decoder", prefer_int8=compute_type == "int8")
            joiner = _pick_asset(root, "joiner", prefer_int8=compute_type == "int8")
            # Zipformer2 exports need an explicit type. Auto-detect with ""
            # loads them as classic Zipformer and yields empty hypotheses —
            # the 2025-06-30 Chinese card produced no characters at all.
            # Older Korean/2023 Chinese transducers still use "".
            model_type = "zipformer2" if (
                "kroko" in ref_lower
                or "ar_en_id_ja_ru_th_vi_zh" in ref_lower
                or "zipformer-zh-int8-2025-06-30" in ref_lower
                or "zipformer-zh-2025-06-30" in ref_lower
            ) else ""

            self._recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
                tokens=str(tokens),
                encoder=str(encoder),
                decoder=str(decoder),
                joiner=str(joiner),
                num_threads=threads,
                provider="cpu",
                sample_rate=16000,
                feature_dim=80,
                decoding_method="greedy_search",
                max_active_paths=4,
                model_type=model_type,
                # The compact Kroko export strongly favors the blank token at
                # the generic default. Its reference sample produces no text
                # at 0; 4.0 restores live hypotheses. The multilingual
                # Zipformer is a standard icefall export and keeps 0.
                blank_penalty=4.0 if "kroko" in ref_lower else 0.0,
            )
            self._model_dir = str(root)
        except BackendLoadError:
            self.unload()
            raise
        except Exception as exc:
            self.unload()
            raise BackendLoadError(str(exc)) from exc

    def open_stream(self, language=None) -> _SherpaStream:
        # These catalog entries are already language-specific; no runtime
        # language switch is required by sherpa's transducer API.
        del language
        if self._recognizer is None:
            raise BackendLoadError("sherpa_online not loaded")
        return _SherpaStream(self._recognizer)

    def unload(self) -> None:
        self._recognizer = None
        self._model_dir = None

    @property
    def is_loaded(self) -> bool:
        return self._recognizer is not None
