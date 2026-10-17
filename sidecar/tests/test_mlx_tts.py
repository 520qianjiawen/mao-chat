"""macOS MLX TTS backend (spec D5). mlx-audio is Apple-Silicon-only, so it is
faked via sys.modules (mirrors test_ct2_opus's stub pattern); every test runs
green on the Linux dev box."""
import os
import sys
import types

import numpy as np
import pytest

from sokuji_sidecar import backends, tts_backends  # noqa: F401 (registers mlx_audio_tts)


class _StubChunk:
    def __init__(self, audio):
        self.audio = audio


class _StubModel:
    sample_rate = 24000

    def __init__(self, speakers=None):
        self.calls = []
        self._speakers = list(speakers) if speakers is not None else []

    def get_supported_speakers(self):
        return list(self._speakers)

    def generate(self, text, voice=None, speed=1.0, **extra):
        self.calls.append({"text": text, "voice": voice, "speed": speed, **extra})
        yield _StubChunk(np.array([0.1, 0.2], dtype=np.float32))
        yield _StubChunk(np.array([0.3], dtype=np.float32))


def _install_mlx(monkeypatch, load_model):
    """Register a fake mlx_audio.tts.utils.load_model for the duration of a test."""
    utils = types.ModuleType("mlx_audio.tts.utils")
    utils.load_model = load_model
    tts_pkg = types.ModuleType("mlx_audio.tts")
    tts_pkg.utils = utils
    root = types.ModuleType("mlx_audio")
    root.tts = tts_pkg
    monkeypatch.setitem(sys.modules, "mlx_audio", root)
    monkeypatch.setitem(sys.modules, "mlx_audio.tts", tts_pkg)
    monkeypatch.setitem(sys.modules, "mlx_audio.tts.utils", utils)


def test_registered_and_flags():
    b = backends.make_backend("mlx_audio_tts")
    # STREAMING must stay False: MLX GPU streams are thread-bound and the
    # streaming path runs generate_stream in a worker (Stream(gpu,0) crash).
    assert b.NAME == "mlx_audio_tts" and b.STREAMING is False and b.CLONES is True
    assert getattr(b, "THREAD_AFFINE", False) is True
    assert b.is_loaded is False


def test_backend_registered_by_importing_tts_backends():
    # Production startup imports tts_engine -> tts_backends; that chain must
    # register mlx_audio_tts so make_backend finds it (Linux-safe: no mlx_audio import).
    assert "mlx_audio_tts" in backends._BACKENDS


def test_load_missing_wheel_raises_backend_load_error():
    # No mlx_audio in the Linux venv: load() must raise BackendLoadError (from the
    # lazy import), NOT crash — this is what keeps the resolver falling back to ONNX.
    b = backends.make_backend("mlx_audio_tts")
    with pytest.raises(backends.BackendLoadError):
        b.load("mlx-community/MOSS-TTS-Nano-100M", "metal", "fp32")
    assert b.is_loaded is False


def test_load_error_from_load_model_is_wrapped(monkeypatch):
    def boom(repo):
        raise RuntimeError("bad repo")
    _install_mlx(monkeypatch, boom)
    b = backends.make_backend("mlx_audio_tts")
    with pytest.raises(backends.BackendLoadError):
        b.load("mlx-community/whatever", "metal", "fp32")


def test_load_sets_sample_rate_from_model(monkeypatch):
    class _M(_StubModel):
        sample_rate = 22050
    _install_mlx(monkeypatch, lambda repo: _M())
    b = backends.make_backend("mlx_audio_tts")
    b.load("mlx-community/x", "metal", "fp32")
    assert b.is_loaded and b.sample_rate == 22050


def test_generate_concatenates_chunks(monkeypatch):
    _install_mlx(monkeypatch, lambda repo: _StubModel())
    b = backends.make_backend("mlx_audio_tts")
    b.load("mlx-community/x", "metal", "fp32")
    samples, gen_ms = b.generate("hello", 1.0)
    assert np.allclose(samples, [0.1, 0.2, 0.3]) and samples.dtype == np.float32
    assert gen_ms >= 0


def test_generate_defaults_voice_for_custom_voice_speakers(monkeypatch):
    # Qwen3 CustomVoice raises without a speaker; after load we auto-pick one.
    model = _StubModel(speakers=["serena", "vivian", "ryan"])
    _install_mlx(monkeypatch, lambda repo: model)
    b = backends.make_backend("mlx_audio_tts")
    b.load("mlx-community/qwen3-custom", "metal", "fp32")
    assert b._voice == "vivian"          # preferred default among supported
    b.generate("hi", 1.0)
    assert model.calls[0]["voice"] == "vivian"


