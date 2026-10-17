#!/bin/bash
# Write install notes into the single unpacked folder Vite already built.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/out/mao-chat"
if [[ ! -f "$DEST/manifest.json" ]]; then
  echo "out/mao-chat is missing. Run npm run extension:build first." >&2
  exit 1
fi
VERSION="$(node -p "require('$DEST/manifest.json').version")"
cat > "$DEST/使用说明.txt" <<EOF
mao-chat 浏览器插件  v$VERSION

这是已编译好的扩展，可直接用 Chrome / Edge 加载，也可整夹复制到另一台电脑。

安装：
1. 打开 chrome://extensions/ 或 edge://extensions/
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」
4. 选中本文件夹（mao-chat）

已经装过的，在扩展卡片上点刷新即可。
EOF
echo "Packed $DEST (v$VERSION)"
