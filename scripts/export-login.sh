#!/bin/bash
# Copies your existing Claude subscription login (macOS Keychain) to a private dir that agent containers mount.
set -e
D="${ORCIE_DIR:-$HOME/.orcie}"
mkdir -p "$D"/creds && chmod 700 "$D" "$D"/creds
security find-generic-password -s "Claude Code-credentials" -w > "$D"/creds/.credentials.json
chmod 600 "$D"/creds/.credentials.json && echo "exported to $D/creds"
