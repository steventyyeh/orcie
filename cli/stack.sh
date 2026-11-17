#!/bin/bash
# Whole-stack commands for the orcie CLI: setup, up, down, status, restart, logs, autostart.
# Sourced by cli/orcie (which has already set REPO, ORCIE_DIR, PREFIX, PORT, S and friends). Never uses sudo,
# never deletes volumes or user data, and never prints tokens.

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
good() { printf '  ok    %s\n' "$*"; }
note() { printf '  note  %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*" >&2; }
die() { bad "$*"; exit 1; }

YES=${ORCIE_YES:-0}
# ask "question": 0 = yes. --yes / ORCIE_YES=1 answers yes; with no terminal the answer is no (and we say how to say yes).
ask() {
  [ "$YES" = 1 ] && { say "  (yes: --yes)"; return 0; }
  if { [ -r /dev/tty ] && : </dev/tty; } 2>/dev/null; then local a; printf '  %s [y/N] ' "$1" >/dev/tty; read -r a </dev/tty; case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac; fi
  say "  $1  -> no terminal to ask on; re-run with --yes to agree"; return 1
}

SESSION="${PREFIX}-server"
LOG="$ORCIE_DIR/server.log"
healthz() { curl -s -o /dev/null --max-time 3 -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q '^200$'; }
docker_ok() { command -v docker >/dev/null 2>&1 && timeout_run 8 docker info >/dev/null 2>&1; }
# portable timeout (macOS has none): timeout_run <seconds> cmd...
timeout_run() { local t=$1; shift; "$@" & local p=$!; ( sleep "$t"; kill "$p" 2>/dev/null ) & local w=$!; wait "$p" 2>/dev/null; local r=$?; kill "$w" 2>/dev/null; wait "$w" 2>/dev/null; return $r; }
port_owner() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1" (pid "$2")"}'; }

# Containers that belong to this stack: labelled ones, plus the ones the database knows (older agents have no label).
stack_containers() {
  { docker ps -a --filter "label=orcie.stack=$PREFIX" --format '{{.Names}}' 2>/dev/null
    [ -f "$DB" ] && node --no-warnings -e 'try{const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});for(const r of d.prepare(`select container from agents where coalesce(kind, ?) = ?`).all("claude","claude"))console.log(r.container)}catch{}' "$DB" 2>/dev/null
  } | sort -u | while read -r c; do [ -n "$c" ] && docker inspect "$c" >/dev/null 2>&1 && echo "$c"; done
}

# ------------------------------------------------------------------ prerequisites
node_ok() { command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }
brew_install() { # brew_install <formula>...  (asks first; never sudo)
  command -v brew >/dev/null 2>&1 || { bad "Homebrew is not installed. Install it from https://brew.sh, or install: $*"; return 1; }
  ask "Install with Homebrew: brew install $*?" || { note "skipped; install it yourself: brew install $*"; return 1; }
  brew install "$@"
}
ensure_tool() { # ensure_tool <command> <formula> <what-it-is-for>
  command -v "$1" >/dev/null 2>&1 && { good "$1"; return 0; }
  bad "$1 is missing ($3)"; brew_install "$2" && command -v "$1" >/dev/null 2>&1 && { good "$1 installed"; return 0; }
  return 1
}
check_prereqs() {
  step "Checking prerequisites"
  local missing=0
  [ "$(uname -s)" = Darwin ] && good "macOS $(sw_vers -productVersion 2>/dev/null)" || { bad "orcie needs macOS (it uses colima and launchd). Linux is not supported yet."; missing=1; }
  ensure_tool git git "to fetch and update orcie" || missing=1
  ensure_tool tmux tmux "keeps the server running in the background" || missing=1
  if node_ok; then good "node $(node -v)"; else
    bad "node 22.13 or newer is required (found: $(node -v 2>/dev/null || echo none))"
    brew_install node && node_ok && good "node $(node -v)" || { note "fix: brew install node  (or use nvm/fnm to get Node 22+)"; missing=1; }
  fi
  if command -v claude >/dev/null 2>&1; then good "claude CLI"; else
    bad "the claude CLI is missing (needed for \`claude setup-token\` and the web HR interview)"
    if ask "Install it with: npm install -g @anthropic-ai/claude-code ?"; then npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 && good "claude installed" || { bad "npm could not install it (never use sudo). Try: curl -fsSL https://claude.ai/install.sh | bash"; missing=1; }
    else note "install it yourself: curl -fsSL https://claude.ai/install.sh | bash"; missing=1; fi
  fi
  [ $missing = 0 ] || die "Fix the items above, then run: orcie setup"
}

