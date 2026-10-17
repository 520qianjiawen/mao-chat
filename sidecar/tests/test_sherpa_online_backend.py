import sys
import types

import numpy as np
import pytest

from sokuji_sidecar.backends import BackendLoadError, make_backend
from sokuji_sidecar.planner import PlanConfig


class _FakeResult:
    def __init__(self, text):
        self.text = text


class _FakeStream:
    def __init__(self):
        self.samples = []
        self.finished = False
        self.text = ""

    def accept_waveform(self, sample_rate, pcm):
        assert sample_rate == 16000
        self.samples.append(np.asarray(pcm))

    def input_finished(self):
        self.finished = True


class _FakeRecognizer:
    def __init__(self, kwargs):
        self.kwargs = kwargs
        self.streams = []

    def create_stream(self):
        stream = _FakeStream()
        self.streams.append(stream)
        return stream

    def is_ready(self, stream):
        return False

    def decode_stream(self, stream):
        raise AssertionError("not ready")

    def get_result(self, stream):
        return _FakeResult(stream.text)


@pytest.fixture
def fake_sherpa(monkeypatch, tmp_path):
    for filename in ("encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx",
                     "model.int8.onnx", "tokens.txt"):
        (tmp_path / filename).write_bytes(b"x")

    created = {}

    class _OnlineRecognizer:
        @staticmethod
        def from_transducer(**kwargs):
            recognizer = _FakeRecognizer(kwargs)
            created["recognizer"] = recognizer
            created["kind"] = "transducer"
            return recognizer

        @staticmethod
        def from_nemo_ctc(**kwargs):
            recognizer = _FakeRecognizer(kwargs)
            created["recognizer"] = recognizer
            created["kind"] = "nemo_ctc"
            return recognizer

    module = types.ModuleType("sherpa_onnx")
    module.OnlineRecognizer = _OnlineRecognizer
    monkeypatch.setitem(sys.modules, "sherpa_onnx", module)

    import huggingface_hub
    monkeypatch.setattr(huggingface_hub, "snapshot_download", lambda **kwargs: str(tmp_path))
    return created


def test_native_stream_loads_int8_transducer(fake_sherpa):
    backend = make_backend("sherpa_online")
    backend.load("org/native-stream", "cpu", "int8")
    assert backend.is_loaded and backend.STREAMING
    config = fake_sherpa["recognizer"].kwargs
    assert config["provider"] == "cpu"
    assert config["sample_rate"] == 16000
    assert config["model_type"] == ""
    assert config["blank_penalty"] == 0.0
    assert config["encoder"].endswith("encoder.int8.onnx")
    assert config["joiner"].endswith("joiner.int8.onnx")


def test_native_stream_accepts_typed_plan_config(fake_sherpa):
    """The loader always passes Plan.config; Sherpa must not assume a dict."""
    backend = make_backend("sherpa_online")

    backend.load("org/native-stream", "cpu", "int8", config=PlanConfig())

    assert backend.is_loaded
    assert fake_sherpa["recognizer"].kwargs["num_threads"] >= 1


def test_native_stream_loads_nemo_ctc_route(fake_sherpa):
    backend = make_backend("sherpa_online")

    backend.load(
        "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-80ms-int8",
        "cpu",
        "int8",
    )

    assert backend.is_loaded
    assert fake_sherpa["kind"] == "nemo_ctc"
    config = fake_sherpa["recognizer"].kwargs
    assert config["model"].endswith("model.int8.onnx")
    assert config["tokens"].endswith("tokens.txt")
    assert config["provider"] == "cpu"


def test_native_stream_keeps_legacy_mapping_thread_override(fake_sherpa):
    backend = make_backend("sherpa_online")

    backend.load("org/native-stream", "cpu", "int8", config={"num_threads": 3})

    assert fake_sherpa["recognizer"].kwargs["num_threads"] == 3


def test_partial_hypothesis_uses_replace_mode(fake_sherpa):
    backend = make_backend("sherpa_online")
    backend.load("org/native-stream", "cpu", "int8")
    stream = backend.open_stream("ja")
    assert stream.partial_mode == "replace"

    stream.feed(np.zeros(1600, np.float32))
    raw = fake_sherpa["recognizer"].streams[0]
    raw.text = "こんにちは"
    assert stream.drain() == ["こんにちは"]
    assert stream.drain() == []

    raw.text = "こんにちは世界"
    assert stream.drain() == ["こんにちは世界"]
    assert stream.end() == "こんにちは世界"
    assert raw.finished


def test_non_cpu_device_is_rejected():
    backend = make_backend("sherpa_online")
    with pytest.raises(BackendLoadError, match="supports CPU"):
        backend.load("org/native-stream", "metal", "int8")


def test_kroko_uses_required_blank_penalty(fake_sherpa):
    backend = make_backend("sherpa_online")
    backend.load("org/zipformer-en-kroko", "cpu", "int8")
    assert fake_sherpa["recognizer"].kwargs["blank_penalty"] == 4.0
    assert fake_sherpa["recognizer"].kwargs["model_type"] == "zipformer2"


def test_multilingual_export_uses_zipformer2_without_kroko_penalty(fake_sherpa):
    backend = make_backend("sherpa_online")
    backend.load("org/zipformer-ar_en_id_ja_ru_th_vi_zh", "cpu", "int8")
    config = fake_sherpa["recognizer"].kwargs
    assert config["model_type"] == "zipformer2"
    assert config["blank_penalty"] == 0.0


def test_chinese_2025_zipformer_uses_zipformer2(fake_sherpa):
    backend = make_backend("sherpa_online")
    backend.load(
        "csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30",
        "cpu",
        "int8",
    )
    assert fake_sherpa["recognizer"].kwargs["model_type"] == "zipformer2"
    assert fake_sherpa["recognizer"].kwargs["blank_penalty"] == 0.0
