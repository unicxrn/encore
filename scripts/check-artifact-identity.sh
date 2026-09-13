#!/usr/bin/env bash
# Fail the build if an artifact carries the identity of the machine that built it.
#
# Encore publishes as "unicxrn". Nothing about a particular build host belongs in a binary a
# stranger downloads: not the account name from a build path, not a real name, not a personal
# address. That kind of string almost never arrives by configuration -- it arrives by accident,
# a source map embedding /home/<account>/... being the usual way -- so this reads the artifacts
# themselves rather than the settings that were supposed to keep them out.
#
# The patterns are derived rather than hardcoded, so this file names nobody. See
# identity-patterns.sh, which the commit-msg hook reads too.
#
# Matching is case-insensitive and binary-safe, so a hit inside a compiled blob still counts.
set -euo pipefail

dist="${1:-dist}"
# shellcheck source=identity-patterns.sh
source "$(dirname "$0")/identity-patterns.sh"

if [ "${#patterns[@]}" -eq 0 ]; then
  echo "identity check: nothing to look for (no account name, \$ENCORE_FORBIDDEN or .identity-forbidden)"
  exit 0
fi

mapfile -t artifacts < <(find "$dist" -maxdepth 1 -type f \
  \( -name '*.AppImage' -o -name '*.deb' -o -name '*.snap' -o -name '*.exe' -o -name '*.dmg' \) | sort)

if [ "${#artifacts[@]}" -eq 0 ]; then
  echo "no artifacts found in $dist/ -- nothing to check" >&2
  exit 1
fi

fail=0
for f in "${artifacts[@]}"; do
  for pat in "${patterns[@]}"; do
    n="$(grep -aic -- "$pat" "$f" || true)"
    if [ "${n:-0}" -gt 0 ]; then
      echo "FAIL $(basename "$f") contains '$pat' ($n matches)" >&2
      fail=1
    fi
  done
done

if [ "$fail" -ne 0 ]; then
  echo >&2
  echo "An artifact carries an identity string. Find it with:" >&2
  echo "  strings <artifact> | grep -i <pattern>" >&2
  echo "The usual culprit is an absolute build path in a source map." >&2
  exit 1
fi

echo "identity check clean: ${#artifacts[@]} artifacts, none carrying ${patterns[*]}"