ensure_docker() {
  step "Docker"
  if docker_ok; then good "docker is running"; else
    if ! command -v docker >/dev/null 2>&1 || ! command -v colima >/dev/null 2>&1; then
      if [ -d "/Applications/Docker.app" ] && command -v docker >/dev/null 2>&1; then die "Docker Desktop is installed but not running. Open it (open -a Docker), wait for it to start, then run: orcie setup"; fi
      bad "docker/colima not found"; brew_install colima docker || die "Install colima and docker (brew install colima docker), then run: orcie setup"
    fi
    say "  starting colima (the Docker VM)..."
    if colima list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx default; then colima start || die "colima could not start. Try: colima status ; colima stop && colima start. If it stays broken: colima delete (this deletes the VM and its volumes, so only do it if you have nothing to keep)."
    else colima start --cpu 4 --memory 8 --disk 60 || die "colima could not start (see the output above)"; fi
    docker_ok || die "colima started but docker does not answer. Try: docker context use colima"
    good "colima started"
  fi
  local mem; mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
  if [ "$mem" -ge 6000000000 ] 2>/dev/null; then good "Docker VM memory $((mem/1073741824)) GiB"; else
    note "the Docker VM has only $((mem/1073741824)) GiB of memory; agents use 2-4 GiB each. More room: colima stop && colima start --memory 8"; fi
  if command -v colima >/dev/null 2>&1 && colima status >/dev/null 2>&1; then
    local free; free=$(colima ssh -- df -k /var/lib/docker 2>/dev/null | awk 'NR==2{print int($4/1048576)}')
    if [ -n "$free" ]; then [ "$free" -ge 10 ] && good "Docker VM disk: ${free} GiB free" || note "the Docker VM has only ${free} GiB free; agents need disk. More room: colima stop && colima start --disk 60 (can only grow)"; fi
  fi
  local hfree; hfree=$(df -k "$HOME" | awk 'NR==2{print int($4/1048576)}'); [ "${hfree:-0}" -ge 10 ] && good "Mac disk: ${hfree} GiB free" || note "the Mac has only ${hfree} GiB free"
}

