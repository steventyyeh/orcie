#!/bin/bash
# Shares one GitHub credential with every agent: copies a gh token to ~/.orcie/git/token (mounted read-only into all containers,
# read at use time, so re-running this updates every agent without recreating it).
# Usage: scripts/export-git-login.sh [github-username]   (default: the active gh account)
# To use a narrower fine-grained PAT instead, write it to ~/.orcie/git/token yourself.
set -e
mkdir -p ~/.orcie/git && chmod 700 ~/.orcie ~/.orcie/git
if [ -n "$1" ]; then gh auth token --user "$1" > ~/.orcie/git/token; else gh auth token > ~/.orcie/git/token; fi
chmod 600 ~/.orcie/git/token && echo "exported GitHub token to ~/.orcie/git/token"
