#!/usr/bin/env bash
# Fail the build if an artifact carries the identity of the machine that built it.
#
# Encore publishes as "unicxrn". Nothing about a particular build host belongs in a binary a
# stranger downloads: not the account name from a build path, not a real name, not a personal
# address. That kind of string almost never arrives by configuration -- it arrives by accident,
# a source map embedding /home/<account>/... being the usual way -- so this reads the artifacts
# themselves rather than the settings that were supposed to keep them out.
#
# The patterns are derived, not hardcoded, so this file names nobody and works unchanged for any
# contributor:
#
#   - the building account name and the last segment of $HOME
#   - whitespace-separated patterns in $ENCORE_FORBIDDEN
#   - one pattern per line in .identity-forbidden, which is gitignored -- put a real name there
#
# Matching is case-insensitive and binary-safe, so a hit inside a compiled blob still counts.
set -euo pipefail

dist="${1:-dist}"
declare -a forbidden=()

account="$(id -un 2>/dev/null || true)"
[ -n "$account" ] && forbidden+=("$account")
home_leaf="$(basename "${HOME:-}" 2>/dev/null || true)"
[ -n "$home_leaf" ] && [ "$home_leaf" != "$account" ] && forbidden+=("$home_leaf")

if [ -n "${ENCORE_FORBIDDEN:-}" ]; then
  read -r -a extra <<< "$ENCORE_FORBIDDEN"
  forbidden+=("${extra[@]}")
fi

local_list="$(dirname "$0")/../.identity-forbidden"
if [ -f "$local_list" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    forbidden+=("$line")
  done < "$local_list"
fi

# "root" and other service accounts are not identities worth failing a CI build over, and a
# one-or-two character pattern would match everything.
declare -a patterns=()
for p in "${forbidden[@]}"; do
  [ "${#p}" -ge 4 ] || continue
  [ "$p" = "root" ] && continue
  patterns+=("$p")
done

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
