"""Shared sherpa-onnx TTS configuration for the full and lean runtimes.

The macOS app already ships sherpa-onnx for ASR, so Kokoro can use the same
runtime without bundling PyTorch, FastAPI, or the model itself.  Model assets
remain in the Hugging Face cache and are downloaded by ``native_models``.
"""
from __future__ import annotations

import os
from pathlib import Path


# Official sid -> speaker-name map for kokoro-multi-lang-v1_0 (53 speakers).
# Source: k2-fsa sherpa-onnx model documentation.  Keeping it here gives the
# renderer a useful named dropdown while the backend still sends the integer
# speaker id expected by OfflineTts.
KOKORO_VOICE_NAMES = (
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica",
    "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa", "bf_alice", "bf_emma", "bf_isabella",
    "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis", "ef_dora",
    "em_alex", "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
    "if_sara", "im_nicola", "jf_alpha", "jf_gongitsune", "jf_nezumi",
    "jf_tebukuro", "jm_kumo", "pf_dora", "pm_alex", "pm_santa", "zf_xiaobei",
    "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi",
    "zm_yunxia", "zm_yunyang",
)
KOKORO_VOICE_TO_SID = {name: sid for sid, name in enumerate(KOKORO_VOICE_NAMES)}


def kokoro_voice_descriptors() -> list[dict]:
    """Return renderer voice rows with per-language defaults and gender."""
    out = []
    for sid, name in enumerate(KOKORO_VOICE_NAMES):
        language = {
            "a": "en", "b": "en", "e": "es", "f": "fr", "h": "hi",
            "i": "it", "j": "ja", "p": "pt", "z": "zh",
        }.get(name[0])
        gender = "F" if name[1] == "f" else "M"
        default = name in (
            "af_heart", "ef_dora", "ff_siwis", "hf_alpha",
            "if_sara", "jf_alpha", "pf_dora", "zf_xiaoxiao",
        )
        # Keep the two defaults plus one alternate per language at the front;
        # the remaining voices stay available in the same dropdown.
        curated = default or name in ("af_bella", "zf_xiaoyi")
        out.append({
            "name": name,
            "language": language,
            "gender": gender,
            "curated": curated,
            "unstable": False,
            "default": default,
            "sid": sid,
        })
    return out


def _first_onnx(root: Path) -> Path:
    """Prefer full-precision Kokoro (official quality), then int8 if present."""
    for name in ("model.onnx", "model.int8.onnx"):
        path = root / name
        if path.exists():
            return path
    fallback = next(
        (path for path in root.iterdir()
         if path.name.endswith(".onnx") and not path.name.endswith(".onnx.json")),
        None,
    )
    if fallback is not None:
        return fallback
    raise FileNotFoundError(
        "TTS model download is incomplete: model.onnx/model.int8.onnx is missing; "
        "download the model again in Settings"
    )


def build_offline_tts_config(sherpa_onnx, root: str, device: str):
    """Build a sherpa OfflineTtsConfig for Kokoro or legacy VITS/Piper."""
    directory = Path(root)
    onnx = _first_onnx(directory)
    provider = "cuda" if device == "cuda" else "cpu"
    data_dir = directory / "espeak-ng-data"
    threads = int(os.environ.get("SOKUJI_TTS_THREADS", "4"))

    if (directory / "voices.bin").exists():
        # US + GB English lexicons match official multi-lang packaging (Heart/US
        # and British voices); Chinese lexicon for zh voices. Order matches
        # sherpa-onnx kokoro multi-lang examples.
        lexicons = [
            directory / "lexicon-us-en.txt",
            directory / "lexicon-gb-en.txt",
            directory / "lexicon-zh.txt",
        ]
        kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=str(onnx),
            voices=str(directory / "voices.bin"),
            tokens=str(directory / "tokens.txt"),
            lexicon=",".join(str(path) for path in lexicons if path.exists()),
            data_dir=str(data_dir) if data_dir.is_dir() else "",
            dict_dir=str(directory / "dict") if (directory / "dict").is_dir() else "",
        )
        model = sherpa_onnx.OfflineTtsModelConfig(
            kokoro=kokoro, num_threads=threads, provider=provider)
        rule_fsts = ",".join(
            str(directory / name)
            for name in ("date-zh.fst", "phone-zh.fst", "number-zh.fst")
            if (directory / name).exists()
        )
        return sherpa_onnx.OfflineTtsConfig(
            model=model, rule_fsts=rule_fsts, max_num_sentences=1)

    # A partial Kokoro snapshot may have its graph but not voices.bin or
    # tokens.txt.  Do not silently interpret that graph as a VITS/Piper model;
    # surface a repairable download error instead.  Markers: int8 graph name
    # (unique to Kokoro packs) or the multi-lang lexicons that ship with it.
    looks_like_kokoro = (
        onnx.name.startswith("model.int8")
        or (directory / "lexicon-us-en.txt").is_file()
        or (directory / "lexicon-gb-en.txt").is_file()
        or (directory / "lexicon-zh.txt").is_file()
    )
    if looks_like_kokoro:
        missing = [name for name in ("voices.bin", "tokens.txt")
                   if not (directory / name).is_file()]
        if missing:
            raise FileNotFoundError(
                "TTS model download is incomplete: missing " + ", ".join(missing)
                + "; download the model again in Settings"
            )

    vits = sherpa_onnx.OfflineTtsVitsModelConfig(
        model=str(onnx),
        tokens=str(directory / "tokens.txt"),
        data_dir=str(data_dir) if data_dir.is_dir() else "",
    )
    if not data_dir.is_dir() and (directory / "lexicon.txt").exists():
        vits.lexicon = str(directory / "lexicon.txt")
        if (directory / "dict").is_dir():
            vits.dict_dir = str(directory / "dict")
    return sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=vits, num_threads=threads, provider=provider),
        max_num_sentences=1,
    )
