import sys
import types

import numpy as np
import pytest

from sokuji_sidecar.backends import BackendLoadError, make_backend
from sokuji_sidecar.catalog import AsrLanguageIdentifier, AsrRoute
from sokuji_sidecar.planner import PlanConfig
from sokuji_sidecar.sherpa_offline_backend import (
    resolve_sticky_lang,
    script_corrected_lang,
)


class _FakeResult:
    def __init__(self, text="", lang=""):
        self.text = text
        self.lang = lang


class _FakeStream:
    def __init__(self):
        self.samples = []
        self.result = _FakeResult()

    def accept_waveform(self, sample_rate, pcm):
        assert sample_rate == 16000
        self.samples.append(np.asarray(pcm))


class _FakeRecognizer:
    def __init__(self, kwargs):
        self.kwargs = kwargs
        self.streams = []

    def create_stream(self):
        stream = _FakeStream()
        self.streams.append(stream)
        return stream

    def decode_stream(self, stream):
        stream.result.text = "国ができること"


@pytest.fixture
def fake_sherpa(monkeypatch, tmp_path):
    for filename in ("encoder_model.ort", "decoder_model_merged.ort", "tokens.txt"):
        (tmp_path / filename).write_bytes(b"x")

    created = {}

    class _OfflineRecognizer:
        @staticmethod
        def from_moonshine_v2(**kwargs):
            recognizer = _FakeRecognizer(kwargs)
            created["recognizer"] = recognizer
            return recognizer

    module = types.ModuleType("sherpa_onnx")
    module.OfflineRecognizer = _OfflineRecognizer
    monkeypatch.setitem(sys.modules, "sherpa_onnx", module)

    import huggingface_hub
    monkeypatch.setattr(huggingface_hub, "snapshot_download", lambda **kwargs: str(tmp_path))
    return created


def test_moonshine_v2_loads_and_transcribes(fake_sherpa):
    backend = make_backend("sherpa_offline")
    backend.load("org/moonshine-ja", "cpu", "int8", config=PlanConfig())

    result = backend.transcribe(np.zeros(16000, np.float32), "ja")

    assert backend.is_loaded and backend.STREAMING is False
    assert result.text == "国ができること" and result.language == "ja"
    config = fake_sherpa["recognizer"].kwargs
    assert config["encoder"].endswith("encoder_model.ort")
    assert config["decoder"].endswith("decoder_model_merged.ort")
    assert config["tokens"].endswith("tokens.txt")
    assert config["num_threads"] >= 1


def test_empty_audio_is_ignored(fake_sherpa):
    backend = make_backend("sherpa_offline")
    backend.load("org/moonshine-ja", "cpu", "int8")
    assert backend.transcribe([], "ja").text == ""


def test_non_cpu_device_is_rejected():
    backend = make_backend("sherpa_offline")
    with pytest.raises(BackendLoadError, match="supports CPU"):
        backend.load("org/moonshine-ja", "metal", "int8")


@pytest.mark.parametrize(
    "language,architecture,expected_factory",
    [
        ("ja", "reazon_zipformer", "from_transducer"),
        ("zh-CN", "paraformer", "from_paraformer"),
        ("cantonese", "sense_voice", "from_sense_voice"),
        ("es", "nemo_transducer", "from_transducer"),
        ("sw", "omnilingual_ctc", "from_omnilingual_asr_ctc"),
    ],
)
def test_hayamimi_routes_to_language_specialist(monkeypatch, tmp_path, language,
                                                 architecture, expected_factory):
    for filename in (
        "encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx",
        "model.int8.onnx", "tokens.txt",
    ):
        (tmp_path / filename).write_bytes(b"x")

    called = {}

    class _OfflineRecognizer:
        @staticmethod
        def _make(factory, **kwargs):
            called["factory"] = factory
            called["kwargs"] = kwargs
            return _FakeRecognizer(kwargs)

        @staticmethod
        def from_transducer(**kwargs):
            return _OfflineRecognizer._make("from_transducer", **kwargs)

        @staticmethod
        def from_paraformer(**kwargs):
            return _OfflineRecognizer._make("from_paraformer", **kwargs)

        @staticmethod
        def from_sense_voice(**kwargs):
            return _OfflineRecognizer._make("from_sense_voice", **kwargs)

        @staticmethod
        def from_omnilingual_asr_ctc(**kwargs):
            return _OfflineRecognizer._make("from_omnilingual_asr_ctc", **kwargs)

    module = types.ModuleType("sherpa_onnx")
    module.OfflineRecognizer = _OfflineRecognizer
    monkeypatch.setitem(sys.modules, "sherpa_onnx", module)
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda **kwargs: str(tmp_path),
    )
    routes = (
        AsrRoute(("ja",), "org/ja", "reazon_zipformer"),
        AsrRoute(("zh",), "org/zh", "paraformer"),
        AsrRoute(("ko", "yue"), "org/cjk", "sense_voice"),
        AsrRoute(("en", "es"), "org/eu", "nemo_transducer"),
        AsrRoute(("multi",), "org/omni", "omnilingual_ctc"),
    )
    config = PlanConfig(asr_routes=routes, asr_language=language)

    backend = make_backend("sherpa_offline")
    backend.load("org/default", "cpu", "int8", config=config)

    assert called["factory"] == expected_factory
    if architecture == "reazon_zipformer":
        assert called["kwargs"]["decoding_method"] == "modified_beam_search"
    if architecture == "nemo_transducer":
        assert called["kwargs"]["model_type"] == "nemo_transducer"


