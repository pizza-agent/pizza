#!/usr/bin/env bash
# Build libagent_desktop_ffi from the agent-desktop source and stage it in
# dist/ so the desktop bundle carries it into Contents/Resources. The worker
# (pizza --mode desktop-worker) dlopens it for in-process `_desktop` commands.
#
# Usage:
#   AGENT_DESKTOP_SRC=/path/to/agent-desktop bash scripts/build-desktop-ffi.sh
#   bash scripts/build-desktop-ffi.sh   # clones the pinned version to .agent-desktop-src
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${AGENT_DESKTOP_SRC:-$ROOT/.agent-desktop-src}"
VERSION="$(node -e 'console.log(require("'"$ROOT"'/package.json).optionalDependencies["agent-desktop"].replace(/[^0-9.]/g,""))')"

if [ ! -d "$SRC/crates/ffi" ]; then
	echo "cloning agent-desktop v$VERSION into $SRC"
	git clone --depth 1 --branch "v$VERSION" https://github.com/vercel-labs/agent-desktop "$SRC" || \
	git clone --depth 1 https://github.com/vercel-labs/agent-desktop "$SRC"
fi

case "$(uname -s)" in
	Darwin) LIB=libagent_desktop_ffi.dylib ;;
	Linux)  LIB=libagent_desktop_ffi.so ;;
	*)      LIB=agent_desktop_ffi.dll ;;
esac

(cd "$SRC" && cargo build --profile release-ffi -p agent-desktop-ffi)
mkdir -p "$ROOT/dist"
cp "$SRC/target/release-ffi/$LIB" "$ROOT/dist/$LIB"
echo "staged dist/$LIB — the desktop bundle signs it with the app via codesign --deep"
