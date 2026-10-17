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


def test_official_voice_list_is_en_zh_ja_only():
    assert "af_heart" in KOKORO_OFFICIAL_VOICE_NAMES
    assert "zf_xiaoxiao" in KOKORO_OFFICIAL_VOICE_NAMES
    assert "jf_alpha" in KOKORO_OFFICIAL_VOICE_NAMES
    assert not any(n.startswith(("ef_", "ff_", "hf_", "if_", "pf_")) for n in KOKORO_OFFICIAL_VOICE_NAMES)
    rows = kokoro_official_voice_descriptors()
    assert len(rows) == len(KOKORO_OFFICIAL_VOICE_NAMES) == 41
    heart = next(r for r in rows if r["name"] == "af_heart")
    assert heart["default"] is True and heart["language"] == "en"


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
