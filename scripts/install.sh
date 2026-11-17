#!/bin/bash
# orcie installer. Run it from a pipe or from a clone:
#   curl -fsSL https://raw.githubusercontent.com/steventyyeh/orcie/main/scripts/install.sh | bash
# It prints what it will do, fetches orcie into ~/orcie (override: ORCIE_HOME), links the `orcie` command, then runs `orcie setup`.
# It never uses sudo and never deletes anything. Read it first if you like: curl -fsSL <url> -o install.sh; less install.sh; bash install.sh
set -euo pipefail

REPO_URL="${ORCIE_REPO:-https://github.com/steventyyeh/orcie.git}"
BRANCH="${ORCIE_BRANCH:-main}"
BIN_DIR="${ORCIE_BIN_DIR:-$HOME/.local/bin}"
HERE=""; case "${BASH_SOURCE[0]:-}" in */scripts/install.sh) HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)" ;; esac
if [ -n "$HERE" ] && [ -f "$HERE/cli/orcie" ] && [ -z "${ORCIE_HOME:-}" ]; then ORCIE_HOME="$HERE"; fi # run from a clone: use it
ORCIE_HOME="${ORCIE_HOME:-$HOME/orcie}"

cat <<PLAN
orcie installer. This is what it is about to do:
  1. get orcie:    $( [ -d "$ORCIE_HOME/.git" ] && echo "update the existing clone in $ORCIE_HOME (git pull --ff-only)" || echo "clone $REPO_URL ($BRANCH) into $ORCIE_HOME" )
  2. link command: $BIN_DIR/orcie -> $ORCIE_HOME/cli/orcie
  3. run \`orcie setup\`, which checks git, tmux, node, docker/colima and the claude CLI (asking before it installs anything with Homebrew),
     starts colima, saves your Claude subscription token to ${ORCIE_DIR:-$HOME/.orcie} (mode 600), builds the agent image,
     starts the server in a tmux session and creates a starter HR agent.
  No sudo. No data is deleted. Nothing is sent anywhere except to GitHub, Homebrew and Anthropic's own tools.
PLAN
if { [ -r /dev/tty ] && : </dev/tty; } 2>/dev/null && [ "${ORCIE_YES:-0}" != 1 ] && [[ " $* " != *" --yes "* ]]; then
  printf 'Continue? [Y/n] ' >/dev/tty; read -r a </dev/tty; case "$a" in n|N|no|NO) echo "cancelled"; exit 1 ;; esac
fi

command -v git >/dev/null 2>&1 || { echo "git is required. Install the Xcode command line tools (xcode-select --install) or: brew install git" >&2; exit 1; }
if [ -d "$ORCIE_HOME/.git" ]; then
  if git -C "$ORCIE_HOME" diff --quiet && git -C "$ORCIE_HOME" diff --cached --quiet; then git -C "$ORCIE_HOME" pull --ff-only --quiet origin "$BRANCH" 2>/dev/null || git -C "$ORCIE_HOME" pull --ff-only --quiet || echo "note: could not update $ORCIE_HOME (continuing with what is there)"
  else echo "note: $ORCIE_HOME has local changes; not updating it"; fi
elif [ -e "$ORCIE_HOME" ] && [ -n "$(ls -A "$ORCIE_HOME" 2>/dev/null)" ]; then
  echo "$ORCIE_HOME exists and is not an orcie clone. Choose another place: ORCIE_HOME=~/somewhere bash install.sh" >&2; exit 1
else
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$ORCIE_HOME"
fi
echo "orcie is in $ORCIE_HOME"

mkdir -p "$BIN_DIR"
if [ ! -e "$BIN_DIR/orcie" ] || { [ -L "$BIN_DIR/orcie" ] && [ "$(readlink "$BIN_DIR/orcie")" = "$ORCIE_HOME/cli/orcie" ]; }; then ln -sf "$ORCIE_HOME/cli/orcie" "$BIN_DIR/orcie"; echo "linked $BIN_DIR/orcie"
else echo "note: $BIN_DIR/orcie already exists and points elsewhere; left alone. Use $ORCIE_HOME/cli/orcie"; fi
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "note: add $BIN_DIR to your PATH (zsh: echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc)" ;; esac

exec "$ORCIE_HOME/cli/orcie" setup "$@"
