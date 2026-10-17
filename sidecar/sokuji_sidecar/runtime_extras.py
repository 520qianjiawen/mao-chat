"""On-demand install of large optional runtime extras (Japanese G2P data, etc.).

Model weights already download on demand; these helpers cover *library data*
that is too large to ship in the macOS pkg (UniDic MeCab dict ~800 MB,
pyopenjtalk-plus + Sudachi ~300 MB).

The bundled app ``site-packages`` is often read-only after install, so extras
land under a user-writable root:

  1. ``$SOKUJI_EXTRAS_DIR`` if set (Electron sets this under userData)
  2. sibling of ``$HF_HOME`` → ``…/sidecar-extras``
  3. ``~/.cache/mao-chat-extras``
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import types
import zipfile
from pathlib import Path


def extras_root() -> Path:
    env = os.environ.get("SOKUJI_EXTRAS_DIR")
    if env:
        return Path(env).expanduser().resolve()
    hf = os.environ.get("HF_HOME")
    if hf:
        return Path(hf).expanduser().resolve().parent / "sidecar-extras"
    return Path.home() / ".cache" / "mao-chat-extras"


def ensure_extras_on_path() -> Path:
    root = extras_root()
    root.mkdir(parents=True, exist_ok=True)
    s = str(root)
    if s not in sys.path:
        sys.path.insert(0, s)
    return root


def _pip_install_target(*packages: str) -> None:
    root = ensure_extras_on_path()
    cmd = [
        sys.executable, "-m", "pip", "install",
        "--no-cache-dir", "--upgrade",
        "--target", str(root),
        *packages,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(
            f"pip install {' '.join(packages)} failed (rc={proc.returncode}): "
            f"{(proc.stderr or proc.stdout or '').strip()[-800:]}"
        )


def ensure_pyopenjtalk() -> None:
    """Import pyopenjtalk, installing pyopenjtalk-plus into extras on first use.

    Used by GPT-SoVITS / CosyVoice Japanese text front-ends. English/Chinese
    paths never call this, so the ~300 MB Sudachi+openjtalk stack stays off
    disk until a Japanese synthesis actually needs it.
    """
    ensure_extras_on_path()
    try:
        import pyopenjtalk  # noqa: F401
        return
    except Exception:
        pass
    _pip_install_target("pyopenjtalk-plus==0.4.1.post8")
    # Drop cached failed imports, then require the module.
    for name in list(sys.modules):
        if name == "pyopenjtalk" or name.startswith("pyopenjtalk.") or name.startswith("sudachi"):
            sys.modules.pop(name, None)
    try:
        import pyopenjtalk  # noqa: F401
    except Exception as exc:
        raise RuntimeError(
            "Japanese TTS needs pyopenjtalk-plus (~300 MB, Sudachi dictionary). "
            f"Automatic install failed: {exc}. Check network and retry."
        ) from exc


def _patch_unidic_dicdir(dicdir: Path) -> None:
    """Point the ``unidic`` package (and fugashi/misaki consumers) at ``dicdir``."""
    import unidic
    path = str(dicdir)
    unidic.DICDIR = path
    try:
        import unidic.unidic as umod
        umod.DICDIR = path
    except Exception:
        pass


def ensure_unidic_dictionary() -> None:
    """Ensure UniDic MeCab data is available for Japanese Kokoro G2P.

    Prefers a user-writable extras copy (~800 MB). Falls back to a bundled
    dicdir when present (dev trees). Downloads into extras on first Japanese
    Kokoro use — never written into the read-only app bundle.
    """
    try:
        import unidic
    except Exception as exc:
        raise RuntimeError(
            f"Japanese Kokoro requires the unidic package (import failed: {exc})"
        ) from exc

    user_dic = extras_root() / "unidic-dicdir"
    if (user_dic / "mecabrc").is_file():
        _patch_unidic_dicdir(user_dic)
        return

    bundled = Path(unidic.DICDIR)
    if (bundled / "mecabrc").is_file():
        return

    # Download into extras (same source as `python -m unidic download`).
    try:
        from unidic.download import DICT_INFO, download_progress, get_json
    except Exception as exc:
        raise RuntimeError(
            "Japanese Kokoro is missing UniDic dictionary data and cannot "
            f"download it (import failed: {exc}). Check network and retry."
        ) from exc

    try:
        info = get_json(DICT_INFO, "dictionary info")["latest"]
        version, url = info["version"], info["url"]
        work = extras_root() / "unidic-download-tmp"
        if work.exists():
            shutil.rmtree(work)
        work.mkdir(parents=True, exist_ok=True)
        zip_path = work / "unidic.zip"
        print(f"[runtime-extras] Downloading UniDic v{version} (~800 MB)…", file=sys.stderr)
        download_progress(url, str(zip_path))
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(work)
        zip_path.unlink(missing_ok=True)
        # Upstream zip extracts to a versioned folder named "unidic".
        extracted = work / "unidic"
        if not extracted.is_dir():
            # Some archives use a different top-level name — pick the sole dir.
            dirs = [p for p in work.iterdir() if p.is_dir()]
            if len(dirs) != 1:
                raise RuntimeError(f"unexpected UniDic archive layout under {work}")
            extracted = dirs[0]
        if user_dic.exists():
            shutil.rmtree(user_dic)
        shutil.move(str(extracted), str(user_dic))
        # Dummy mecabrc (same as upstream unidic.download)
        (user_dic / "mecabrc").write_text("# This is a dummy file.\n", encoding="utf-8")
        (user_dic / "version").write_text(f"unidic-{version}\n", encoding="utf-8")
        shutil.rmtree(work, ignore_errors=True)
    except Exception as exc:
        raise RuntimeError(
            "Japanese Kokoro needs UniDic dictionary data (~800 MB download). "
            f"Automatic download failed: {exc}. Check network, then retry."
        ) from exc

    if not (user_dic / "mecabrc").is_file():
        raise RuntimeError(f"UniDic download finished but {user_dic / 'mecabrc'} is missing")
    _patch_unidic_dicdir(user_dic)
    print(f"[runtime-extras] UniDic ready at {user_dic}", file=sys.stderr)


# Official OpenAI Whisper language map (whisper/tokenizer.py). Copied so
# hojo_asr.wenet.utils.common.WHISPER_LANGS.index(lang) stays valid if
# add_whisper_tokens is ever hit. Hojo ASR itself uses
# transformers.WhisperFeatureExtractor — not the openai-whisper package.
_WHISPER_LANGUAGES = {
    "en": "english",
    "zh": "chinese",
    "de": "german",
    "es": "spanish",
    "ru": "russian",
    "ko": "korean",
    "fr": "french",
    "ja": "japanese",
    "pt": "portuguese",
    "tr": "turkish",
    "pl": "polish",
    "ca": "catalan",
    "nl": "dutch",
    "ar": "arabic",
    "sv": "swedish",
    "it": "italian",
    "id": "indonesian",
    "hi": "hindi",
    "fi": "finnish",
    "vi": "vietnamese",
    "he": "hebrew",
    "uk": "ukrainian",
    "el": "greek",
    "ms": "malay",
    "cs": "czech",
    "ro": "romanian",
    "da": "danish",
    "hu": "hungarian",
    "ta": "tamil",
    "no": "norwegian",
    "th": "thai",
    "ur": "urdu",
    "hr": "croatian",
    "bg": "bulgarian",
    "lt": "lithuanian",
    "la": "latin",
    "mi": "maori",
    "ml": "malayalam",
    "cy": "welsh",
    "sk": "slovak",
    "te": "telugu",
    "fa": "persian",
    "lv": "latvian",
    "bn": "bengali",
    "sr": "serbian",
    "az": "azerbaijani",
    "sl": "slovenian",
    "kn": "kannada",
    "et": "estonian",
    "mk": "macedonian",
    "br": "breton",
    "eu": "basque",
    "is": "icelandic",
    "hy": "armenian",
    "ne": "nepali",
    "mn": "mongolian",
    "bs": "bosnian",
    "kk": "kazakh",
    "sq": "albanian",
    "sw": "swahili",
    "gl": "galician",
    "mr": "marathi",
    "pa": "punjabi",
    "si": "sinhala",
    "km": "khmer",
    "sn": "shona",
    "yo": "yoruba",
    "so": "somali",
    "af": "afrikaans",
    "oc": "occitan",
    "ka": "georgian",
    "be": "belarusian",
    "tg": "tajik",
    "sd": "sindhi",
    "gu": "gujarati",
    "am": "amharic",
    "yi": "yiddish",
    "lo": "lao",
    "uz": "uzbek",
    "fo": "faroese",
    "ht": "haitian creole",
    "ps": "pashto",
    "tk": "turkmen",
    "nn": "nynorsk",
    "mt": "maltese",
    "sa": "sanskrit",
    "lb": "luxembourgish",
    "my": "myanmar",
    "bo": "tibetan",
    "tl": "tagalog",
    "mg": "malagasy",
    "as": "assamese",
    "tt": "tatar",
    "haw": "hawaiian",
    "ln": "lingala",
    "ha": "hausa",
    "ba": "bashkir",
    "jw": "javanese",
    "su": "sundanese",
    "yue": "cantonese",
}


def _ensure_whisper_stub() -> None:
    """Satisfy hojo_asr's leftover `from whisper.tokenizer import LANGUAGES`.

    ConformerEncoder → encoder.py → mask_to_bias pulls common.py, which binds
    WHISPER_LANGS at import time. That is the only openai-whisper import.
    Inject a tiny sys.modules stub when a real `whisper` package is missing
    so we never require (or pip-install) openai-whisper.
    """
    try:
        import whisper  # noqa: F401
        return
    except Exception:
        pass
    whisper_mod = types.ModuleType("whisper")
    tokenizer_mod = types.ModuleType("whisper.tokenizer")
    tokenizer_mod.LANGUAGES = dict(_WHISPER_LANGUAGES)
    whisper_mod.tokenizer = tokenizer_mod
    whisper_mod.__path__ = []  # mark as package for submodule imports
    sys.modules["whisper"] = whisper_mod
    sys.modules["whisper.tokenizer"] = tokenizer_mod

