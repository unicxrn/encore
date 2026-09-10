#!/usr/bin/env bash
# Replace an AppImage's runtime with one that needs nothing installed on the host.
#
# electron-builder 26 still ships the 2019 AppImageKit runtime, which links libfuse.so.2.
# Debian dropped libfuse2 from a default install in bookworm, Ubuntu in 22.04, and Fedora
# around 34, so on any current distro that runtime dies with:
#
#   fusermount: mount failed: Operation not permitted
#   Cannot mount AppImage, please check your FUSE setup.
#
# and the user is told to check a FUSE setup that is not the problem. The type2-runtime
# build links libfuse3 statically, so it mounts with no host package at all.
#
# An AppImage is just [runtime][squashfs]. The runtime knows its own length and reports it
# as --appimage-offset, so swapping it is a concatenation: keep the payload, put a different
# front on it. Nothing inside the squashfs changes, which is why the extracted tree from
# before and after this script is byte-identical.
set -euo pipefail

RUNTIME_URL='https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64'
# Pinned, and checked on every run. The URL is a rolling "continuous" release, so without a
# pin this script would silently change what it ships whenever upstream rebuilt. A mismatch
# is a stop, not a warning: see the ffmpeg sidecar for the same reasoning.
RUNTIME_SHA256='1cc49bcf1e2ccd593c379adb17c9f85a36d619088296504de95b1d06215aebbf'
CACHE="${APPIMAGE_RUNTIME_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/encore-appimage-runtime}"

target="${1:?usage: $0 <path-to.AppImage>}"
[ -f "$target" ] || { echo "no such AppImage: $target" >&2; exit 1; }

mkdir -p "$(dirname "$CACHE")"
if [ ! -f "$CACHE" ] || [ "$(sha256sum "$CACHE" | cut -d' ' -f1)" != "$RUNTIME_SHA256" ]; then
  echo "fetching the static AppImage runtime"
  curl -sSL -o "$CACHE.part" "$RUNTIME_URL"
  got="$(sha256sum "$CACHE.part" | cut -d' ' -f1)"
  if [ "$got" != "$RUNTIME_SHA256" ]; then
    rm -f "$CACHE.part"
    echo "runtime sha256 mismatch: expected $RUNTIME_SHA256, got $got" >&2
    echo "upstream rebuilt the continuous release. Check the new binary, then update RUNTIME_SHA256." >&2
    exit 1
  fi
  mv "$CACHE.part" "$CACHE"
fi

offset="$("$target" --appimage-offset)"
[ "$offset" -gt 0 ] 2>/dev/null || { echo "could not read the payload offset from $target" >&2; exit 1; }

tmp="$target.swap"
cat "$CACHE" > "$tmp"
dd if="$target" bs=1M iflag=skip_bytes,count_bytes skip="$offset" >> "$tmp" 2>/dev/null
chmod +x "$tmp"
mv "$tmp" "$target"
echo "swapped in the static runtime: $target"

# electron-builder hashed the AppImage before this script replaced its first 944 KB, so
# latest-linux.yml now describes a file that no longer exists. electron-updater verifies the
# sha512 of what it downloads against that manifest and refuses a mismatch, so leaving it stale
# means every Linux update fails a checksum on a file that is perfectly good.
#
# The stale .blockmap goes with it. It indexes the old bytes and only drives differential
# downloads; dropping the file and its blockMapSize makes electron-updater fetch the whole
# AppImage, which is correct if slower. Regenerating it would mean reimplementing
# app-builder's block map, and a wrong one is worse than none.
manifest="$(dirname "$target")/latest-linux.yml"
if [ -f "$manifest" ]; then
  rm -f "$target.blockmap"
  "$(dirname "$0")/restamp-appimage-manifest.py" \
    "$manifest" \
    "$(basename "$target")" \
    "$(stat -c%s "$target")" \
    "$(openssl dgst -sha512 -binary "$target" | openssl base64 -A)"
  echo "restamped $(basename "$manifest") for the swapped runtime"
fi
