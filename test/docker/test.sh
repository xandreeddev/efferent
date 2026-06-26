#!/usr/bin/env bash
# Build + pack + dockerized e2e of the efferent CLI tarball.
#
#   test/docker/test.sh            # install/boot + no-key checks (no LLM call)
#   test/docker/test.sh --keyed    # also a real turn via ~/.efferent/auth.json (mounted RO)
#
# The provider key is mounted read-only at run time — never copied into the image.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$REPO/test/docker"
KEYED=0; [ "${1:-}" = "--keyed" ] && KEYED=1

echo "==> build the bundle"
( cd "$REPO" && bun run build )

echo "==> pack the tarball"
TARBALL="$( cd "$REPO/packages/cli" && npm pack --silent )"
cp "$REPO/packages/cli/$TARBALL" "$HERE/$TARBALL"
trap 'rm -f "$HERE/$TARBALL"' EXIT
echo "    $TARBALL"

echo "==> docker build (efferent-e2e)"
docker build --build-arg "TARBALL=$TARBALL" -t efferent-e2e "$HERE"

echo "==> docker run"
if [ "$KEYED" -eq 1 ]; then
  [ -f "$HOME/.efferent/auth.json" ] || { echo "no ~/.efferent/auth.json to mount"; exit 1; }
  # Optional model override (the in-image default is google:gemini-3.5-flash).
  MODELENV=(); [ -n "${EFFERENT_MODEL:-}" ] && MODELENV=(-e "EFFERENT_MODEL=$EFFERENT_MODEL")
  docker run --rm "${MODELENV[@]}" \
    -v "$HOME/.efferent/auth.json:/root/.efferent/auth.json:ro" efferent-e2e
else
  docker run --rm efferent-e2e
fi
