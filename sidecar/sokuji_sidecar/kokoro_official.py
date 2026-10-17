"""Official hexgrad Kokoro-82M backend (torch + misaki G2P).

Matches the Hugging Face Space / Kokoro-FastAPI pipeline:

    text → misaki G2P → Kokoro-82M (PyTorch) → 24 kHz mono

Primary product languages: English (US/GB), Mandarin Chinese, Japanese.
Weights live in the HF cache (``hexgrad/Kokoro-82M``); after the first download
the whole path runs offline (``local_files_only`` + absolute ``voices/*.pt``).

Imports of torch/kokoro/misaki are lazy inside ``load()`` so this module is
safe to import on torch-free runtimes; missing deps surface as BackendLoadError
and the resolver simply omits the plan.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import numpy as np

from .backends import register_backend, BackendLoadError

_DEFAULT_REPO = "hexgrad/Kokoro-82M"
_MODEL_FILE = "kokoro-v1_0.pth"

# Official voice pack focused on en / zh / ja (hexgrad VOICES.md).
# Order: Heart first for English, then quality defaults, then the rest.
KOKORO_OFFICIAL_VOICE_NAMES: tuple[str, ...] = (
    # American English
    "af_heart",
    "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole",
    "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    # British English
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
    # Japanese
    "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo",
    # Mandarin Chinese
    "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi",
    "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
)

_DEFAULT_VOICE_BY_LANG = {
    "en": "af_heart",
    "zh": "zf_xiaoxiao",
    "ja": "jf_alpha",
}

# First letter of the official voice id → KPipeline lang_code / product language.
_VOICE_LANG_CODE = {
    "a": "a", "b": "b", "j": "j", "z": "z",
}
_VOICE_PRODUCT_LANG = {
    "a": "en", "b": "en", "j": "ja", "z": "zh",
}


def kokoro_official_voice_descriptors() -> list[dict]:
    """Named voice rows for the renderer (no download required)."""
    out = []
    for name in KOKORO_OFFICIAL_VOICE_NAMES:
        product_lang = _VOICE_PRODUCT_LANG.get(name[0])
        gender = "F" if len(name) > 1 and name[1] == "f" else "M"
        default = _DEFAULT_VOICE_BY_LANG.get(product_lang) == name
        curated = default or name in ("af_bella", "zf_xiaoyi", "jf_gongitsune")
        out.append({
            "name": name,
            "language": product_lang,
            "gender": gender,
            "curated": curated,
            "unstable": False,
            "default": default,
        })
    return out


def _resolve_device(requested: str) -> str:
    """Map catalog device labels onto torch devices. Prefer CPU on macOS unless
    the caller explicitly asked for CUDA and it is available — MPS needs a
    special fallback env and is not reliable enough for the default path."""
    import torch
    req = (requested or "cpu").lower()
    if req in ("cuda", "gpu", "gpu-cuda") and torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _ensure_unidic_dictionary() -> None:
    """Ensure UniDic MeCab data is present for Japanese G2P.

    Large dictionary data (~800 MB) is NOT bundled in the macOS pkg — first
    Japanese Kokoro use downloads it into a user-writable extras directory
    (see ``runtime_extras.ensure_unidic_dictionary``).
    """
    try:
        from .runtime_extras import ensure_unidic_dictionary
        ensure_unidic_dictionary()
    except Exception as exc:
        raise BackendLoadError(str(exc)) from exc


def _ensure_spacy_en_model() -> None:
    """Ensure spaCy ``en_core_web_sm`` is available for English Kokoro G2P.

    ``misaki[en]`` depends on spaCy but does not install the English model
    package. Packaging scripts should install it; this is a runtime fallback.
    """
    try:
        import en_core_web_sm  # noqa: F401
        return
    except Exception:
        pass

    import subprocess
    import sys

    try:
        # spaCy's downloader installs a version matching the installed spacy.
        result = subprocess.run(
            [sys.executable, "-m", "spacy", "download", "en_core_web_sm"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "--no-cache-dir", "en-core-web-sm"],
                capture_output=True,
                text=True,
                check=True,
            )
    except Exception as exc:
        raise BackendLoadError(
            "English Kokoro needs the spaCy model en_core_web_sm. "
            f"Automatic install failed: {exc}. Check network, then retry, "
            "or reinstall a build that bundles the model "
            "(python -m spacy download en_core_web_sm)."
        ) from exc

    try:
        import en_core_web_sm  # noqa: F401
    except Exception as exc:
        raise BackendLoadError(
            f"en_core_web_sm still missing after install attempt: {exc}"
        ) from exc


@register_backend
class KokoroOfficialBackend:
    """Official hexgrad Kokoro (torch). Non-cloning, one-shot per utterance."""

    NAME = "kokoro_official"
    STREAMING = False
    CLONES = False

    def __init__(self):
        self._model = None
        self._pipelines: dict = {}
        self._root: Path | None = None
        self._repo_id = _DEFAULT_REPO
        self._device = "cpu"
        self._voice = "af_heart"
        self._lang = "en"
        self.sample_rate = 24000

    def load(self, model_ref: str, device: str, compute_type: str, config=None) -> None:
        self.unload()
        try:
            import torch
            from kokoro import KModel
            from huggingface_hub import snapshot_download
        except Exception as exc:
            raise BackendLoadError(
                "Official Kokoro requires torch + kokoro + misaki "
                f"(import failed: {exc})"
            ) from exc

        repo = model_ref or _DEFAULT_REPO
        self._repo_id = repo
        try:
            root = Path(snapshot_download(repo_id=repo, local_files_only=True))
        except Exception as exc:
            raise BackendLoadError(
                f"Kokoro weights not downloaded yet ({repo}): {exc}"
            ) from exc

        model_path = root / _MODEL_FILE
        config_path = root / "config.json"
        voices_dir = root / "voices"
        if not model_path.is_file() or not config_path.is_file() or not voices_dir.is_dir():
            raise BackendLoadError(
                "Kokoro download incomplete: need config.json, "
                f"{_MODEL_FILE}, and voices/; re-download in Settings"
            )

        torch_device = _resolve_device(device)
        try:
            model = KModel(
                repo_id=repo,
                config=str(config_path),
                model=str(model_path),
            )
            model = model.to(torch_device).eval()
        except Exception as exc:
            raise BackendLoadError(f"failed to load Kokoro model: {exc}") from exc

        self._model = model
        self._root = root
        self._device = torch_device
        self._pipelines = {}
        self.sample_rate = 24000

    def set_language(self, lang) -> None:
        self._lang = (lang or "en").split("-")[0].lower()

    def set_speaker(self, sid) -> None:
        # Named voices only; ignore numeric sids from range UIs.
        pass

    def set_builtin_voice(self, name: str) -> None:
        voice = str(name or "").strip()
        if not voice:
            raise BackendLoadError("empty Kokoro voice name")
        if voice not in KOKORO_OFFICIAL_VOICE_NAMES:
            # Still allow any voices/*.pt present in the snapshot (future packs).
            if self._root is None or not (self._root / "voices" / f"{voice}.pt").is_file():
                raise BackendLoadError(f"unknown Kokoro voice: {voice}")
        self._voice = voice

    def set_voice(self, audio, sr) -> None:
        pass  # non-cloning

    def _voice_path(self) -> str:
        assert self._root is not None
        path = self._root / "voices" / f"{self._voice}.pt"
        if not path.is_file():
            raise BackendLoadError(
                f"voice file missing: {path.name}; re-download Kokoro"
            )
        return str(path)

    def _pipeline_for_voice(self, voice_name: str):
        code = _VOICE_LANG_CODE.get(voice_name[0], "a")
        pipe = self._pipelines.get(code)
        if pipe is not None:
            return pipe
        # Language-specific G2P data not shipped by pip alone.
        if code in ("a", "b"):  # American / British English → spaCy en_core_web_sm
            _ensure_spacy_en_model()
        if code == "j":  # Japanese → UniDic MeCab dictionary
            _ensure_unidic_dictionary()
        # Lazy import so cached pipelines work in tests without the package.
        from kokoro import KPipeline
        # model= shared KModel instance — one weight load for all languages.
        try:
            pipe = KPipeline(
                lang_code=code,
                repo_id=self._repo_id,
                model=self._model,
                device=self._device,
            )
        except Exception as exc:
            raise BackendLoadError(
                f"Kokoro G2P for lang_code={code!r} failed: {exc}. "
                "Install misaki[en,zh,ja] for English/Chinese/Japanese. "
                "English needs spaCy en_core_web_sm "
                "(`python -m spacy download en_core_web_sm`). "
                "Japanese also requires UniDic data (`python -m unidic download`)."
            ) from exc
        self._pipelines[code] = pipe
        return pipe

    def generate(self, text, speed=1.0):
        if self._model is None:
            raise BackendLoadError("Kokoro model is not loaded")
        text = (text or "").strip()
        if not text:
            return np.zeros(0, dtype=np.float32), 0

        t0 = time.time()
        pipe = self._pipeline_for_voice(self._voice)
        voice_path = self._voice_path()
        chunks: list[np.ndarray] = []
        try:
            # Absolute .pt path keeps voice load offline (skips hf_hub_download).
            for _gs, _ps, audio in pipe(text, voice=voice_path, speed=float(speed) or 1.0):
                if audio is None:
                    continue
                arr = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
                chunks.append(np.asarray(arr, dtype=np.float32).reshape(-1))
        except Exception as exc:
            raise BackendLoadError(f"Kokoro synthesis failed: {exc}") from exc

        if not chunks:
            samples = np.zeros(0, dtype=np.float32)
        else:
            samples = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
        return samples, int((time.time() - t0) * 1000)

    def unload(self) -> None:
        self._pipelines = {}
        self._model = None
        self._root = None

    @property
    def is_loaded(self) -> bool:
        return self._model is not None
