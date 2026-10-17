#!/bin/bash
# Build mao-ocr for macOS and refresh the copies in resources/bin.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p out

build_slice() {
  local target="$1" dest="$2"
  swiftc -O -target "$target" main.swift -o "out/mao-ocr-$dest"
  codesign --force -s - "out/mao-ocr-$dest"
  mkdir -p "../../../resources/bin/$dest"
  cp -f "out/mao-ocr-$dest" "../../../resources/bin/$dest/mao-ocr"
  chmod +x "../../../resources/bin/$dest/mao-ocr"
  echo "  updated resources/bin/$dest/mao-ocr"
}

build_slice arm64-apple-macosx12.0  darwin-arm64
build_slice x86_64-apple-macosx12.0 darwin-x64
echo "MAO-OCR BUILD OK"
