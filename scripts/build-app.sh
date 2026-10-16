#!/bin/bash
# Builds NotesVim.app into ./build. Pass --install to copy it to /Applications and launch it.
set -euo pipefail
cd "$(dirname "$0")/.."

swift build -c release
BIN="$(swift build -c release --show-bin-path)/NotesVim"

APP="build/NotesVim.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/NotesVim"
cp Resources/vim.js Resources/notes-adapter.js "$APP/Contents/Resources/"
cp Info.plist "$APP/Contents/Info.plist"

# Sign with your Apple Development certificate if you have one (Xcode creates
# it when you pick your Apple ID as a signing team). macOS then remembers the
# Accessibility permission across rebuilds. Otherwise sign ad-hoc, and you'll
# need to re-allow Accessibility after every rebuild.
IDENTITY="${NOTESVIM_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development/ {print $2; exit}')"
fi
if [ -z "$IDENTITY" ]; then
  IDENTITY="-"
  echo "No Apple Development certificate found: signing ad-hoc."
fi
codesign --force --sign "$IDENTITY" "$APP"
echo "Built $APP (signed with: $IDENTITY)"

if [ "${1:-}" = "--install" ]; then
  pkill -x NotesVim 2>/dev/null || true
  rm -rf /Applications/NotesVim.app
  cp -R "$APP" /Applications/
  open /Applications/NotesVim.app
  echo "Installed to /Applications and launched."
fi
