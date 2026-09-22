#!/usr/bin/env bash
# Linux: update the Git checkout and the existing Compose gateway service.
set -Eeuo pipefail
umask 077

log() { printf '[docker-update] %s\n' "$*" >&2; }
fail() { log "$*"; exit 1; }

usage() {
  cat <<'HELP'
Usage: bash scripts/docker-update.sh [options]

  --no-pull             Build the checked-out commit without pulling Git.
  --rollback DIRECTORY  Restore a backup printed by an earlier update.
  --wait-timeout N      Health-check deadline in seconds (default: 120).
  --drain-timeout N     Wait for accepted requests (default: 0 = no deadline).
  -p, --project-name N  Existing Compose project name.
  -f, --file FILE       Compose file; repeat to include overrides.
  --env-file FILE       Compose environment file; repeat if needed.
  -h, --help            Show this help.

Requires Linux, Bash, Git, Python 3, flock, Docker and Docker Compose v2
with up --wait / --wait-timeout. Start the gateway once with Compose first.
Update requires a clean Git checkout; ignored .env files are kept as-is.
Backups contain resolved configuration and must be kept private.
The running image must support drain control. No forced restart fallback.
HELP
}

container_id() {
  local id
  id=$("${compose[@]}" ps --all --quiet gateway) || return
  [[ -n "$id" && "$id" != *$'\n'* ]] || {
    log 'Expected exactly one existing gateway container. Check the Compose project/files.'
    return 1
  }
  printf '%s\n' "$id"
}

healthy() {
  local status
  status=$(docker inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$1") || return
  [[ "$status" == 'true healthy' ]] || {
    log "Container $1 is not healthy ($status)."
    return 1
  }
}

control() {
  docker exec --workdir /app "$1" node dist/ops/control-cli.js "$2"
}

drain_and_wait() {
  local id=$1 status remaining started=$SECONDS last_remaining=''
  # Record before POST: cancellation may arrive after the server drains but
  # before the client sees its reply. The exit trap must still resume it.
  drained_container=$id
  status=$(control "$id" drain) || return
  log 'New business requests are paused. Waiting for HTTP/SSE and accepted WebSocket generations...'
  while :; do
    remaining=$(python3 -c 'import json,sys; s=json.load(sys.stdin); assert s["draining"] is True; print(s["activeRequests"])' <<<"$status") || return
    [[ "$remaining" =~ ^[0-9]+$ ]] || return 1
    if [[ "$remaining" != "$last_remaining" ]]; then
      log "Requests still running: $remaining"
      last_remaining=$remaining
    fi
    (( remaining != 0 )) || return 0
    if (( drain_timeout > 0 && SECONDS - started >= drain_timeout )); then
      log 'Drain deadline reached. Existing requests will not be killed; update is cancelled.'
      return 1
    fi
    sleep 2
    status=$(control "$id" status) || return
  done
}

restore() {
  local directory=$1 saved_project saved_root saved_image saved_id actual_id id current running
  [[ -f "$directory/compose.json" && -f "$directory/image" && -f "$directory/image-id" &&
     -f "$directory/project" && -f "$directory/repository" ]] || {
    log 'Incomplete backup; cannot roll back.'
    return 1
  }
  saved_root=$(<"$directory/repository")
  saved_project=$(<"$directory/project")
  saved_image=$(<"$directory/image")
  saved_id=$(<"$directory/image-id")
  [[ "$saved_root" == "$root" && "$saved_project" =~ ^[a-z0-9][a-z0-9_-]*$ &&
     "$saved_image" =~ ^[a-z0-9][a-z0-9_-]*-gateway:rollback-[a-zA-Z0-9_-]+$ &&
     "$saved_id" =~ ^sha256:[a-f0-9]{64}$ ]] || {
    log 'Backup does not belong to this repository or contains invalid metadata.'
    return 1
  }
  actual_id=$(docker image inspect --format '{{.Id}}' "$saved_image") || return
  [[ "$actual_id" == "$saved_id" ]] || {
    log 'The backup image is missing or its tag changed; refusing to use a different image.'
    return 1
  }
  local -a recovery=(docker compose --project-directory "$root" --project-name "$saved_project"
    --env-file /dev/null -f "$directory/compose.json")
  current=$(docker ps --all --quiet --filter "label=com.docker.compose.project=$saved_project" \
    --filter label=com.docker.compose.service=gateway --filter label=com.docker.compose.oneoff=False) || return
  [[ "$current" != *$'\n'* ]] || { log 'Expected at most one gateway container for rollback.'; return 1; }
  if [[ -n "$current" ]]; then
    running=$(docker inspect --format '{{.State.Running}}' "$current") || return
    case "$running" in
      true) drain_and_wait "$current" || return ;;
      false) ;; # A stopped container has no active requests.
      *) log 'Cannot determine whether gateway is running; refusing rollback.'; return 1 ;;
    esac
  fi
  log "Restoring $saved_image using the saved configuration..."
  "${recovery[@]}" up --detach --no-deps --no-build --pull never --force-recreate \
    --wait --wait-timeout "$wait_timeout" gateway || return
  id=$("${recovery[@]}" ps --all --quiet gateway) || return
  [[ -n "$id" && "$id" != *$'\n'* ]] || return 1
  healthy "$id" || return
  actual_id=$(docker inspect --format '{{.Image}}' "$id") || return
  [[ "$actual_id" == "$saved_id" ]] || {
    log 'Rollback started an unexpected image.'
    return 1
  }
  drained_container=''
  log 'Rollback healthy. Git files and .env have not been reset.'
}

