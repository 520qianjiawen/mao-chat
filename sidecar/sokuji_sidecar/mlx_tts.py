"""macOS MLX TTS backend (spec D5): Qwen3-TTS and MOSS-TTS-Nano on Apple
Silicon via the mlx-audio package. Registered under the NAME "mlx_audio_tts".

mlx-audio's Model.generate() is a generator that yields audio chunks; this
backend adapts those chunks to the shared TTS streaming contract (generate /
generate_stream + set_voice / set_builtin_voice / set_speaker / set_language /
sample_rate), so tts_engine drives it exactly like the ONNX streaming backends.

mlx-audio is an Apple-Silicon-only (Metal) wheel. It is imported LAZILY inside
load(), so importing this module on the Linux/Windows dev venv never touches it;
load() raises BackendLoadError when the wheel is absent, which the accel
resolver treats as a normal fallback to the ONNX cpu row."""
import inspect
import os
import tempfile
import time

import numpy as np

from .backends import register_backend, BackendLoadError

# Short id -> mlx-community HF repo. Unknown ids (the usual case: the catalog
# Deployment.artifact already IS the mlx-community repo) pass straight through.
MLX_TTS_REPOS: dict[str, str] = {}


def _extract_samples(chunk) -> np.ndarray:
    """Adapt one mlx-audio generation chunk to a 1-D float32 numpy array.

    mlx-audio's generate() yields GenerationResult-like objects; across releases
    the audio payload has appeared under `.audio` (an mlx array), with `.samples`
    / `.wav` as aliases, and the object is sometimes the raw array itself. This
    single function is the seam to fix if the real attribute name — or the
    mlx->numpy conversion (a live mlx array may need mx.eval()/np.array()) —
    differs on Apple hardware. See the deferred mac checklist."""
    data = chunk
    for attr in ("audio", "samples", "wav"):
        val = getattr(chunk, attr, None)
        if val is not None:
            data = val
            break
    return np.asarray(data, dtype=np.float32).reshape(-1)


# Qwen3-TTS CustomVoice (mlx-community/*-CustomVoice-*) baked-in speakers.
# Source of truth at load time is model.get_supported_speakers(); this list is
# the offline voice-picker fallback when the model isn't loaded yet.
QWEN3_CUSTOM_VOICE_SPEAKERS = (
    "vivian", "serena", "uncle_fu", "ryan", "aiden",
    "ono_anna", "sohee", "eric", "dylan",
)
_QWEN3_SPEAKER_META = {
    "vivian": {"language": "zh", "curated": True, "default": True},
    "serena": {"language": "en", "curated": True},
    "uncle_fu": {"language": "zh"},
    "ryan": {"language": "en"},
    "aiden": {"language": "en"},
    "ono_anna": {"language": "ja", "curated": True},
    "sohee": {"language": "ko", "curated": True},
    "eric": {"language": "zh"},      # sichuan dialect in upstream config
    "dylan": {"language": "zh"},     # beijing dialect in upstream config
}


def qwen3_custom_voice_descriptors() -> list[dict]:
    """Voice picker entries for the MLX Qwen3-TTS CustomVoice models."""
    out = []
    for name in QWEN3_CUSTOM_VOICE_SPEAKERS:
        meta = _QWEN3_SPEAKER_META.get(name, {})
        out.append({
            "name": name,
            "language": meta.get("language"),
            "gender": None,
            "curated": bool(meta.get("curated")),
            "unstable": False,
            "default": bool(meta.get("default")),
        })
    return out


