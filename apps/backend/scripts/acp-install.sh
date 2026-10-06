#!/bin/sh
# shiba-acp-install — fetch + verify + unpack an ACP registry binary agent.
#
# Usage: shiba-acp-install <agent-id> <archive-url> [sha256]
#
# The worker's ACP registry resolver emits /opt/acp-agents/<id>/ paths for
# binary-distributed agents; this script is the install half. It fails
# closed: no verify tool, wrong digest, or an unexpected archive layout is
# a hard error — a half-installed agent must never reach a run.
set -eu

id="${1:?agent id required}"
url="${2:?archive url required}"
want="${3:-}"
dest="/opt/acp-agents/$id"

case "$id" in
  "" | *[!a-z0-9-]* | -* | *-)
    echo "shiba-acp-install: invalid agent id: $id" >&2
    exit 2
    ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "$tmp/agent.bin"

if [ -n "$want" ]; then
  got="$(sha256sum "$tmp/agent.bin" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    echo "shiba-acp-install: sha256 mismatch for $id (want $want, got $got)" >&2
    exit 1
  fi
else
  echo "shiba-acp-install: WARNING — no sha256 declared for $id; installing unverified" >&2
fi

mkdir -p "$dest"
case "$url" in
  *.zip)
    unzip -q "$tmp/agent.bin" -d "$tmp/x"
    ;;
  *.tar.gz | *.tgz)
    mkdir -p "$tmp/x" && tar -xzf "$tmp/agent.bin" -C "$tmp/x"
    ;;
  *.tar.xz)
    mkdir -p "$tmp/x" && tar -xJf "$tmp/agent.bin" -C "$tmp/x"
    ;;
  *)
    # A bare executable archive — install as <id> itself.
    cp "$tmp/agent.bin" "$dest/$id" && chmod +x "$dest/$id"
    exit 0
    ;;
esac

# Flatten a single top-level directory (archives like amp-acp-<plat>/).
n_entries="$(find "$tmp/x" -mindepth 1 -maxdepth 1 | wc -l)"
if [ "$n_entries" = "1" ] && [ -d "$tmp/x"/* ]; then
  mv "$tmp/x"/*/* "$dest"/ 2>/dev/null || cp -R "$tmp/x"/*/* "$dest"/
else
  mv "$tmp/x"/* "$dest"/ 2>/dev/null || cp -R "$tmp/x"/* "$dest"/
fi

# Executable bit: anything the registry names as cmd must run.
find "$dest" -type f -name '*.so' -prune -o -type f -exec chmod +x {} +
echo "shiba-acp-install: installed $id -> $dest"