def test_generate_stream_yields_each_chunk(monkeypatch):
    _install_mlx(monkeypatch, lambda repo: _StubModel())
    b = backends.make_backend("mlx_audio_tts")
    b.load("mlx-community/x", "metal", "fp32")
    chunks = list(b.generate_stream("hello", 1.0))
    assert len(chunks) == 2
    assert np.allclose(chunks[0], [0.1, 0.2]) and np.allclose(chunks[1], [0.3])
    assert all(c.dtype == np.float32 for c in chunks)


def test_builtin_voice_is_passed_to_generate(monkeypatch):
    model = _StubModel(speakers=["serena", "vivian"])
    _install_mlx(monkeypatch, lambda repo: model)
    b = backends.make_backend("mlx_audio_tts")
    b.load("mlx-community/x", "metal", "fp32")
    b.set_builtin_voice("Serena")   # case-insensitive match
    b.generate("hi", 1.0)
    assert model.calls[0]["voice"] == "serena"
    assert model.calls[0]["text"] == "hi" and model.calls[0]["speed"] == 1.0


def test_stale_moss_voice_falls_back_to_default_speaker(monkeypatch):
    # Settings often keep MOSS "Xiaoyu" after switching to Qwen3-TTS; CustomVoice
    # only accepts its own list — unknown names must not reach generate().
    model = _StubModel(speakers=["serena", "vivian", "ryan"])
    _install_mlx(monkeypatch, lambda repo: model)
    b = backends.make_backend("mlx_audio_tts")
    b.load("mlx-community/qwen3", "metal", "fp32")
    b.set_builtin_voice("Xiaoyu")
    assert b._voice == "vivian"
    b.generate("hi", 1.0)
    assert model.calls[0]["voice"] == "vivian"


def test_set_speaker_is_noop_and_set_language_stores(monkeypatch):
    _install_mlx(monkeypatch, lambda repo: _StubModel())
    b = backends.make_backend("mlx_audio_tts")
    b.load("mlx-community/x", "metal", "fp32")
    b.set_speaker(5)          # no-op, must not raise
    b.set_language("ja-JP")
    assert b._lang == "ja-JP"
    assert b._gen_kwargs("x", 1.0).get("lang_code") == "ja-JP"


def test_set_voice_stages_reference_clip_and_uses_it(monkeypatch):
    model = _StubModel()
    _install_mlx(monkeypatch, lambda repo: model)
    b = backends.make_backend("mlx_audio_tts")
    b.load("mlx-community/x", "metal", "fp32")
    b.set_voice(np.zeros(1600, np.float32), 16000, ref_text="hello there")
    assert b._voice and b._voice.endswith(".wav") and os.path.exists(b._voice)
    assert b._ref_text == "hello there"
    b.generate("hi", 1.0)
    assert model.calls[0]["voice"] == b._voice   # the staged clip path IS the voice
    path = b._voice
    b.unload()
    assert not os.path.exists(path)              # temp ref cleaned up on unload


def test_set_voice_downmixes_channel_first(monkeypatch):
    # Multi-channel reference clips arrive channel-first ([channels, samples]),
    # like MOSS/Qwen3 set_voice. Downmix must average over channels (axis 0), so
    # a [2, N] stereo clip stages an N-sample mono wav — NOT a 2-sample one
    # (which axis=1 would produce, destroying the clip).
    import soundfile
    _install_mlx(monkeypatch, lambda repo: _StubModel())
    b = backends.make_backend("mlx_audio_tts")
    b.load("mlx-community/x", "metal", "fp32")
    stereo = np.zeros((2, 320), np.float32)
    b.set_voice(stereo, 16000)
    data, sr = soundfile.read(b._voice)
    assert data.shape == (320,) and sr == 16000
    b.unload()


class _StubMossModel(_StubModel):
    """MOSS-TTS-Nano signature: clone from codes/ref_audio, no speaker list."""
    model_type = "moss_tts_nano"

    def __init__(self):
        super().__init__(speakers=[])

    def get_supported_speakers(self):
        return []

    def generate(self, text, ref_audio=None, prompt_audio_codes=None, speed=1.0, **extra):
        self.calls.append({
            "text": text, "ref_audio": ref_audio,
            "prompt_audio_codes": prompt_audio_codes, "speed": speed, **extra,
        })
        yield _StubChunk(np.array([0.1, 0.2], dtype=np.float32))
        yield _StubChunk(np.array([0.3], dtype=np.float32))


def test_moss_detects_clone_mode(monkeypatch):
    _install_mlx(monkeypatch, lambda repo: _StubMossModel())
    b = backends.make_backend("mlx_audio_tts")
    b.load("mlx-community/MOSS-TTS-Nano-100M", "metal", "fp32")
    assert b._clone_mode is True