# ------------------------------------------------------------------ auth, state dir, image
ensure_auth() {
  step "Claude subscription login (no API key is used)"
  if [ -s "$ORCIE_DIR/token" ]; then good "using the existing token ($ORCIE_DIR/token)"; return; fi
  if [ -s "$ORCIE_DIR/creds/.credentials.json" ]; then good "using the existing login copy ($ORCIE_DIR/creds)"; note "a long-lived token is more reliable: run claude setup-token and scripts/setup-token.sh"; return; fi
  { { [ -r /dev/tty ] && : </dev/tty; } 2>/dev/null; } || die "No subscription token found and no terminal to ask on. Run: claude setup-token, then: ORCIE_DIR=$ORCIE_DIR scripts/setup-token.sh, then: orcie setup"
  say "  Agents sign in with your Claude subscription through a long-lived token."
  say "  Step 1: Claude opens a browser login and prints a token. Step 2: paste it here (it is hidden and saved with mode 600)."
  ask "Run \`claude setup-token\` now?" && { claude setup-token </dev/tty || true; }
  local t; printf '  Paste the token (input hidden, empty to cancel): ' >/dev/tty; read -rs t </dev/tty; echo >/dev/tty
  [ -n "$t" ] || die "No token entered. Run: claude setup-token, then orcie setup"
  case "$t" in *[[:space:]]*) die "That does not look like a token (it contains spaces). Copy only the token." ;; esac
  ( umask 077; printf '%s' "$t" > "$ORCIE_DIR/token" ); chmod 600 "$ORCIE_DIR/token"; t=""
  good "saved $ORCIE_DIR/token (mode 600)"
}
ensure_dirs() {
  step "State directory $ORCIE_DIR"
  ( umask 077; mkdir -p "$ORCIE_DIR" "$ORCIE_DIR/git" "$ORCIE_DIR/files" "$ORCIE_DIR/memory" "$ORCIE_DIR/archives" "$ORCIE_DIR/tmux" ); chmod 700 "$ORCIE_DIR"
  for f in server-secret api-token; do
    [ -s "$ORCIE_DIR/$f" ] || { ( umask 077; openssl rand -hex 32 > "$ORCIE_DIR/$f" ); chmod 600 "$ORCIE_DIR/$f"; good "generated $f"; }
  done
  if [ ! -f "$ORCIE_DIR/env" ]; then # remembered settings for every later command (a local, isolated stack sets its own)
    ( umask 077; { echo "# written by orcie setup; edit to change ports. KEY=value only."; echo "ORCIE_PREFIX=$PREFIX"; echo "PORT=$PORT"; echo "ORCIE_AGENT_PORT=$AGENT_PORT"; echo "ORCIE_API_PORT=${ORCIE_API_PORT:-8787}"; echo "ORCIE_API_HOST=${ORCIE_API_HOST:-127.0.0.1}"; echo "ORCIE_DB=$DB"; } > "$ORCIE_DIR/env" )
    good "wrote $ORCIE_DIR/env (ports and database path)"
  else good "settings in $ORCIE_DIR/env"; fi
}
ensure_github() {
  step "GitHub access for agents (optional)"
  if [ -s "$ORCIE_DIR/git/token" ]; then good "a shared GitHub token is already set"; return; fi
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if ask "Share your gh login with agents so they can use git and gh? (read-only mount; you can skip)"; then ORCIE_DIR="$ORCIE_DIR" "$REPO/scripts/export-git-login.sh" >/dev/null && good "GitHub token shared"; else note "skipped; later: scripts/export-git-login.sh"; fi
  else note "skipped (gh is not logged in). Later: gh auth login && scripts/export-git-login.sh"; fi
}
build_deps_image() {
  step "Dependencies and agent image"
  ( cd "$REPO" && npm install --no-audit --no-fund --no-package-lock --loglevel=error ) && good "npm dependencies" || die "npm install failed"
  say "  building image ${PREFIX}-agent:dev (the first build takes several minutes; later runs are cached)..."
  docker build -q -t "${PREFIX}-agent:dev" "$REPO/harness" >/dev/null && good "image ${PREFIX}-agent:dev" || { docker build -t "${PREFIX}-agent:dev" "$REPO/harness" 2>&1 | tail -15; die "docker build failed (see above)"; }
}