finish() {
  local status=$?
  trap - EXIT
  # A second interrupt must not abort recovery halfway through.
  trap '' INT TERM HUP
  if (( rollback_needed )); then
    log 'Update failed or was interrupted during replacement; rolling back...'
    if restore "$backup"; then
      log "Update was not applied. Backup: $backup"
      (( status != 0 )) || status=1
    else
      log "AUTOMATIC ROLLBACK FAILED. Keep the backup and inspect Docker: $backup"
      log "Retry: bash scripts/docker-update.sh --rollback '$backup'"
      status=2
    fi
  elif (( status != 0 )); then
    log 'Stopped before a successful update. See the error above.'
  fi
  if [[ -n "$drained_container" ]] && docker inspect "$drained_container" >/dev/null 2>&1; then
    if control "$drained_container" resume >/dev/null; then
      log 'The existing gateway is accepting requests again.'
    else
      log "Could not resume gateway $drained_container. Run its control-cli.js resume command manually."
      status=2
    fi
  fi
  exit "$status"
}

# Bash can unwind main's local variables before the EXIT trap runs on errexit.
# Recovery state must remain available until finish has resumed or restored service.
root='' backup='' rollback_needed=0 drained_container=''
wait_timeout=120 drain_timeout=0

# Keep the executable body in a function: git pull may replace this script on disk.
main() {
  local state pull=1 rollback_directory=''
  root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
  local -a compose=(docker compose --project-directory "$root")
  while (( $# )); do
    case "$1" in
      --no-pull) pull=0; shift ;;
      --rollback|--wait-timeout|--drain-timeout|-p|--project-name|-f|--file|--env-file)
        (( $# >= 2 )) && [[ -n "$2" ]] || fail "Missing value for $1"
        case "$1" in
          --rollback) rollback_directory=$2 ;;
          --wait-timeout) wait_timeout=$2 ;;
          --drain-timeout) drain_timeout=$2 ;;
          *) compose+=("$1" "$2") ;;
        esac
        shift 2
        ;;
      -h|--help) usage; return ;;
      *) usage >&2; fail "Unknown option: $1" ;;
    esac
  done
  [[ "$wait_timeout" =~ ^[1-9][0-9]{0,3}$ ]] && (( wait_timeout <= 3600 )) ||
    fail '--wait-timeout must be between 1 and 3600 seconds.'
  [[ "$drain_timeout" =~ ^(0|[1-9][0-9]{0,5})$ ]] && (( drain_timeout <= 86400 )) ||
    fail '--drain-timeout must be between 0 and 86400 seconds (0 waits indefinitely).'
  [[ "$(uname -s)" == Linux ]] || fail 'Run this script on the Linux deployment host.'
  local command
  for command in git docker python3 flock; do
    command -v "$command" >/dev/null || fail "Required command not found: $command"
  done
  cd -- "$root"
  [[ "$(git rev-parse --show-toplevel)" == "$root" ]] || fail 'Script must be inside this Git repository.'
  docker info >/dev/null || fail 'Docker daemon is unavailable or permission was denied.'
  local help
  help=$(docker compose up --help) || fail 'Docker Compose v2 is required.'
  [[ "$help" == *'--wait-timeout'* ]] || fail 'Upgrade Docker Compose: up --wait-timeout is required.'

  state="$root/.docker-update"
  [[ ! -L "$state" ]] || fail '.docker-update must not be a symlink.'
  mkdir -p -- "$state/backups"
  chmod 700 "$state" "$state/backups"
  # Kernel lock is released even after a crash; do not unlink the lock file.
  exec 9>"$state/update.lock"
  flock --nonblock 9 || fail 'Another Docker update/rollback is already running.'
  trap finish EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP

  if [[ -n "$rollback_directory" ]]; then
    rollback_directory=$(cd -- "$rollback_directory" && pwd -P) || fail 'Backup directory not found.'
    [[ "$rollback_directory" == "$state/backups/"* ]] || fail 'Choose a backup under .docker-update/backups.'
    restore "$rollback_directory" || exit 2
    exit 0
  fi

  [[ -z "$(git status --porcelain --untracked-files=all)" ]] ||
    fail 'Git checkout is dirty. Commit/stash your changes first; this script never resets or stashes files.'
  if (( pull )); then
    git symbolic-ref --quiet HEAD >/dev/null || fail 'Detached HEAD: select a branch or use --no-pull.'
    git rev-parse --verify '@{upstream}' >/dev/null || fail 'Current branch needs a Git upstream or --no-pull.'
  fi
  "${compose[@]}" config --quiet
  local old_container project image_id revision stamp
  old_container=$(container_id)
  healthy "$old_container" || fail 'Existing gateway must be healthy before an update.'
  local drain_status
  drain_status=$(control "$old_container" status) ||
    fail 'Running image has no usable drain control. Install this feature in a maintenance window first; no container was stopped.'
  python3 -c 'import json,sys; assert json.load(sys.stdin)["draining"] is False' <<<"$drain_status" ||
    fail 'Gateway is already draining. Resume it or use --rollback to recover.'
  project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$old_container")
  [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'Invalid Compose project on the existing container.'
  # A newly pulled Compose file must not silently select another project.
  compose+=(--project-name "$project")
  image_id=$(docker inspect --format '{{.Image}}' "$old_container")
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Cannot determine the running image ID.'
  revision=$(git rev-parse HEAD)
  backup=$(mktemp -d "$state/backups/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
  stamp=$(basename -- "$backup")
  local backup_image="${project}-gateway:rollback-${stamp}"
  docker image tag "$image_id" "$backup_image"
  printf '%s\n' "$root" >"$backup/repository"
  printf '%s\n' "$project" >"$backup/project"
  printf '%s\n' "$image_id" >"$backup/image-id"
  printf '%s\n' "$backup_image" >"$backup/image"
  printf '%s\n' "$revision" >"$backup/git-before"
  "${compose[@]}" config --format json >"$backup/resolved.json"
  python3 - "$backup/resolved.json" "$backup/compose.json" "$backup_image" "$project" <<'PY'
import json
import sys

source, destination, image, project = sys.argv[1:]
with open(source, encoding="utf-8") as file:
    config = json.load(file)
gateway = config["services"]["gateway"]
if not gateway.get("build"):
    raise SystemExit("gateway must use the repository's Docker build configuration")
gateway.pop("build")
gateway.pop("pull_policy", None)
gateway["image"] = image
config["name"] = project

# Compose will interpolate a saved config again. Protect literal dollars in
# passwords/URLs/commands, including existing '$$' and '${...}' text.
def literal(value):
    if isinstance(value, str):
        return value.replace("$", "$$")
    if isinstance(value, list):
        return [literal(item) for item in value]
    if isinstance(value, dict):
        return {key: literal(item) for key, item in value.items()}
    return value

with open(destination, "w", encoding="utf-8") as file:
    json.dump(literal(config), file, ensure_ascii=False, indent=2)
    file.write("\n")
PY
  docker compose --project-directory "$root" --project-name "$project" \
    --env-file /dev/null -f "$backup/compose.json" config --quiet
  log "Saved running image and pre-update Compose configuration: $backup"

  if (( pull )); then
    log 'Pulling the current branch with --ff-only...'
    git pull --ff-only
  fi
  git rev-parse HEAD >"$backup/git-target"
  "${compose[@]}" config --quiet
  log 'Building the new image while the existing gateway keeps running...'
  "${compose[@]}" build --pull gateway
  # Detect a concurrent manual deployment before replacing its container.
  [[ "$(container_id)" == "$old_container" ]] || fail 'Gateway changed during the build; refusing to replace it.'
  healthy "$old_container" || fail 'Existing gateway became unhealthy during the build; update stopped.'

  drain_and_wait "$old_container"
  [[ "$(container_id)" == "$old_container" ]] || fail 'Gateway changed while draining; update stopped.'
  log 'All accepted requests have ended. Replacing gateway and waiting for Docker healthcheck...'
  rollback_needed=1
  "${compose[@]}" up --detach --no-deps --no-build --pull never --force-recreate \
    --wait --wait-timeout "$wait_timeout" gateway
  healthy "$(container_id)"
  rollback_needed=0
  drained_container=''
  log "Update healthy. Git commit: $(git rev-parse --short HEAD)"
  log "Manual rollback: bash scripts/docker-update.sh --rollback '$backup'"
  exit 0
}

main "$@"
