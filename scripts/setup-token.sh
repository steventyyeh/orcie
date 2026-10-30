#!/bin/bash
# One-time: create a long-lived Claude subscription token for agent containers (no rotation, no refresh conflicts).
# 1) run `claude setup-token` and complete the browser login, 2) paste the token when prompted.
set -e
mkdir -p ~/.orcie && chmod 700 ~/.orcie
read -rsp "Paste the token from 'claude setup-token' (input hidden): " T; echo
[ -n "$T" ] || { echo "empty token"; exit 1; }
printf '%s' "$T" > ~/.orcie/token && chmod 600 ~/.orcie/token
echo "saved ~/.orcie/token. Restart the server, then run: cli/orcie recreate-all"