# ------------------------------------------------------------------ server
start_server() {
  if healthz; then good "server already running on port $PORT"; return 0; fi
  local p
  for p in "$PORT:UI" "$AGENT_PORT:agent" "${ORCIE_API_PORT:-8787}:private-API"; do
    local o; o=$(port_owner "${p%%:*}"); [ -n "$o" ] && die "port ${p%%:*} (${p##*:}) is already used by $o. Stop it, or change the port in $ORCIE_DIR/env (PORT, ORCIE_AGENT_PORT, ORCIE_API_PORT) and run again."
  done
  tmux has-session -t "=$SESSION" 2>/dev/null && tmux kill-session -t "=$SESSION"
  ( umask 077; mkdir -p "$ORCIE_DIR"; [ -f "$LOG" ] && mv -f "$LOG" "$LOG.1"; : > "$LOG" )
  local envs=(-e "PATH=$PATH" -e "HOME=$HOME" -e "PORT=$PORT" -e "ORCIE_AGENT_PORT=$AGENT_PORT" -e "ORCIE_DIR=$ORCIE_DIR" -e "ORCIE_PREFIX=$PREFIX" -e "ORCIE_DB=$DB")
  [ -n "${ORCIE_API_PORT:-}" ] && envs+=(-e "ORCIE_API_PORT=$ORCIE_API_PORT"); [ -n "${ORCIE_API_HOST:-}" ] && envs+=(-e "ORCIE_API_HOST=$ORCIE_API_HOST"); [ -n "${ORCIE_HOST:-}" ] && envs+=(-e "ORCIE_HOST=$ORCIE_HOST")
  tmux new-session -d -s "$SESSION" -c "$REPO" "${envs[@]}" "node --experimental-strip-types server/src/index.ts 2>&1 | tee -a '$LOG'"
  local i; for i in $(seq 1 60); do healthz && { good "server up: http://localhost:$PORT  (tmux session $SESSION, log $LOG)"; return 0; }; tmux has-session -t "=$SESSION" 2>/dev/null || break; sleep 1; done
  bad "the server did not become healthy. Last log lines:"; tail -15 "$LOG" >&2; exit 1
}
stop_server() { tmux has-session -t "=$SESSION" 2>/dev/null && { tmux kill-session -t "=$SESSION"; good "server stopped"; } || note "server was not running in tmux ($SESSION)"; }
wait_agents() { # wait until every container of the stack reports healthy
  local c i bad_=""; for i in $(seq 1 60); do bad_=""; for c in $(stack_containers); do
    [ "$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null)" = "running/healthy" ] || bad_="$bad_ $c"; done
    [ -z "$bad_" ] && return 0; sleep 2; done; note "not healthy yet:$bad_ (see: orcie status)"; return 1
}

# ------------------------------------------------------------------ commands
cmd_up() {
  step "Starting the stack ($PREFIX)"
  docker_ok || { command -v colima >/dev/null 2>&1 || die "docker is not running and colima is not installed. Run: orcie setup"; say "  starting colima..."; colima start >/dev/null 2>&1 || colima start || die "colima could not start. See: orcie status, and Troubleshooting in the README"; }
  docker_ok || die "docker does not answer"; good "docker"
  local c; for c in $(stack_containers); do [ "$(docker inspect -f '{{.State.Running}}' "$c")" = true ] || { docker start "$c" >/dev/null && good "started $c"; }; done
  start_server; wait_agents && good "agents healthy"
}
cmd_down() {
  step "Stopping the stack ($PREFIX); colima keeps running, nothing is deleted"
  stop_server
  local c; for c in $(stack_containers); do docker stop -t 20 "$c" >/dev/null 2>&1 && good "stopped $c"; done
}
cmd_status() {
  local rc=0
  if command -v colima >/dev/null 2>&1; then colima status >/dev/null 2>&1 && good "colima: running" || { bad "colima: stopped (run: orcie up)"; rc=1; }; fi
  docker_ok && good "docker: answering" || { bad "docker: not answering"; rc=1; }
  if healthz; then good "server: up at http://localhost:$PORT  (tmux: $(tmux has-session -t "=$SESSION" 2>/dev/null && echo "$SESSION" || echo "not under tmux"))"; else bad "server: down (run: orcie up)"; rc=1; fi
  if docker_ok; then
    local c n=0; for c in $(stack_containers); do n=$((n+1))
      local st; st=$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null)
      [ "$st" = "running/healthy" ] && good "agent ${c#${PREFIX}-}: healthy" || { bad "agent ${c#${PREFIX}-}: $st"; rc=1; }; done
    [ $n = 0 ] && note "no agent containers yet"
  fi
  return $rc
}
cmd_restart_stack() {
  local force=${1:-0}
  if [ "$force" != 1 ] && healthz; then # let running work finish first
    local n=0; while curl -s "$S/api/activity" | grep -q '"agent"'; do [ $n = 0 ] && say "agents are busy; waiting for them to finish (use --force to skip)..."; n=$((n+1)); [ $n -gt 360 ] && die "still busy after 30 minutes; use: orcie restart --force"; sleep 5; done
  fi
  cmd_down; cmd_up
}
cmd_logs_server() { [ -f "$LOG" ] || die "no server log yet ($LOG)"; if [ "${1:-}" = -f ]; then tail -n 100 -f "$LOG"; else tail -n "${1:-100}" "$LOG"; fi; }