def test_hayamimi_language_guards_match_upstream_rules():
    assert script_corrected_lang("en", "今日は晴れです") == "ja"
    assert script_corrected_lang("ja", "this is clearly English") == "en"
    assert script_corrected_lang("en", "오늘 날씨가 좋아요") == "ko"

    first = resolve_sticky_lang("ja", "en", 3.0, None, 0)
    assert first == ("en", False, "ja", 1)
    second = resolve_sticky_lang("ja", "en", 3.0, first[2], first[3])
    assert second == ("ja", False, None, 0)
    short = resolve_sticky_lang("fr", "en", 0.8, None, 0)
    assert short[0] == "en" and short[1] is True


def test_hayamimi_auto_detects_then_loads_only_matching_route(monkeypatch, tmp_path):
    for filename in (
        "encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx",
        "model.int8.onnx", "tokens.txt",
    ):
        (tmp_path / filename).write_bytes(b"x")

    hf_home = tmp_path / "hf"
    lid_root = hf_home / "sokuji-archives" / "lid"
    lid_root.mkdir(parents=True)
    (lid_root / "tiny-encoder.int8.onnx").write_bytes(b"x")
    (lid_root / "tiny-decoder.int8.onnx").write_bytes(b"x")
    monkeypatch.setenv("HF_HOME", str(hf_home))

    factories = []

    class _RouteRecognizer(_FakeRecognizer):
        def decode_stream(self, stream):
            stream.result = _FakeResult("hello from Spain", "en")

    class _OfflineRecognizer:
        @staticmethod
        def from_transducer(**kwargs):
            factories.append(("transducer", kwargs.get("model_type")))
            return _RouteRecognizer(kwargs)

        @staticmethod
        def from_paraformer(**kwargs):
            factories.append(("paraformer", None))
            return _RouteRecognizer(kwargs)

        @staticmethod
        def from_sense_voice(**kwargs):
            factories.append(("sense_voice", None))
            return _RouteRecognizer(kwargs)

        @staticmethod
        def from_omnilingual_asr_ctc(**kwargs):
            factories.append(("omni", None))
            return _RouteRecognizer(kwargs)

    class _LidConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class _Lid:
        def __init__(self, _config):
            self.streams = []

        def create_stream(self):
            stream = _FakeStream()
            self.streams.append(stream)
            return stream

        def compute(self, _stream):
            return "es"

    module = types.ModuleType("sherpa_onnx")
    module.OfflineRecognizer = _OfflineRecognizer
    module.SpokenLanguageIdentificationWhisperConfig = _LidConfig
    module.SpokenLanguageIdentificationConfig = _LidConfig
    module.SpokenLanguageIdentification = _Lid
    monkeypatch.setitem(sys.modules, "sherpa_onnx", module)
    monkeypatch.setattr("huggingface_hub.snapshot_download", lambda **kwargs: str(tmp_path))

    routes = (
        AsrRoute(("ja",), "org/ja", "reazon_zipformer"),
        AsrRoute(("zh",), "org/zh", "paraformer"),
        AsrRoute(("ko", "yue"), "org/cjk", "sense_voice"),
        AsrRoute(("en", "es"), "org/eu", "nemo_transducer"),
        AsrRoute(("multi",), "org/omni", "omnilingual_ctc"),
    )
    lid = AsrLanguageIdentifier(
        "whisper", "https://example.invalid/lid.tar.bz2", "lid",
        ("tiny-encoder.int8.onnx", "tiny-decoder.int8.onnx"), 1,
    )
    backend = make_backend("sherpa_offline")
    backend.load("org/default", "cpu", "int8", PlanConfig(
        asr_routes=routes, asr_language="auto", asr_language_identifier=lid,
    ))

    assert factories == []
    result = backend.transcribe(np.ones(80_000, np.float32), "auto")
    assert result.language == "es" and result.text == "hello from Spain"
    assert factories == [("transducer", "nemo_transducer")]
    lid_pcm = backend._lid.streams[0].samples[0]
    assert lid_pcm.size == 64_000
