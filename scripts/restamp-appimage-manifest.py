#!/usr/bin/env python3
"""Point latest-linux.yml at the AppImage as it exists now.

electron-builder hashes the AppImage, then `appimage-static-runtime.sh` replaces its first
944 KB with a runtime that does not need libfuse2 on the host. The manifest is written before
that swap, so it describes a file that no longer exists. electron-updater verifies the sha512
of what it downloads against this manifest and refuses a mismatch, which would fail every
Linux update on a file that is perfectly good.

Usage: restamp-appimage-manifest.py <manifest> <artifact-name> <size> <sha512-base64>
"""
import re
import sys


def main() -> int:
    if len(sys.argv) != 5:
        print(__doc__, file=sys.stderr)
        return 2
    path, name, size, sha = sys.argv[1:5]
    text = open(path).read()

    # The files[] entry. blockMapSize is dropped along with the .blockmap file the caller
    # removes: it indexes the pre-swap bytes and only drives differential downloads, so its
    # absence makes electron-updater fetch the whole AppImage, which is correct if slower.
    entry = re.compile(
        r"(  - url: " + re.escape(name) + r"\n)"
        r"(?:    sha512: [^\n]*\n)"
        r"(?:    size: [^\n]*\n)"
        r"(?:    blockMapSize: [^\n]*\n)?"
    )
    text, n = entry.subn(r"\1    sha512: " + sha + "\n    size: " + size + "\n", text)
    if n == 0:
        print(f"{path}: no files[] entry for {name}; the manifest format changed", file=sys.stderr)
        return 1

    # The top-level path/sha512 pair, but only when it names this same artifact.
    top = re.compile(r"(^path: " + re.escape(name) + r"\n)sha512: [^\n]*\n", re.M)
    text = top.sub(r"\1sha512: " + sha + "\n", text)

    open(path, "w").write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
