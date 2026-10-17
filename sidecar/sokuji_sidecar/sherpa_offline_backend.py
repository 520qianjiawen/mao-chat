"""Native sherpa-onnx offline backend for live-caption speech segments.

Besides standalone Moonshine cards, this implements Hayamimi's routed ASR:
Whisper-tiny language identification selects a specialist recognizer, while
sticky language switching and decoded-script checks reject common LID errors.
Only the language identifier and one specialist recognizer are resident.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import numpy as np

from .backends import AsrResult, BackendLoadError, register_backend
from .sherpa_online_backend import _pick_tokens


_LANGUAGE_ALIASES = {
    "cantonese": "yue",
    "chinese": "zh",
    "english": "en",
    "japanese": "ja",
    "korean": "ko",
}
_LID_MAX_SECONDS = 4.0
_LID_EARLY_SECONDS = 2.0
_MIN_SWITCH_SECONDS = 2.0
_LID_SWITCH_CONFIRM = 2
_REAZON_MARKS = "［］〈〉"


def _language_key(language: str | None) -> str:
    key = str(language or "").strip().lower()
    match = re.fullmatch(r"<\|([a-z_-]+)\|>", key)
    if match:
        key = match.group(1)
    key = key.replace("_", "-").split("-", 1)[0]
    return _LANGUAGE_ALIASES.get(key, key)


def _has_kana(text: str) -> bool:
    return any("぀" <= char <= "ヿ" for char in text)


def script_corrected_lang(tagged: str, text: str) -> str:
    """Correct a language tag that contradicts the decoded writing system."""
    letters = [char for char in text if char.isalpha()]
    if not letters:
        return tagged
    cjk = sum(1 for char in letters
              if "぀" <= char <= "ヿ" or "一" <= char <= "鿿")
    hangul = sum(1 for char in letters if "가" <= char <= "힯")
    if hangul / len(letters) > 0.3 and tagged != "ko":
        return "ko"
    if tagged == "ko" and hangul == 0 and len(letters) >= 4:
        return "zh" if cjk / len(letters) > 0.3 else "en"
    cjk_fraction = cjk / len(letters)
    if cjk_fraction > 0.3 and tagged not in ("ja", "zh", "yue", "ko"):
        return "ja"
    if cjk_fraction < 0.05 and tagged == "ja" and len(letters) >= 8:
        return "en"
    return tagged


def resolve_sticky_lang(lang: str, last_lang: str | None,
                        speech_seconds: float, pending_lang: str | None,
                        pending_count: int) -> tuple[str, bool, str | None, int]:
    """Require two consecutive detections before changing session language."""
    if last_lang is None or lang == last_lang:
        return lang, False, None, 0
    if lang == pending_lang:
        pending_count += 1
    else:
        pending_lang, pending_count = lang, 1
    if pending_count < _LID_SWITCH_CONFIRM:
        suppress_fallback = speech_seconds < _MIN_SWITCH_SECONDS
        return last_lang, suppress_fallback, pending_lang, pending_count
    return lang, False, None, 0


def _pick_asset(root: Path, pattern: str) -> Path:
    candidates = sorted(
        (path for path in root.rglob(pattern)
         if path.is_file() and "test_wavs" not in path.parts),
        key=lambda path: (len(path.parts), path.name),
    )
    if not candidates:
        raise BackendLoadError(f"missing {pattern} model file in {root}")
    return candidates[0]


def _pick_moonshine_asset(root: Path, kind: str) -> Path:
    candidates = sorted(
        (path for path in root.rglob("*")
         if path.is_file()
         and path.suffix.lower() in {".ort", ".onnx"}
         and kind in path.name.lower()
         and "test_wavs" not in path.parts),
        key=lambda path: (len(path.parts), path.name),
    )
    if not candidates:
        raise BackendLoadError(f"missing {kind} Moonshine model file in {root}")
    return candidates[0]


def _config_value(config, name, default=None):
    if hasattr(config, "get"):
        return config.get(name, default)
    return getattr(config, name, default)


def _field(value, name, default=None):
    if hasattr(value, "get"):
        return value.get(name, default)
    return getattr(value, name, default)


@register_backend
class SherpaOfflineBackend:
    """CPU-native Moonshine or automatic Hayamimi recognizer."""

    NAME = "sherpa_offline"
    STREAMING = False

    def __init__(self):
        self._recognizer = None
        self._recognizer_route = None
        self._model_dir: str | None = None
        self._routes = ()
        self._configured_language = ""
        self._auto = False
        self._lid = None
        self._sherpa = None
        self._threads = 1
        self._last_lang: str | None = None
        self._pending_lang: str | None = None
        self._pending_count = 0

    def load(self, model_ref: str, device: str, compute_type: str, config=None) -> None:
        self.unload()
        if device != "cpu":
            raise BackendLoadError(
                f"sherpa_offline currently supports CPU, got {device!r}"
            )
        try:
            import sherpa_onnx
            from huggingface_hub import snapshot_download

            self._sherpa = sherpa_onnx
            self._routes = tuple(_config_value(config, "asr_routes", ()) or ())
            self._configured_language = _language_key(
                _config_value(config, "asr_language", "")
            )
            self._auto = bool(self._routes and self._configured_language == "auto")
            default_threads = max(1, min(4, (os.cpu_count() or 2) // 2))
            self._threads = int(_config_value(config, "num_threads", default_threads))

            if self._routes:
                if self._auto:
                    lid = _config_value(config, "asr_language_identifier", None)
                    if lid is None:
                        raise BackendLoadError(
                            "Hayamimi automatic routing requires its language identifier"
                        )
                    self._load_language_identifier(lid)
                else:
                    self._load_route(self._route_for_language(self._configured_language))
                return

            root = Path(snapshot_download(repo_id=model_ref, local_files_only=True))
            self._recognizer = sherpa_onnx.OfflineRecognizer.from_moonshine_v2(
                encoder=str(_pick_moonshine_asset(root, "encoder")),
                decoder=str(_pick_moonshine_asset(root, "decoder")),
                tokens=str(_pick_tokens(root)), num_threads=self._threads,
                provider="cpu", decoding_method="greedy_search",
            )
            self._model_dir = str(root)
        except BackendLoadError:
            self.unload()
            raise
        except Exception as exc:
            self.unload()
            raise BackendLoadError(str(exc)) from exc

    def _load_language_identifier(self, lid) -> None:
        cache = os.path.join(
            os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface")),
            "sokuji-archives", str(_field(lid, "cache_key")),
        )
        root = Path(cache)
        members = tuple(_field(lid, "members", ()) or ())
        if _field(lid, "architecture") != "whisper" or len(members) != 2:
            raise BackendLoadError("unsupported Hayamimi language identifier")
        encoder = root / members[0]
        decoder = root / members[1]
        if not encoder.is_file() or not decoder.is_file():
            raise BackendLoadError("Hayamimi language identifier is not downloaded")
        whisper = self._sherpa.SpokenLanguageIdentificationWhisperConfig(
            encoder=str(encoder), decoder=str(decoder),
        )
        cfg = self._sherpa.SpokenLanguageIdentificationConfig(
            whisper=whisper, num_threads=self._threads,
        )
        self._lid = self._sherpa.SpokenLanguageIdentification(cfg)

    def _route_for_language(self, language: str):
        fallback = None
        for route in self._routes:
            if "multi" in route.languages:
                fallback = route
            if language in route.languages:
                return route
        if fallback is None:
            raise BackendLoadError(f"no Hayamimi route for language: {language}")
        return fallback

    def _route_for_architecture(self, architecture: str):
        return next((route for route in self._routes
                     if route.architecture == architecture), None)

    def _load_route(self, route) -> None:
        if self._recognizer is not None and self._recognizer_route == route:
            return
        from huggingface_hub import snapshot_download

        root = Path(snapshot_download(repo_id=route.artifact, local_files_only=True))
        tokens = _pick_tokens(root)
        architecture = route.architecture
        if architecture == "reazon_zipformer":
            recognizer = self._sherpa.OfflineRecognizer.from_transducer(
                encoder=str(_pick_asset(root, "encoder*.int8.onnx")),
                decoder=str(_pick_asset(root, "decoder*.int8.onnx")),
                joiner=str(_pick_asset(root, "joiner*.int8.onnx")),
                tokens=str(tokens), num_threads=self._threads,
                decoding_method="modified_beam_search", hotwords_file="",
                hotwords_score=2.0, modeling_unit="cjkchar",
            )
        elif architecture == "paraformer":
            recognizer = self._sherpa.OfflineRecognizer.from_paraformer(
                paraformer=str(_pick_asset(root, "model*.int8.onnx")),
                tokens=str(tokens), num_threads=self._threads,
            )
        elif architecture == "sense_voice":
            recognizer = self._sherpa.OfflineRecognizer.from_sense_voice(
                model=str(_pick_asset(root, "model*.int8.onnx")),
                tokens=str(tokens), num_threads=self._threads,
                use_itn=True, language="",
            )
        elif architecture == "nemo_transducer":
            recognizer = self._sherpa.OfflineRecognizer.from_transducer(
                encoder=str(_pick_asset(root, "encoder*.int8.onnx")),
                decoder=str(_pick_asset(root, "decoder*.int8.onnx")),
                joiner=str(_pick_asset(root, "joiner*.int8.onnx")),
                tokens=str(tokens), num_threads=self._threads,
                model_type="nemo_transducer",
            )
        elif architecture == "omnilingual_ctc":
            recognizer = self._sherpa.OfflineRecognizer.from_omnilingual_asr_ctc(
                model=str(_pick_asset(root, "model*.int8.onnx")),
                tokens=str(tokens), num_threads=self._threads,
            )
        else:
            raise BackendLoadError(
                f"unsupported sherpa offline architecture: {architecture}"
            )
        self._recognizer = recognizer
        self._recognizer_route = route
        self._model_dir = str(root)

    def _decode_route(self, route, pcm: np.ndarray) -> tuple[str, str]:
        self._load_route(route)
        stream = self._recognizer.create_stream()
        stream.accept_waveform(16000, pcm)
        self._recognizer.decode_stream(stream)
        result = getattr(stream, "result", None)
        text = str(getattr(result, "text", result) or "")
        for mark in _REAZON_MARKS:
            text = text.replace(mark, "")
        return text.strip(), _language_key(getattr(result, "lang", ""))

    def _identify_language(self, pcm: np.ndarray) -> str:
        clip = pcm
        loud = np.flatnonzero(np.abs(clip) > 0.015)
        if len(loud) and loud[0] > 1600:
            clip = clip[max(int(loud[0]) - 800, 0):]
        clip = clip[:int(_LID_MAX_SECONDS * 16000)]
        stream = self._lid.create_stream()
        stream.accept_waveform(16000, clip)
        return _language_key(self._lid.compute(stream))

    def _decode_chinese(self, pcm: np.ndarray) -> tuple[str, str, object]:
        sense = self._route_for_architecture("sense_voice")
        paraformer = self._route_for_architecture("paraformer")
        text = ""
        if sense is not None:
            text, tag = self._decode_route(sense, pcm)
            if tag == "yue":
                return text, "yue", sense
        if paraformer is not None:
            para_text, _tag = self._decode_route(paraformer, pcm)
            if para_text:
                return para_text, "zh", paraformer
        return text, "zh", (sense or paraformer)

    def _decode_detected(self, pcm: np.ndarray, detected: str,
                         update_state: bool) -> AsrResult:
        language = detected
        suppress_fallback = False
        if update_state:
            language, suppress_fallback, self._pending_lang, self._pending_count = (
                resolve_sticky_lang(
                    language, self._last_lang, pcm.size / 16000,
                    self._pending_lang, self._pending_count,
                )
            )

        if language == "zh":
            text, language, route = self._decode_chinese(pcm)
        else:
            route = self._route_for_language(language)
            text, _tag = self._decode_route(route, pcm)

        if (not text and route is not None
                and route.architecture != "omnilingual_ctc"
                and not suppress_fallback):
            fallback = self._route_for_architecture("omnilingual_ctc")
            if fallback is not None:
                text, _tag = self._decode_route(fallback, pcm)
                route = fallback

        corrected = script_corrected_lang(language, text)
        if update_state and text and corrected != language:
            if corrected == "ja" and not _has_kana(text):
                sense = self._route_for_architecture("sense_voice")
                if sense is not None:
                    probe, tag = self._decode_route(sense, pcm)
                    if probe and tag in ("zh", "yue", "ja", "ko"):
                        language = tag
                        if tag == "zh":
                            text, language, route = self._decode_chinese(pcm)
                        elif tag == "ja":
                            route = self._route_for_language("ja")
                            text2, _ = self._decode_route(route, pcm)
                            text = text2 or probe
                        else:
                            text, route = probe, sense
            else:
                corrected_route = self._route_for_language(corrected)
                corrected_text, _tag = self._decode_route(corrected_route, pcm)
                if corrected_text:
                    language, route, text = corrected, corrected_route, corrected_text

        if update_state and text:
            self._last_lang = language
        return AsrResult(text.strip(), language)

    def transcribe_partial(self, samples, language=None) -> AsrResult:
        pcm = np.ascontiguousarray(np.asarray(samples, dtype=np.float32).reshape(-1))
        if not pcm.size:
            return AsrResult("", None if self._auto else self._configured_language)
        if not self._auto:
            return self.transcribe(pcm, language)
        if pcm.size >= int(_LID_EARLY_SECONDS * 16000):
            return self._decode_detected(pcm, self._identify_language(pcm), False)

        sense = self._route_for_architecture("sense_voice")
        if sense is not None:
            text, tag = self._decode_route(sense, pcm)
            if tag == "ja":
                route = self._route_for_language("ja")
                japanese, _ = self._decode_route(route, pcm)
                return AsrResult(japanese or text, "ja")
            if text:
                return AsrResult(text, tag or self._last_lang)
        fallback_lang = self._last_lang or "ja"
        return self._decode_detected(pcm, fallback_lang, False)

    def transcribe(self, samples, language) -> AsrResult:
        if self._recognizer is None and self._lid is None:
            raise BackendLoadError("sherpa_offline not loaded")
        pcm = np.ascontiguousarray(np.asarray(samples, dtype=np.float32).reshape(-1))
        if not pcm.size:
            return AsrResult("", None if self._auto else self._configured_language)
        if self._auto:
            return self._decode_detected(pcm, self._identify_language(pcm), True)
        if self._routes:
            route = self._route_for_language(self._configured_language)
            text, _tag = self._decode_route(route, pcm)
            return AsrResult(text, self._configured_language or _language_key(language))

        stream = self._recognizer.create_stream()
        stream.accept_waveform(16000, pcm)
        self._recognizer.decode_stream(stream)
        result = getattr(stream, "result", None)
        text = getattr(result, "text", result)
        return AsrResult(str(text or "").strip(), language)

    def transcribe_refined(self, samples, language=None) -> AsrResult:
        """Decode a completed Hayamimi group without changing live LID state."""
        pcm = np.ascontiguousarray(np.asarray(samples, dtype=np.float32).reshape(-1))
        if not pcm.size:
            return AsrResult("", language or self._configured_language or None)
        if self._auto:
            detected = _language_key(language) if language else self._identify_language(pcm)
            return self._decode_detected(pcm, detected, False)
        return self.transcribe(pcm, language or self._configured_language)

    @staticmethod
    def correct_language(language, text) -> str:
        return script_corrected_lang(_language_key(language), text)

    def reset_session(self) -> None:
        """Clear LID hysteresis between unrelated streams or warm-up audio."""
        self._last_lang = None
        self._pending_lang = None
        self._pending_count = 0

    def unload(self) -> None:
        self._recognizer = None
        self._recognizer_route = None
        self._model_dir = None
        self._routes = ()
        self._configured_language = ""
        self._auto = False
        self._lid = None
        self._sherpa = None
        self.reset_session()

    @property
    def is_loaded(self) -> bool:
        return self._recognizer is not None or self._lid is not None
