#!/bin/bash
# Imports an agent's old free-form notes (/data/memory/*.md inside its container) into its MEMORY.md on the host, where the
# memory block and `recall` can see them. Read-only on the container; idempotent (skips agents already imported).
# Usage: scripts/import-agent-memory.sh <agent>... | --all
set -u
DIR="${ORCIE_MEMORY_DIR:-$HOME/.orcie/memory}"
names=("$@")
if [ "${names[0]:-}" = "--all" ] || [ ${#names[@]} -eq 0 ]; then names=($(docker ps --format '{{.Names}}' | sed -n 's/^orcie-//p')); fi
for a in "${names[@]}"; do
  c="orcie-$a"; docker inspect "$c" >/dev/null 2>&1 || { echo "$a: no container, skipped"; continue; }
  files=$(docker exec "$c" sh -c 'cd /data/memory 2>/dev/null && ls -1 *.md 2>/dev/null' || true)
  [ -n "$files" ] || { echo "$a: no notes to import"; continue; }
  mkdir -p "$DIR/$a" && chmod 700 "$DIR" "$DIR/$a"
  out="$DIR/$a/MEMORY.md"
  if [ -f "$out" ] && grep -q "orcie-import:data-memory" "$out"; then echo "$a: already imported"; continue; fi
  {
    echo "<!-- orcie-import:data-memory $(date -u +%Y-%m-%d) -->"
    echo "## Notes from before orcie memory (imported from /data/memory)"
    for f in $files; do echo; echo "### $f"; docker exec "$c" cat "/data/memory/$f"; echo; done
  } >> "$out"
  chmod 600 "$out"; echo "$a: imported $(echo "$files" | wc -l | tr -d ' ') files into $out"
done
