#!/usr/bin/env python3
"""Build the model-free embedded runtime used by the Apple-Silicon app.

The output layout is understood directly by electron/native-host-manager.js:

  resources/sidecar-runtime/
    python/bin/python3
    app/sokuji_sidecar
    bundle.json

It uses python-build-standalone so the installed .app never depends on a
Homebrew/system Python.  ASR and translation weights are deliberately not
included.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path

PBS_LATEST = "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest"
TRIPLE = "aarch64-apple-darwin"


def _select_asset(assets: list[dict], series: str = "3.12") -> str:
    suffix = f"-{TRIPLE}-install_only.tar.gz"
    candidates = [
        asset for asset in assets
        if asset["name"].startswith(f"cpython-{series}.")
        and asset["name"].endswith(suffix)
    ]
    if not candidates:
        raise SystemExit(f"No python-build-standalone {series} asset for {TRIPLE}")

    version_re = re.escape(series)

    def key(asset: dict) -> tuple[int, int]:
        match = re.search(rf"cpython-{version_re}\.(\d+)\+(\d+)", asset["name"])
        return (int(match.group(1)), int(match.group(2))) if match else (-1, -1)

    return max(candidates, key=key)["browser_download_url"]


def _request(url: str) -> urllib.request.Request:
    request = urllib.request.Request(url, headers={"User-Agent": "mao-chat-runtime-builder"})
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    return request


def build(repo: Path, output: Path) -> None:
    if platform.system() != "Darwin" or platform.machine() not in ("arm64", "aarch64"):
        raise SystemExit("This runtime must be built on Apple Silicon macOS")

    with urllib.request.urlopen(_request(PBS_LATEST), timeout=60) as response:
        release = json.load(response)
    asset_url = _select_asset(release["assets"])

    with tempfile.TemporaryDirectory(prefix="mao-chat-runtime-") as temp_dir:
        temp = Path(temp_dir)
        archive = temp / "python.tar.gz"
        print(f"[runtime] Downloading {asset_url}", flush=True)
        with urllib.request.urlopen(_request(asset_url), timeout=300) as response, archive.open("wb") as dst:
            shutil.copyfileobj(response, dst)

        with tarfile.open(archive) as tar:
            try:
                tar.extractall(temp, filter="data")
            except TypeError:
                tar.extractall(temp)

        python_prefix = temp / "python"
        python = python_prefix / "bin" / "python3"
        requirements = repo / "sidecar" / "requirements-mac-live-captions.txt"
        subprocess.run(
            [str(python), "-m", "pip", "install", "--no-cache-dir", "--no-compile", "-r", str(requirements)],
            check=True,
        )
        # UniDic's wheel only ships the Python package; MeCab needs dicdir/mecabrc
        # for Japanese Kokoro G2P (misaki → fugashi). ~800 MB after extract.
        print("[runtime] Downloading UniDic dictionary (Japanese G2P)", flush=True)
        subprocess.run([str(python), "-m", "unidic", "download"], check=True)
        # misaki English G2P needs spaCy model en_core_web_sm (~13 MB).
        print("[runtime] Installing spaCy en_core_web_sm (English G2P)", flush=True)
        spacy_dl = subprocess.run(
            [str(python), "-m", "spacy", "download", "en_core_web_sm"],
            check=False,
        )
        if spacy_dl.returncode != 0:
            subprocess.run(
                [str(python), "-m", "pip", "install", "--no-cache-dir", "--no-compile", "en-core-web-sm"],
                check=True,
            )

        staged = temp / "sidecar-runtime"
        staged.mkdir()
        shutil.move(str(python_prefix), staged / "python")
        app = staged / "app"
        app.mkdir(parents=True)
        shutil.copytree(
            repo / "sidecar" / "sokuji_sidecar",
            app / "sokuji_sidecar",
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        package = json.loads((repo / "package.json").read_text(encoding="utf-8"))
        (staged / "bundle.json").write_text(
            json.dumps({"sku": "mac", "version": package["sidecarVersion"], "profile": "live-captions"}),
            encoding="utf-8",
        )

        if output.exists():
            shutil.rmtree(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staged), output)

    print(f"[runtime] Ready: {output}", flush=True)


def main() -> None:
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=repo / "resources" / "sidecar-runtime")
    args = parser.parse_args()
    build(repo, args.output.resolve())


if __name__ == "__main__":
    main()