@register_backend
class MlxAudioTtsBackend:
    NAME = "mlx_audio_tts"
    # MLX GPU streams are thread-bound (mlx_audio server notes the same).
    # tts_engine drives STREAMING backends in a run_in_executor worker, which
    # then hits: "There is no Stream(gpu, 0) in current thread." Keep one-shot
    # generate on the event-loop thread (same as tts_init/load). Also set
    # THREAD_AFFINE so a future STREAMING=True path stays on that thread.
    STREAMING = False
    THREAD_AFFINE = True
    CLONES = True

    def __init__(self):
        self._model = None
        self._voice = None        # builtin voice name OR a staged reference-clip path
        self._ref_path = None     # temp wav backing a clip clone (cleaned on unload)
        self._ref_text = ""       # reference transcript (ICL) — stored; see checklist
        self._lang = ""
        self._speakers: list[str] = []  # CustomVoice speaker names when available
        self._clone_mode = False  # MOSS-TTS-Nano: generate() wants codes/ref, not voice=
        self._prompt_audio_codes = None  # list[list[int]] from the ONNX builtin manifest
        self.sample_rate = 24000

    # ---- loading -----------------------------------------------------------
    def load(self, model_ref: str, device: str, compute_type: str, config=None) -> None:
        self._model = None
        self._speakers = []
        self._clone_mode = False
        self._prompt_audio_codes = None
        try:
            from mlx_audio.tts.utils import load_model
            repo = MLX_TTS_REPOS.get(model_ref, model_ref)
            # The repo is pre-downloaded by native_models; load_model resolves it
            # from the HF cache. device/compute_type are ignored — mlx runs Metal.
            self._model = load_model(repo)
            self.sample_rate = int(getattr(self._model, "sample_rate", 24000) or 24000)
            # Qwen3 CustomVoice exposes get_supported_speakers(); MOSS may not.
            getter = getattr(self._model, "get_supported_speakers", None)
            if callable(getter):
                try:
                    self._speakers = [str(s) for s in (getter() or [])]
                except Exception:
                    self._speakers = []
            # CustomVoice generate() REQUIRES a speaker name — pick a default so
            # a session that never called set_builtin_voice still synthesizes.
            if self._voice is None and self._speakers:
                self._voice = self._default_speaker()
            self._clone_mode = self._detect_clone_mode()
        except Exception as e:  # missing wheel / not Apple Silicon / bad repo → resolver falls back
            self._model = None
            self._speakers = []
            self._clone_mode = False
            raise BackendLoadError(str(e))

    def _default_speaker(self) -> str:
        prefs = ("vivian", "serena", "ryan", "aiden")
        for p in prefs:
            if p in self._speakers:
                return p
        return self._speakers[0] if self._speakers else "vivian"

    def _detect_clone_mode(self) -> bool:
        """True for MOSS-TTS-Nano (and siblings) whose generate() clones from
        ``prompt_audio_codes`` / ``ref_audio`` and ignores a speaker ``voice=``.

        Qwen3 CustomVoice exposes get_supported_speakers() and must keep the
        ``voice=`` path. Signature-based detection stays conservative: both
        clone kwargs must be present so an ICL model that only takes ref_audio
        is not misclassified.
        """
        if self._speakers:
            return False
        model_type = str(
            getattr(self._model, "model_type", "")
            or getattr(getattr(self._model, "config", None), "model_type", "")
            or ""
        )
        if "moss" in model_type.lower():
            return True
        gen = getattr(self._model, "generate", None)
        if not callable(gen):
            return False
        try:
            params = inspect.signature(gen).parameters
        except (TypeError, ValueError):
            return False
        return "prompt_audio_codes" in params and "ref_audio" in params

    # ---- voice / language --------------------------------------------------
    def set_language(self, lang) -> None:
        self._lang = lang or ""

    def set_speaker(self, sid) -> None:
        pass  # mlx voices are named, not a numeric speaker range

    def _resolve_named_speaker(self, name: str | None) -> str:
        """Map a UI/settings voice name onto a supported CustomVoice speaker.

        Stale settings from other models (e.g. MOSS ``Xiaoyu``) must not reach
        generate() — Qwen3 CustomVoice only accepts its own speaker list.
        """
        n = str(name or "").strip()
        if not n:
            return self._default_speaker()
        # Reference-clip path from set_voice() is not a speaker name.
        if self._ref_path and n == self._ref_path:
            return n
        if os.path.isfile(n):
            return n
        if self._speakers:
            for s in self._speakers:
                if s.lower() == n.lower():
                    return s
            return self._default_speaker()
        # Speakers unknown (e.g. MOSS MLX without get_supported_speakers).
        return n

    def set_builtin_voice(self, name: str) -> None:
        self._clear_ref_file()
        self._ref_text = ""
        if self._clone_mode:
            # Store the name; codes resolve lazily in _clone_gen_kwargs so a
            # missing ONNX snapshot during init cannot disable the whole TTS
            # stage (set_voice is called from LocalNativeClient.connect).
            self._voice = str(name or "").strip()
            self._prompt_audio_codes = None
            return
        self._prompt_audio_codes = None
        self._voice = self._resolve_named_speaker(name)

    def set_voice(self, audio, sr, ref_text: str = "") -> None:
        """Zero-shot clone: stage the clip to a temp float32 wav.

        Qwen3 CustomVoice takes that path as ``voice=``. MOSS-TTS-Nano ignores
        ``voice=`` and needs ``ref_audio=`` (or builtin ``prompt_audio_codes``).
        """
        import soundfile
        wav = np.asarray(audio, dtype=np.float32)
        if wav.ndim > 1:
            # Reference clips reach set_voice channel-first ([channels, samples]),
            # matching MOSS._encode_reference and Qwen3TtsOnnxBackend.set_voice —
            # average over the CHANNEL axis (0), not the sample/time axis.
            wav = wav.mean(axis=0).astype(np.float32)
        self._clear_ref_file()
        fd, path = tempfile.mkstemp(prefix="sokuji_mlx_ref_", suffix=".wav")
        os.close(fd)
        # Track the temp path BEFORE writing so a soundfile.write failure can't
        # leak it — the next _clear_ref_file()/unload() then removes it.
        self._ref_path = path
        soundfile.write(path, wav, int(sr))
        self._voice = path
        self._ref_text = ref_text or ""
        self._prompt_audio_codes = None

    def _codes_for_voice(self, name: str | None):
        from .tts_voices import load_builtin_voice_codes
        return load_builtin_voice_codes(name, "moss-tts-nano")

    def _clone_gen_kwargs(self, text, speed) -> dict:
        # moss_tts_nano.generate() requires ref_audio or prompt_audio_codes.
        # Passing voice="Xiaoyu" is silently ignored, then raises ValueError
        # and LocalNativeClient skips the sentence — virtual mic stays silent.
        kw = {"text": str(text or ""), "speed": float(speed)}
        if self._lang:
            kw["lang_code"] = self._lang
        if self._ref_path:
            kw["ref_audio"] = self._ref_path
            if self._ref_text:
                kw["ref_text"] = self._ref_text
            return kw
        name = str(self._voice or "").strip()
        if not name or os.path.isfile(name):
            from .tts_voices import default_builtin_voice_name
            name = default_builtin_voice_name(self._lang)
            self._voice = name
        if self._prompt_audio_codes is None:
            self._prompt_audio_codes = self._codes_for_voice(name)
        if not self._prompt_audio_codes:
            raise RuntimeError(
                f"MOSS-TTS voice {name!r} has no prompt_audio_codes; "
                "download the model again or pick a custom reference clip."
            )
        kw["prompt_audio_codes"] = self._prompt_audio_codes
        return kw

    def _gen_kwargs(self, text, speed) -> dict:
        if self._clone_mode:
            return self._clone_gen_kwargs(text, speed)
        # CustomVoice models raise if `voice` is omitted or unknown; always
        # resolve to a supported speaker (or a reference-clip path).
        voice = self._resolve_named_speaker(self._voice)
        self._voice = voice
        kw = {"text": str(text or ""), "speed": float(speed), "voice": voice}
        if self._lang:
            # mlx-audio accepts lang_code='auto' or language names; pass raw
            # BCP-47-ish codes through — auto handles most cases when empty.
            kw["lang_code"] = self._lang
        if self._ref_text:
            kw["ref_text"] = self._ref_text
        return kw

    def _invoke_generate(self, text, speed):
        """Call model.generate with only kwargs it actually accepts.

        Qwen3 CustomVoice takes voice=/speed=/lang_code=; MOSS-TTS-Nano
        takes prompt_audio_codes=/ref_audio= and would raise if we only
        sent voice=. Extra keys are dropped when the callable has no
        ``**kwargs``.
        """
        kw = self._gen_kwargs(text, speed)
        gen = self._model.generate
        try:
            params = inspect.signature(gen).parameters
        except (TypeError, ValueError):
            return gen(**kw)
        if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()):
            return gen(**kw)
        return gen(**{k: v for k, v in kw.items() if k in params})

    # ---- synthesis ---------------------------------------------------------
    def generate(self, text, speed=1.0):
        t0 = time.time()
        parts = [_extract_samples(c) for c in self._invoke_generate(text, speed)]
        parts = [p for p in parts if p.size]
        # _extract_samples already returns float32 and np.concatenate preserves
        # it, so `full` is float32 — no redundant astype copy of the whole clip.
        full = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        return full, int((time.time() - t0) * 1000)

    def generate_stream(self, text, speed=1.0):
        for chunk in self._invoke_generate(text, speed):
            samples = _extract_samples(chunk)
            if samples.size:
                yield samples

    # ---- lifecycle ---------------------------------------------------------
    def _clear_ref_file(self) -> None:
        if self._ref_path:
            try:
                os.remove(self._ref_path)
            except OSError:
                pass
            self._ref_path = None

    def unload(self) -> None:
        self._model = None
        self._clear_ref_file()
        self._voice = None
        self._ref_text = ""
        self._speakers = []
        self._clone_mode = False
        self._prompt_audio_codes = None

    @property
    def is_loaded(self) -> bool:
        return self._model is not None
