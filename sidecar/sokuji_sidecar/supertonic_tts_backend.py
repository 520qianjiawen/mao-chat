"""Lightweight Supertonic 3 backend for the embedded macOS runtime.

The full :mod:`tts_backends` module imports every optional voice family. The
macOS app already bundles NumPy, Hugging Face Hub, and ONNX Runtime for MOSS,
which is also everything Supertonic needs. Keeping this adapter isolated lets
the lean runtime offer another multilingual voice without pulling in unrelated
Qwen/CosyVoice/GPT-SoVITS stacks. Model weights remain an optional download.
"""
from __future__ import annotations

import json
import os
import time

import numpy as np

from . import supertonic_frontend as frontend
from .backends import BackendLoadError, register_backend


PRESET_CODES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"]
VOICE_NAMES = [
    "Sarah", "Lily", "Jessica", "Olivia", "Emily",
    "Alex", "James", "Robert", "Sam", "Daniel",
]
VOICE_GENDERS = ["F"] * 5 + ["M"] * 5
AVAILABLE_LANGUAGES = {
    "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et",
    "fi", "fr", "hi", "hr", "hu", "id", "it", "lt", "lv", "nl", "pl",
    "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi",
}


@register_backend
class SupertonicBackend:
    """Supertonic 3 via its four raw ONNX Runtime inference graphs."""

    NAME = "supertonic"
    STREAMING = False
    CLONES = False
    MODEL_FILES = {
        "dp": "onnx/duration_predictor.onnx",
        "tenc": "onnx/text_encoder.onnx",
        "vest": "onnx/vector_estimator.onnx",
        "voc": "onnx/vocoder.onnx",
    }

    def __init__(self):
        self._sessions = None
        self._config = None
        self._indexer = None
        self._presets = None
        self._voice = None
        self.sample_rate = 44100
        self._total_steps = 16
        self._default_speaker = 7
        self._language = ""

    def load(self, model_ref, device, compute_type, config=None):
        self._sessions = None
        try:
            import onnxruntime as ort
            from huggingface_hub import snapshot_download

            root = snapshot_download(repo_id=model_ref, local_files_only=True)
            providers = (
                ["CUDAExecutionProvider", "CPUExecutionProvider"]
                if device == "cuda"
                else ["DmlExecutionProvider", "CPUExecutionProvider"]
                if device == "dml"
                else ["CPUExecutionProvider"]
            )
            options = ort.SessionOptions()
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            options.log_severity_level = 3
            options.intra_op_num_threads = int(os.environ.get("SOKUJI_TTS_THREADS", "4"))
            self._sessions = {
                key: ort.InferenceSession(
                    f"{root}/{filename}", sess_options=options, providers=providers
                )
                for key, filename in self.MODEL_FILES.items()
            }
            if device == "dml":
                for key, session in self._sessions.items():
                    if "DmlExecutionProvider" not in session.get_providers():
                        raise RuntimeError(
                            "DmlExecutionProvider was requested but session "
                            f"{key!r} was created without it "
                            f"(providers: {session.get_providers()})"
                        )
            with open(f"{root}/onnx/tts.json", encoding="utf-8") as file:
                self._config = json.load(file)
            with open(f"{root}/onnx/unicode_indexer.json", encoding="utf-8") as file:
                self._indexer = json.load(file)
            self.sample_rate = int(self._config["ae"]["sample_rate"])
            self._presets = {}
            for speaker_id, code in enumerate(PRESET_CODES):
                with open(f"{root}/voice_styles/{code}.json", encoding="utf-8") as file:
                    voice = json.load(file)
                self._presets[speaker_id] = (
                    self._as_tensor(voice["style_ttl"]),
                    self._as_tensor(voice["style_dp"]),
                )
            self._voice = self._presets[self._default_speaker]
        except Exception as exc:
            self._sessions = None
            raise BackendLoadError(str(exc)) from exc

    @staticmethod
    def _as_tensor(field):
        return np.asarray(field["data"], dtype=np.float32).reshape(field["dims"])

    def set_language(self, language):
        self._language = (language or "").split("-")[0].lower()

    def set_speaker(self, speaker_id):
        if self._presets is not None:
            self._voice = self._presets.get(
                int(speaker_id), self._presets[self._default_speaker]
            )

    def set_builtin_voice(self, name):
        try:
            self.set_speaker(VOICE_NAMES.index(name))
        except ValueError:
            self.set_speaker(self._default_speaker)

    def set_style_voice(self, style_ttl, style_dp):
        self._voice = (
            np.asarray(style_ttl, dtype=np.float32),
            np.asarray(style_dp, dtype=np.float32),
        )

    @staticmethod
    def list_builtin_voices():
        return [
            {"voice": name, "gender": gender}
            for name, gender in zip(VOICE_NAMES, VOICE_GENDERS)
        ]

    def _run(self, key, feeds):
        session = self._sessions[key]
        names = [output.name for output in session.get_outputs()]
        return dict(zip(names, session.run(names, feeds)))

    def generate(self, text, speed=1.0):
        started = time.time()
        style_ttl, style_dp = self._voice
        base_size = self._config["ae"]["base_chunk_size"]
        compress_factor = self._config["ttl"]["chunk_compress_factor"]
        chunk_size = base_size * compress_factor
        latent_dim = self._config["ttl"]["latent_dim"] * compress_factor
        processed = frontend.preprocess_text(text, self._language, AVAILABLE_LANGUAGES)
        text_ids = np.array(
            [frontend.apply_indexer(processed, self._indexer)], dtype=np.int64
        )
        text_mask = np.ones((1, 1, text_ids.shape[1]), dtype=np.float32)
        duration = self._run(
            "dp", {"text_ids": text_ids, "style_dp": style_dp, "text_mask": text_mask}
        )
        seconds = float(np.asarray(next(iter(duration.values()))).reshape(-1)[0])
        if speed and speed > 0:
            seconds /= speed
        encoded = self._run(
            "tenc", {"text_ids": text_ids, "style_ttl": style_ttl, "text_mask": text_mask}
        )
        text_embedding = next(iter(encoded.values())).astype(np.float32)
        waveform_length = int(seconds * self.sample_rate)
        latent_length = max(1, (waveform_length + chunk_size - 1) // chunk_size)
        latent = (
            np.random.randn(1, latent_dim, latent_length) * np.sqrt(0.7)
        ).astype(np.float32)
        latent_mask = np.ones((1, 1, latent_length), dtype=np.float32)
        total_steps = np.array([self._total_steps], dtype=np.float32)
        for step in range(self._total_steps):
            result = self._run(
                "vest",
                {
                    "noisy_latent": latent,
                    "text_emb": text_embedding,
                    "style_ttl": style_ttl,
                    "latent_mask": latent_mask,
                    "text_mask": text_mask,
                    "current_step": np.array([step], dtype=np.float32),
                    "total_step": total_steps,
                },
            )
            latent = next(iter(result.values())).astype(np.float32)
        decoded = self._run("voc", {"latent": latent})
        waveform = np.asarray(next(iter(decoded.values())), dtype=np.float32).reshape(-1)
        if 0 < waveform_length <= waveform.size:
            waveform = waveform[:waveform_length]
        return waveform, int((time.time() - started) * 1000)

    def unload(self):
        self._sessions = None
        self._presets = None
        self._voice = None

    @property
    def is_loaded(self):
        return self._sessions is not None
