#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_IMAGE="$PROJECT_ROOT/src/renderer/assets/app-icon-source.jpeg"
PNG_TARGET="$PROJECT_ROOT/assets/app-icon.png"
ICNS_TARGET="$PROJECT_ROOT/assets/app-icon.icns"
ELECTRON_BIN="$PROJECT_ROOT/node_modules/.bin/electron"
ICONSET_DIR="$(mktemp -d)/app-icon.iconset"

cleanup() {
    rm -rf "$(dirname "$ICONSET_DIR")"
}
trap cleanup EXIT

mkdir -p "$PROJECT_ROOT/assets" "$ICONSET_DIR"

"$ELECTRON_BIN" "$PROJECT_ROOT/scripts/render-app-icon.js" "$SOURCE_IMAGE" "$PNG_TARGET"

make_icon() {
    local size="$1"
    local filename="$2"
    sips --resampleHeightWidth "$size" "$size" "$PNG_TARGET" --out "$ICONSET_DIR/$filename" >/dev/null
}

make_icon 16 icon_16x16.png
make_icon 32 icon_16x16@2x.png
make_icon 32 icon_32x32.png
make_icon 64 icon_32x32@2x.png
make_icon 128 icon_128x128.png
make_icon 256 icon_128x128@2x.png
make_icon 256 icon_256x256.png
make_icon 512 icon_256x256@2x.png
make_icon 512 icon_512x512.png
make_icon 1024 icon_512x512@2x.png

iconutil -c icns "$ICONSET_DIR" -o "$ICNS_TARGET"

echo "Built $PNG_TARGET"
echo "Built $ICNS_TARGET"
