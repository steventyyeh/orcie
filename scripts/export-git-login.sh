#!/bin/bash
# Shares one GitHub credential with every agent: copies a gh token to $ORCIE_DIR/git/token (mounted read-only into all containers,
# read at use time, so re-running this updates every agent without recreating it).
# Usage: scripts/export-git-login.sh [github-username]   (default: the active gh account)
# To use a narrower fine-grained PAT instead, write it to $ORCIE_DIR/git/token yourself.
set -e
D="${ORCIE_DIR:-$HOME/.orcie}"
mkdir -p "$D"/git && chmod 700 "$D" "$D"/git
if [ -n "$1" ]; then gh auth token --user "$1" > "$D"/git/token; else gh auth token > "$D"/git/token; fi
chmod 600 "$D"/git/token && echo "exported GitHub token to $D/git/token"
