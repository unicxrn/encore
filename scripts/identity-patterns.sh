#!/usr/bin/env bash
# The strings that must not reach a published artifact or a commit message, derived rather than
# written down, so this file names nobody and works unchanged for any contributor.
#
# Sourced, not run. Sets `patterns` in the caller's scope:
#
#   - the building account name and the last segment of $HOME
#   - whitespace-separated patterns in $ENCORE_FORBIDDEN
#   - one pattern per line in .identity-forbidden, which is gitignored -- put a real name there
#
# "root" and other service accounts are not identities worth failing over, and a pattern of one
# or two characters would match everything.
declare -a forbidden=()

account="$(id -un 2>/dev/null || true)"
[ -n "$account" ] && forbidden+=("$account")
home_leaf="$(basename "${HOME:-}" 2>/dev/null || true)"
[ -n "$home_leaf" ] && [ "$home_leaf" != "$account" ] && forbidden+=("$home_leaf")

if [ -n "${ENCORE_FORBIDDEN:-}" ]; then
  read -r -a extra <<< "$ENCORE_FORBIDDEN"
  forbidden+=("${extra[@]}")
fi

local_list="$(dirname "${BASH_SOURCE[0]}")/../.identity-forbidden"
if [ -f "$local_list" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    forbidden+=("$line")
  done < "$local_list"
fi

declare -a patterns=()
for p in "${forbidden[@]}"; do
  [ "${#p}" -ge 4 ] || continue
  [ "$p" = "root" ] && continue
  patterns+=("$p")
done
