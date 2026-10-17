"""Lightweight MOSS-TTS-Nano ONNX backend for the macOS app runtime.

The complete :mod:`tts_backends` module imports every optional TTS family.
The embedded macOS runtime only needs MOSS' torch-free ONNX implementation,
so this module keeps that backend isolated and avoids importing the unrelated
Qwen/CosyVoice/GPT-SoVITS stacks.  Model weights are still downloaded on
demand and are never bundled with the application.
"""
from __future__ import annotations

import hashlib
import os
import queue
import shutil
import tempfile
import threading
import time

import numpy as np

from .backends import BackendLoadError, register_backend


_MOSS_LM_DIRNAME = "MOSS-TTS-Nano-100M-ONNX"
_MOSS_TOK_DIRNAME = "MOSS-Audio-Tokenizer-Nano-ONNX"


@register_backend
class MossOnnxTtsBackend:
    """MOSS-TTS-Nano via ONNX Runtime, with streaming and voice cloning."""

    NAME = "moss_onnx"
    STREAMING = True
    CLONES = True

    def __init__(self):
        self._rt = None
        self._sp = None
        self._voice_rows = None
        self.sample_rate = 24000
        self.preset_voice = os.environ.get("SOKUJI_MOSS_PRESET_VOICE", "Ava")

    def load(self, model_ref: str, device: str, compute_type: str, config=None) -> None:
        self._rt = None
        self._sp = None
        self._voice_rows = None
        try:
            import sentencepiece as spm
            from huggingface_hub import snapshot_download
            from .moss_tts.ort_runtime import OrtCpuRuntime

            tokenizer_repo = os.environ.get(
                "SOKUJI_MOSS_TTS_NANO_TOK_REPO",
                "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX",
            )
            lm_dir = snapshot_download(repo_id=model_ref, local_files_only=True)
            tokenizer_dir = snapshot_download(repo_id=tokenizer_repo, local_files_only=True)
            root = self._stage_layout(lm_dir, tokenizer_dir)
            provider = device if device in ("cuda", "dml") else "cpu"
            self._rt = OrtCpuRuntime(
                model_dir=root,
                execution_provider=provider,
                thread_count=int(os.environ.get("SOKUJI_TTS_THREADS", "4")),
            )
            tokenizer_path = os.path.join(root, _MOSS_LM_DIRNAME, "tokenizer.model")
            self._sp = spm.SentencePieceProcessor(model_file=tokenizer_path)
            self.sample_rate = int(self._rt.codec_meta["codec_config"]["sample_rate"])
        except Exception as exc:
            self._rt = None
            self._sp = None
            raise BackendLoadError(str(exc)) from exc

    @staticmethod
    def _stage_layout(lm_dir: str, tokenizer_dir: str) -> str:
        key = hashlib.blake2s(
            f"{lm_dir}|{tokenizer_dir}".encode(), digest_size=8
        ).hexdigest()
        root = os.path.join(tempfile.gettempdir(), "sokuji_moss_tts", key)
        MossOnnxTtsBackend._link_tree(
            lm_dir, os.path.join(root, _MOSS_LM_DIRNAME)
        )
        MossOnnxTtsBackend._link_tree(
            tokenizer_dir, os.path.join(root, _MOSS_TOK_DIRNAME)
        )
        return root

    @staticmethod
    def _link_tree(src_dir: str, dst_dir: str) -> None:
        os.makedirs(dst_dir, exist_ok=True)
        for name in os.listdir(src_dir):
            src = os.path.realpath(os.path.join(src_dir, name))
            if not os.path.isfile(src):
                continue
            dst = os.path.join(dst_dir, name)
            if os.path.exists(dst):
                continue
            try:
                os.link(src, dst)
            except OSError:
                shutil.copy2(src, dst)

    def set_builtin_voice(self, name: str) -> None:
        voices = self._rt.list_builtin_voices()
        match = next((voice for voice in voices if voice.get("voice") == name), None)
        if match is None:
            raise BackendLoadError(f"unknown builtin voice: {name}")
        self._voice_rows = list(match["prompt_audio_codes"])

    def set_speaker(self, sid) -> None:
        return None

    def set_voice(self, audio, sr) -> None:
        self._voice_rows = self._encode_reference(
            np.asarray(audio, dtype=np.float32), int(sr)
        )

    def _encode_reference(self, audio: np.ndarray, sr: int):
        config = self._rt.codec_meta["codec_config"]
        target_sr = int(config["sample_rate"])
        target_channels = int(config["channels"])
        quantizers = int(config["num_quantizers"])
        mono = (
            audio.mean(axis=0).astype(np.float32)
            if audio.ndim > 1
            else audio.astype(np.float32)
        )
        if mono.size and sr != target_sr:
            mono = self._resample(mono, sr, target_sr)
        waveform = np.tile(mono[None, :], (target_channels, 1))[None, :, :].astype(
            np.float32
        )
        session = self._rt.sessions["codec_encode"]
        outputs = session.run(
            None,
            {
                "waveform": waveform,
                "input_lengths": np.asarray([waveform.shape[-1]], dtype=np.int32),
            },
        )
        named = dict(zip([output.name for output in session.get_outputs()], outputs))
        codes = np.asarray(named["audio_codes"], dtype=np.int32)
        code_length = int(np.asarray(named["audio_code_lengths"]).reshape(-1)[0])
        return [
            [int(codes[0, frame, quantizer]) for quantizer in range(quantizers)]
            for frame in range(code_length)
        ]

    @staticmethod
    def _resample(samples: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
        output_size = int(round(samples.shape[0] * sr_out / float(sr_in)))
        if output_size <= 0:
            return samples.astype(np.float32)
        input_positions = np.linspace(
            0.0, 1.0, num=samples.shape[0], endpoint=False
        )
        output_positions = np.linspace(0.0, 1.0, num=output_size, endpoint=False)
        return np.interp(output_positions, input_positions, samples).astype(np.float32)

    def generate(self, text, speed=1.0):
        started = time.time()
        chunks = list(self._iter_chunks(text))
        samples = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
        return samples.astype(np.float32), int((time.time() - started) * 1000)

    def generate_stream(self, text, speed=1.0):
        yield from self._iter_chunks(text)

    def _resolve_prompt_audio_codes(self):
        if self._voice_rows is not None:
            return self._voice_rows
        voices = self._rt.list_builtin_voices()
        voice = next(
            (item for item in voices if item.get("voice") == self.preset_voice),
            voices[0],
        )
        return list(voice["prompt_audio_codes"])

    def _iter_chunks(self, text):
        from .moss_tts.ort_runtime import _resolve_stream_decode_frame_budget

        runtime = self._rt
        token_ids = [
            int(token)
            for token in self._sp.encode(str(text or ""), out_type=int)
        ]
        request_rows = runtime.build_voice_clone_request_rows(
            self._resolve_prompt_audio_codes(), token_ids
        )
        sample_rate = int(runtime.codec_meta["codec_config"]["sample_rate"])
        output_queue: "queue.Queue" = queue.Queue()
        pending: list = []
        state = {"emitted": 0, "first_at": None}
        runtime.codec_streaming_session.reset()

        def decode_pending(force: bool) -> None:
            if not pending:
                return
            budget = _resolve_stream_decode_frame_budget(
                state["emitted"], sample_rate, state["first_at"]
            )
            if not force and len(pending) < max(1, budget):
                return
            take = len(pending) if force else min(len(pending), max(1, budget))
            frame_chunk = pending[:take]
            del pending[:take]
            decoded = runtime.codec_streaming_session.run_frames(frame_chunk)
            if decoded is None:
                return
            audio, audio_length = decoded
            if audio_length <= 0:
                return
            if state["first_at"] is None:
                state["first_at"] = time.perf_counter()
            state["emitted"] += audio_length
            output_queue.put(
                audio[0, :, :audio_length].mean(axis=0).astype(np.float32)
            )

        def on_frame(_frames, _step_index, frame) -> None:
            pending.append(list(frame))
            decode_pending(False)

        def worker() -> None:
            try:
                runtime.generate_audio_frames(request_rows, on_frame=on_frame)
                decode_pending(True)
            except Exception as exc:
                output_queue.put(exc)
            finally:
                runtime.codec_streaming_session.reset()
                output_queue.put(None)

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        try:
            while True:
                item = output_queue.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            thread.join(timeout=60)

    def unload(self) -> None:
        self._rt = None
        self._sp = None
        self._voice_rows = None

    @property
    def is_loaded(self) -> bool:
        return self._rt is not None
