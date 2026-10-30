#!/bin/bash
# Copies your existing Claude subscription login (macOS Keychain) to a private dir that agent containers mount.
set -e
mkdir -p ~/.orcie/creds && chmod 700 ~/.orcie ~/.orcie/creds
security find-generic-password -s "Claude Code-credentials" -w > ~/.orcie/creds/.credentials.json
chmod 600 ~/.orcie/creds/.credentials.json && echo "exported to ~/.orcie/creds"
