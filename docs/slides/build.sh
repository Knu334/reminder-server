#!/usr/bin/env bash
set -euo pipefail

SLIDE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SLIDE_DIR/agentic-devcontainer.md"
THEME="$SLIDE_DIR/theme.css"
OUT_DIR="$SLIDE_DIR/dist"
BASENAME="agentic-devcontainer"

# Playwright 同梱の Chromium を解決する（パスにバージョン番号を直書きしない）
CHROME_BIN="$(find "$HOME/.cache/ms-playwright" -type f -name chrome -perm -u+x 2>/dev/null | head -n 1)" || true
if [ -z "$CHROME_BIN" ]; then
  echo "エラー: Playwright の Chromium が見つかりません。" >&2
  echo "  npx playwright install chromium を実行してください。" >&2
  exit 1
fi
echo "==> Chromium: $CHROME_BIN"

mkdir -p "$OUT_DIR"

mkdir -p "$SLIDE_DIR/assets"

# mmdc に既存 Chromium を使わせるための設定を一時ファイルとして生成する
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
printf '{"executablePath":"%s","args":["--no-sandbox"]}' "$CHROME_BIN" > "$TMP_DIR/puppeteer.json"

for mmd in "$SLIDE_DIR"/diagrams/*.mmd; do
  name="$(basename "$mmd" .mmd)"
  echo "==> 図を生成中: $name.svg"
  npx -y @mermaid-js/mermaid-cli@latest \
    --puppeteerConfigFile "$TMP_DIR/puppeteer.json" \
    -i "$mmd" -o "$SLIDE_DIR/assets/$name.svg" \
    -b transparent
done

for EXT in html pdf pptx; do
  echo "==> スライドを変換中 (${EXT^^})"
  CHROME_PATH="$CHROME_BIN" npx -y @marp-team/marp-cli@latest \
    "$SRC" --theme "$THEME" --allow-local-files -o "$OUT_DIR/$BASENAME.$EXT"
done

echo "==> 完了: $OUT_DIR"
ls -1 "$OUT_DIR"
