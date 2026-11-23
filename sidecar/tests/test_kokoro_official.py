"""Unit tests for the official hexgrad Kokoro backend (no real torch needed)."""
from types import SimpleNamespace
from pathlib import Path

import numpy as np
import pytest

from sokuji_sidecar.kokoro_official import (
    KOKORO_OFFICIAL_VOICE_NAMES,
    KokoroOfficialBackend,
    kokoro_official_voice_descriptors,
)
from sokuji_sidecar.backends import BackendLoadError


def test_official_voice_list_covers_all_languages():
    assert "af_heart" in KOKORO_OFFICIAL_VOICE_NAMES
    assert "zf_xiaoxiao" in KOKORO_OFFICIAL_VOICE_NAMES
    assert "jf_alpha" in KOKORO_OFFICIAL_VOICE_NAMES
    assert "ef_dora" in KOKORO_OFFICIAL_VOICE_NAMES
    assert "ff_siwis" in KOKORO_OFFICIAL_VOICE_NAMES
    assert "hf_alpha" in KOKORO_OFFICIAL_VOICE_NAMES
    assert "if_sara" in KOKORO_OFFICIAL_VOICE_NAMES
    assert "pf_dora" in KOKORO_OFFICIAL_VOICE_NAMES
    rows = kokoro_official_voice_descriptors()
    assert len(rows) == len(KOKORO_OFFICIAL_VOICE_NAMES) == 53
    heart = next(r for r in rows if r["name"] == "af_heart")
    assert heart["default"] is True and heart["language"] == "en"
    spanish = next(r for r in rows if r["name"] == "ef_dora")
    assert spanish["default"] is True and spanish["language"] == "es"


def test_set_builtin_voice_rejects_unknown_without_snapshot():
    b = KokoroOfficialBackend()
    with pytest.raises(BackendLoadError, match="unknown Kokoro voice"):
        b.set_builtin_voice("not_a_voice")


def test_generate_concatenates_pipeline_chunks(monkeypatch, tmp_path):
    """Drive generate() with a fake KPipeline that yields two audio chunks."""
    b = KokoroOfficialBackend()
    b._root = tmp_path
    b._model = object()  # truthy "loaded"
    b._device = "cpu"
    b._voice = "af_heart"
    (tmp_path / "voices").mkdir()
    (tmp_path / "voices" / "af_heart.pt").write_bytes(b"x")

    class FakePipe:
        def __call__(self, text, voice, speed=1.0):
            assert text == "Hello"
            assert voice.endswith("af_heart.pt")
            assert speed == 1.25
            yield ("Hello", "həˈloʊ", np.ones(4, dtype=np.float32))
            yield ("", "", np.full(2, 0.5, dtype=np.float32))

    b._pipelines["a"] = FakePipe()
    samples, ms = b.generate("Hello", speed=1.25)
    assert samples.dtype == np.float32
    assert samples.tolist() == [1.0, 1.0, 1.0, 1.0, 0.5, 0.5]
    assert ms >= 0


def test_load_requires_weights(monkeypatch, tmp_path):
    b = KokoroOfficialBackend()

    # Pretend torch/kokoro import succeeds but snapshot is incomplete.
    import sys
    import types

    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(is_available=lambda: False)
    fake_kokoro = types.ModuleType("kokoro")

    class FakeKModel:
        def __init__(self, **kw):
            pass

        def to(self, device):
            return self

        def eval(self):
            return self

    fake_kokoro.KModel = FakeKModel
    fake_kokoro.KPipeline = object
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "kokoro", fake_kokoro)

    monkeypatch.setattr(
        "huggingface_hub.snapshot_download",
        lambda **kw: str(tmp_path),
    )
    (tmp_path / "config.json").write_text("{}")
    # missing pth + voices
    with pytest.raises(BackendLoadError, match="incomplete"):
        b.load("hexgrad/Kokoro-82M", "cpu", "fp32")


def test_normalize_kokoro_text_collapses_spaces_and_soft_wraps():
    from sokuji_sidecar.kokoro_official import _normalize_kokoro_text

    # Extra spaces, tabs, NBSP, zero-width chars, space before punctuation
    raw = "Hello   world\u00a0\u00a0,  this\t\tis\u200b a   test .\nNext line in same para.\n\nSecond paragraph."
    assert (
        _normalize_kokoro_text(raw, lang_code="a")
        == "Hello world, this is a test. Next line in same para.\nSecond paragraph."
    )

    # CJK soft line wraps should join without extra spaces, while keeping space around Latin words
    zh_raw = "你好世界，\n今天天气不错。\n\n第二段  hello\nworld"
    assert _normalize_kokoro_text(zh_raw, lang_code="z") == "你好世界，今天天气不错。\n第二段 hello world"


def test_trim_silence_removes_excessive_padding():
    from sokuji_sidecar.kokoro_official import _trim_silence

    sr = 24000
    # 500ms silence + 100ms speech + 500ms silence
    wav = np.concatenate([
        np.zeros(sr // 2, dtype=np.float32),
        np.full(sr // 10, 0.4, dtype=np.float32),
        np.zeros(sr // 2, dtype=np.float32),
    ])
    trimmed = _trim_silence(wav, sr=sr, keep_lead_ms=25.0, keep_trail_ms=55.0)
    # Expected: 25ms + 100ms + 55ms = 180ms = 4320 samples
    assert trimmed.size == int(sr * 0.18)
    # All-silent chunk collapses to empty
    assert _trim_silence(np.zeros(sr // 4, dtype=np.float32), sr=sr).size == 0


def test_generate_trims_inter_chunk_silence_and_normalizes_text(tmp_path):
    b = KokoroOfficialBackend()
    b._root = tmp_path
    b._model = object()
    b._device = "cpu"
    b._voice = "af_heart"
    (tmp_path / "voices").mkdir()
    (tmp_path / "voices" / "af_heart.pt").write_bytes(b"x")

    sr = b.sample_rate
    seen_text = []

    class FakeResult:
        def __init__(self, audio, text_index):
            self.audio = audio
            self.text_index = text_index

    class FakePipe:
        def __call__(self, text, voice, speed=1.0):
            seen_text.append(text)
            # Each chunk has 500ms leading + 100ms speech + 500ms trailing silence
            speech = np.full(sr // 10, 0.5, dtype=np.float32)
            pad = np.zeros(sr // 2, dtype=np.float32)
            chunk = np.concatenate([pad, speech, pad])
            yield FakeResult(chunk, 0)
            yield FakeResult(chunk, 0)  # same-paragraph split
            yield FakeResult(chunk, 1)  # paragraph break

    b._pipelines["a"] = FakePipe()
    samples, _ms = b.generate("Hello   world\nstill para one.\n\nPara two.", speed=1.0)
    assert seen_text == ["Hello world still para one.\nPara two."]
    # Chunk 0: 20ms + 100ms + 55ms = 175ms
    # Chunk 1: 25ms + 100ms + 140ms = 265ms
    # Chunk 2: 25ms + 100ms + 60ms = 185ms
    # Total = 625ms (15000 samples) instead of 3300ms (79200 samples)!
    assert samples.size == int(sr * 0.625)
