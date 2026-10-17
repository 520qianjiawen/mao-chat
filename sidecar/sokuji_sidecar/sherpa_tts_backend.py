"""Lightweight Sherpa/Piper/Kokoro TTS backend for the macOS runtime.

The full ``tts_backends`` module also imports the optional ONNX/MLX voice
stacks.  The lean app does not ship those dependencies, but it already ships
``sherpa_onnx`` for streaming ASR.  Keeping this adapter isolated lets the same
runtime synthesize the small CPU VITS/Piper voices without pulling in several
unrelated frameworks.
"""
from __future__ import annotations

import os
import time

import numpy as np

from .backends import BackendLoadError, register_backend
from .sherpa_tts_common import KOKORO_VOICE_TO_SID, build_offline_tts_config


SHERPA_TTS_REPOS = {
    "piper-en-amy": "csukuangfj/vits-piper-en_US-amy-low",
}


@register_backend
class SherpaTtsBackend:
    """Non-cloning, one-shot sherpa-onnx OfflineTts (CPU in the mac build)."""

    NAME = "sherpa_tts"
    STREAMING = False
    CLONES = False

    def __init__(self):
        self._tts = None
        self.sample_rate = 16000
        self._sid = 0

    def load(self, model_ref: str, device: str, compute_type: str, config=None) -> None:
        self._tts = None
        self._sid = 0
        try:
            import sherpa_onnx
            from huggingface_hub import snapshot_download

            repo = SHERPA_TTS_REPOS.get(model_ref, model_ref)
            root = snapshot_download(repo_id=repo, local_files_only=True)
            cfg = build_offline_tts_config(sherpa_onnx, root, device)
            self._tts = sherpa_onnx.OfflineTts(cfg)
            self.sample_rate = self._tts.sample_rate
        except Exception as exc:
            raise BackendLoadError(str(exc)) from exc

    def set_voice(self, audio, sr):
        return None

    def set_speaker(self, sid):
        self._sid = int(sid)

    def set_builtin_voice(self, name):
        try:
            self._sid = KOKORO_VOICE_TO_SID[str(name)]
        except KeyError as exc:
            raise BackendLoadError(f"unknown Kokoro voice: {name}") from exc

    def generate(self, text, speed=1.0):
        started = time.time()
        audio = self._tts.generate(text, sid=self._sid, speed=speed)
        samples = np.asarray(audio.samples, dtype=np.float32)
        return samples, int((time.time() - started) * 1000)

    def unload(self) -> None:
        self._tts = None

    @property
    def is_loaded(self) -> bool:
        return self._tts is not None