def test_moss_builtin_voice_passes_prompt_audio_codes(monkeypatch):
    model = _StubMossModel()
    _install_mlx(monkeypatch, lambda repo: model)
    from sokuji_sidecar import tts_voices
    monkeypatch.setattr(tts_voices, "load_builtin_voice_codes",
                        lambda name, model_id=None: [[1, 2], [3, 4]] if name == "Xiaoyu" else None)
    b = backends.make_backend("mlx_audio_tts")
    b.load("mlx-community/MOSS-TTS-Nano-100M", "metal", "fp32")
    b.set_builtin_voice("Xiaoyu")
    samples, _ = b.generate("你好", 1.0)
    assert np.allclose(samples, [0.1, 0.2, 0.3])
    call = model.calls[0]
    assert call["prompt_audio_codes"] == [[1, 2], [3, 4]]
    assert "voice" not in call
    assert call["ref_audio"] is None


def test_moss_generate_defaults_to_language_voice_codes(monkeypatch):
    # measure_rtf_tts / empty ttsVoice never call set_builtin_voice.
    model = _StubMossModel()
    _install_mlx(monkeypatch, lambda repo: model)
    from sokuji_sidecar import tts_voices
    monkeypatch.setattr(tts_voices, "load_builtin_voice_codes",
                        lambda name, model_id=None: [[9]] if name == "Saki" else None)
    b = backends.make_backend("mlx_audio_tts")
    b.load("mlx-community/MOSS-TTS-Nano-100M", "metal", "fp32")
    b.set_language("ja")
    b.generate("こんにちは", 1.0)
    assert model.calls[0]["prompt_audio_codes"] == [[9]]
    assert b._voice == "Saki"


def test_moss_set_voice_passes_ref_audio_not_voice(monkeypatch):
    model = _StubMossModel()
    _install_mlx(monkeypatch, lambda repo: model)
    b = backends.make_backend("mlx_audio_tts")
    b.load("mlx-community/MOSS-TTS-Nano-100M", "metal", "fp32")
    b.set_voice(np.zeros(1600, np.float32), 16000, ref_text="clone me")
    b.generate("hi", 1.0)
    call = model.calls[0]
    assert call["ref_audio"] == b._voice and str(call["ref_audio"]).endswith(".wav")
    assert call.get("ref_text") == "clone me"
    assert "voice" not in call
    assert call["prompt_audio_codes"] is None
    b.unload()


def test_extract_samples_prefers_audio_then_falls_back():
    from sokuji_sidecar import mlx_tts

    class A:
        pass
    a = A()
    a.audio = np.array([1.0, 2.0], np.float32)
    assert np.allclose(mlx_tts._extract_samples(a), [1.0, 2.0])
    # a raw array (no wrapper attributes) is accepted directly
    assert np.allclose(mlx_tts._extract_samples([3.0, 4.0]), [3.0, 4.0])


def test_resolve_tts_leads_with_mlx_on_apple_silicon(monkeypatch):
    from sokuji_sidecar import accel
    monkeypatch.setattr(accel, "current_platform", lambda: "macos")
    m = accel.Machine(os="Darwin", arch="arm64", cpu_cores=8,
                      apple_silicon=True, dml_adapters=(),
                      installed=frozenset({"mlx_audio_tts", "moss_onnx", "qwen3tts_onnx"}),
                      fingerprint="mac-p6", tc_kinds=("cpu", "metal"))
    for mid, cpu_backend in (("moss-tts-nano", "moss_onnx"),
                             ("qwen3-tts-0.6b", "qwen3tts_onnx")):
        plans = accel.resolve_tts(mid, machine=m)
        assert plans[0].backend == "mlx_audio_tts" and plans[0].tier == "gpu-metal"
        assert plans[-1].backend == cpu_backend and plans[-1].tier == "cpu"


def test_resolve_tts_has_no_mlx_row_on_linux(monkeypatch):
    from sokuji_sidecar import accel
    monkeypatch.setattr(accel, "current_platform", lambda: "linux")
    m = accel.Machine(os="Linux", arch="x86_64", cpu_cores=8,
                      apple_silicon=False, dml_adapters=(),
                      installed=frozenset({"mlx_audio_tts", "moss_onnx"}),
                      fingerprint="lin-p6", tc_kinds=("cpu",))
    plans = accel.resolve_tts("moss-tts-nano", machine=m)
    assert all(p.backend != "mlx_audio_tts" for p in plans)
    assert plans[-1].tier == "cpu"
