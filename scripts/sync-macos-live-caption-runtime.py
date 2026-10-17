#!/usr/bin/env python3
"""Keep the embedded macOS Native runtime in sync before packaging.

The runtime contains Python and inference libraries, but never model weights.
Rebuilding it from python-build-standalone for every DMG is unnecessarily slow,
so this script only installs dependencies when the requirements changed (or an
expected module is missing) and only copies the sidecar app when its files
changed.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "resources" / "sidecar-runtime"
PYTHON = RUNTIME / "python" / "bin" / "python3"
SOURCE = ROOT / "sidecar" / "sokuji_sidecar"
STAGED_SOURCE = RUNTIME / "app" / "sokuji_sidecar"
REQUIREMENTS = ROOT / "sidecar" / "requirements-mac-live-captions.txt"
BUNDLE = RUNTIME / "bundle.json"
EXPECTED_IMPORTS = (
    "numpy",
    "websockets",
    "huggingface_hub",
    "psutil",
    "zstandard",
    "sherpa_onnx",
    "onnxruntime",
    "sentencepiece",
    "transcribe_cpp",
    # Opus-MT (pair translators)
    "ctranslate2",
    # Full TTS roster I/O + Mac Metal lane
    "soundfile",
    "soxr",
    "mlx_audio",
    # Official hexgrad Kokoro (en/zh; ja dictionary downloads on demand)
    "torch",
    "kokoro",
    "misaki",
    "unidic",  # package only — MeCab dict is NOT pre-downloaded
    "fugashi",
    "spacy",
    "en_core_web_sm",  # spaCy English model used by misaki EN G2P
    # GPT-SoVITS G2P (zh/en). Japanese openjtalk is runtime-installed.
    "jieba",
    "pypinyin",
    "g2pM",
    "nltk",
)


def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree_digest(path: Path) -> str:
    digest = hashlib.sha256()
    for item in sorted(p for p in path.rglob("*") if p.is_file()):
        if "__pycache__" in item.parts or item.suffix == ".pyc":
            continue
        digest.update(item.relative_to(path).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(item.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def read_bundle() -> dict:
    try:
        return json.loads(BUNDLE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def imports_ready() -> bool:
    probe = ";".join(f"import {module}" for module in EXPECTED_IMPORTS)
    return subprocess.run(
        [str(PYTHON), "-c", probe],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


def prune_japanese_bundled_bloat() -> None:
    """Drop large Japanese G2P assets that now download on first use.

    - UniDic MeCab dictionary (~800 MB) under site-packages/unidic/dicdir
    - pyopenjtalk-plus + Sudachi (~300 MB) if still installed from older builds
    """
    site = RUNTIME / "python" / "lib" / "python3.12" / "site-packages"
    if not site.is_dir():
        # python-build-standalone may use a different lib layout on some hosts
        candidates = list((RUNTIME / "python" / "lib").glob("python*/site-packages"))
        site = candidates[0] if candidates else site
    dicdir = site / "unidic" / "dicdir"
    if dicdir.is_dir():
        print(f"[runtime] Pruning bundled UniDic dictionary at {dicdir}", flush=True)
        shutil.rmtree(dicdir, ignore_errors=True)
    # Uninstall packages no longer in requirements (idempotent).
    for pkg in ("pyopenjtalk-plus", "pyopenjtalk", "sudachidict-core", "sudachipy"):
        subprocess.run(
            [str(PYTHON), "-m", "pip", "uninstall", "-y", pkg],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    # pip uninstall sometimes leaves empty package dirs; remove leftovers.
    for pattern in ("pyopenjtalk*", "sudachipy*", "sudachidict*"):
        for path in site.glob(pattern):
            if path.is_dir():
                print(f"[runtime] Removing leftover {path.name}", flush=True)
                shutil.rmtree(path, ignore_errors=True)



def spacy_en_ready() -> bool:
    """misaki English G2P needs the spaCy en_core_web_sm model package."""
    return subprocess.run(
        [str(PYTHON), "-c", "import en_core_web_sm"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


def ensure_spacy_en_model() -> None:
    """Install spaCy's small English model used by Kokoro/misaki EN G2P."""
    if spacy_en_ready():
        return
    print("[runtime] Installing spaCy en_core_web_sm for English Kokoro G2P", flush=True)
    # Prefer the official spaCy downloader (pins a compatible wheel for this spacy).
    result = subprocess.run(
        [str(PYTHON), "-m", "spacy", "download", "en_core_web_sm"],
        check=False,
    )
    if result.returncode != 0 or not spacy_en_ready():
        # Fallback: direct pip install of the model package name.
        subprocess.run(
            [str(PYTHON), "-m", "pip", "install", "--no-cache-dir", "--no-compile", "en-core-web-sm"],
            check=True,
        )
    if not spacy_en_ready():
        raise SystemExit("Failed to install spaCy model en_core_web_sm")


def sync_source() -> None:
    staging = STAGED_SOURCE.with_name(".sokuji_sidecar.syncing")
    if staging.exists():
        shutil.rmtree(staging)
    shutil.copytree(
        SOURCE,
        staging,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    if STAGED_SOURCE.exists():
        shutil.rmtree(STAGED_SOURCE)
    staging.replace(STAGED_SOURCE)


def main() -> None:
    built = False
    if not PYTHON.exists():
        subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "build-macos-live-caption-runtime.py")],
            check=True,
        )
        built = True

    bundle = read_bundle()
    requirements_hash = file_digest(REQUIREMENTS)
    source_hash = tree_digest(SOURCE)

    if not built and (
        bundle.get("requirementsHash") != requirements_hash or not imports_ready()
    ):
        print("[runtime] Updating embedded Native dependencies", flush=True)
        subprocess.run(
            [
                str(PYTHON), "-m", "pip", "install",
                "--no-cache-dir", "--no-compile", "-r", str(REQUIREMENTS),
            ],
            check=True,
        )

    # Japanese G2P data is runtime-downloaded (see runtime_extras) — never
    # pre-seed UniDic dicdir / pyopenjtalk into the install package.
    prune_japanese_bundled_bloat()
    # misaki[en] depends on spaCy but does not ship en_core_web_sm.
    ensure_spacy_en_model()

    if built or bundle.get("sourceHash") != source_hash or not STAGED_SOURCE.exists():
        print("[runtime] Synchronizing Native sidecar source", flush=True)
        sync_source()

    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    BUNDLE.write_text(
        json.dumps(
            {
                "sku": "mac",
                "version": package["sidecarVersion"],
                "profile": "live-captions",
                "requirementsHash": requirements_hash,
                "sourceHash": source_hash,
                # UniDic MeCab dict is downloaded on first Japanese Kokoro use.
                "unidicDict": False,
            },
            indent=2,
        ) + "\n",
        encoding="utf-8",
    )
    print("[runtime] Embedded Native runtime is current", flush=True)


if __name__ == "__main__":
    main()