LAUNCHD_DIR="${ORCIE_LAUNCHD_DIR:-$HOME/Library/LaunchAgents}"
cmd_autostart() {
  local label="com.orcie.$PREFIX" plist="$LAUNCHD_DIR/com.orcie.$PREFIX.plist"
  case "${1:-}" in
    on) mkdir -p "$LAUNCHD_DIR"
      cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$REPO/cli/orcie</string><string>up</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>ORCIE_DIR</key><string>$ORCIE_DIR</string><key>ORCIE_PREFIX</key><string>$PREFIX</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$ORCIE_DIR/autostart.log</string><key>StandardErrorPath</key><string>$ORCIE_DIR/autostart.log</string>
</dict></plist>
EOF
      good "wrote $plist"
      if [ "${ORCIE_LAUNCHD_NOLOAD:-0}" = 1 ]; then note "not loaded (ORCIE_LAUNCHD_NOLOAD=1)"; else launchctl bootout "gui/$(id -u)/$label" 2>/dev/null; launchctl bootstrap "gui/$(id -u)" "$plist" && good "autostart on: the stack starts at login" || die "launchctl could not load it"; fi ;;
    off) if [ "${ORCIE_LAUNCHD_NOLOAD:-0}" != 1 ]; then launchctl bootout "gui/$(id -u)/$label" 2>/dev/null; fi; rm -f "$plist"; good "autostart off" ;;
    status|"") [ -f "$plist" ] && say "autostart: on ($plist)" || say "autostart: off" ;;
    *) die "usage: orcie autostart on|off|status" ;;
  esac
}

cmd_setup() {
  local hr_force=false open=1
  while [ $# -gt 0 ]; do case "$1" in --yes|-y) YES=1 ;; --hr) hr_force=true ;; --no-open) open=0 ;; *) die "unknown option $1 (setup takes --yes, --hr, --no-open)" ;; esac; shift; done
  say "orcie setup: prepares this Mac and starts the stack. Safe to run again. It never deletes volumes or data and never uses sudo."
  check_prereqs; ensure_docker; ensure_dirs; ensure_auth; ensure_github; build_deps_image
  step "Starting the server"; start_server
  step "Starter HR agent"
  local out; out=$(curl -s -X POST "$S/api/starter-hr" -H 'content-type: application/json' -d "{\"force\":$hr_force}")
  case "$out" in
    *'"created"'*) good "created agent \"hr\" (it greets you in its DM)" ;;
    *'"exists"'*) good "agent \"hr\" already exists" ;;
    *'"declined"'*) note "HR was laid off on purpose, so it was not recreated. Bring it back with: orcie setup --hr" ;;
    *'"name-taken"'*) note "an agent named hr already exists and is not the starter agent; left alone" ;;
    *) die "could not create the HR agent: $out" ;;
  esac
  wait_agents && good "agents healthy"
  local url="http://localhost:$PORT"; [ -n "$(echo "$out" | grep -E 'created|exists')" ] && url="$url/dm/hr"
  step "Done"
  say "  Open:        $url"
  say "  Next:        tell HR what team you want to build; it interviews you and creates the agents."
  say "  Commands:    orcie status | orcie restart | orcie down | orcie up | orcie logs | orcie autostart on"
  say "  Data:        $ORCIE_DIR   (login token, secrets, memory; keep it private)"
  [ "$open" = 1 ] && [ "${ORCIE_NO_OPEN:-0}" != 1 ] && command -v open >/dev/null 2>&1 && [ -t 1 ] && open "$url" >/dev/null 2>&1
  return 0
}
