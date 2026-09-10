#!/usr/bin/env bash
# Regenerates every icon asset from the two SVG sources.
#
# Two sources, not one: below 48px the perspective board and its lane lines
# collapse into noise, so the small sizes drop them and keep only the strike
# bar and the five frets. That is the same trick macOS system icons use, and
# it is why editing one SVG is never enough — change the palette in one and
# you must change it in the other.
#
# Needs rsvg-convert and ImageMagick. Run from the repo root: build/logo/generate.sh
set -euo pipefail
cd "$(dirname "$0")"

for s in 512 256 128 64; do rsvg-convert -w "$s" -h "$s" encore-full.svg -o "icon-$s.png"; done
for s in 48 32 16; do rsvg-convert -w "$s" -h "$s" encore-small.svg -o "icon-$s.png"; done

magick icon-16.png icon-32.png icon-48.png icon-64.png icon-128.png icon-256.png ../icon.ico
magick icon-16.png icon-32.png icon-64.png icon-128.png icon-256.png icon-512.png ../icon.icns
cp icon-512.png ../icon.png
cp icon-512.png ../../resources/icon.png

echo "regenerated: build/icon.{png,ico,icns} and resources/icon.png"
