#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Deploy one exact commit of Drishyam on THIS server.
#
#   scripts/deploy.sh <commit-sha>          (run from the server's checkout)
#
# Called by .github/workflows/deploy-testing.yml on the self-hosted runner. Generic
# enough for production to reuse later (DEPLOY_BRANCH=production, its own
# HEALTH_URLS); nothing here is testing-specific except the defaults.
#
# Steps:
#   1. Refuse to run if the working tree is dirty. A dirty tree means someone edited
#      the server by hand; we stop and show it, never overwrite it.
#   2. Fetch and check out the exact SHA (detached HEAD). It must be on
#      origin/$DEPLOY_BRANCH.
#   3. Back up MySQL (drishyamvms) + Postgres (vms_face) to $BACKUP_DIR.
#   4. npm ci (backend/frontend) when a lockfile changed: node_modules live in
#      named volumes, so a rebuilt image alone wouldn't bring new dependencies.
#   5. docker compose build, then up -d (migrations run as the containers start).
#   6. Health checks, then explicit migrations (fail loudly if a migration fails).
#   7. Record the deployed SHA in .deploy/last-deployed and .deploy/history.log.
#
# Env (all optional):
#   DEPLOY_BRANCH   branch the SHA must be on            (default: main)
#   BACKUP_DIR      where DB dumps go                    (default: ~/drishyam-backups)
#   BACKUP_KEEP     dumps to keep                        (default: 20)
#   SKIP_BACKUP=1   skip step 3
#   HEALTH_URLS     space-separated "url=timeout_s" pairs (default: app, backend, AI, edge)
#   DEPLOY_ACTOR    who triggered it (default: $GITHUB_ACTOR or $USER)
#
# Exit codes: 0 ok · 1 failed (details on stderr) · 2 bad usage.
# Rollback = run this again with the previous good SHA (workflow_dispatch).
# ═══════════════════════════════════════════════════════════════════════════

# Everything lives in main(): bash parses the whole function before running it,
# so checking out a different version of this file mid-deploy can't corrupt
# the running script.
main() {
  set -Eeuo pipefail

  local sha_arg="${1:-}"
  if [[ -z "$sha_arg" || "$sha_arg" == -h || "$sha_arg" == --help ]]; then
    echo "usage: scripts/deploy.sh <commit-sha>" >&2
    return 2
  fi

  local root
  root="$(git rev-parse --show-toplevel)"
  cd "$root"

  local branch="${DEPLOY_BRANCH:-main}"
  local backup_root="${BACKUP_DIR:-$HOME/drishyam-backups}"
  local backup_keep="${BACKUP_KEEP:-20}"
  local actor="${DEPLOY_ACTOR:-${GITHUB_ACTOR:-${USER:-unknown}}}"
  local health_urls="${HEALTH_URLS:-http://127.0.0.1:5173/=180 http://127.0.0.1:5000/api/health/live=240 http://127.0.0.1:8001/healthz=900 http://127.0.0.1:8080/edge-health=120}"
  local state_dir="$root/.deploy"
  mkdir -p "$state_dir"

  # One deploy at a time, even outside GitHub's concurrency group.
  exec 9>"$state_dir/lock"
  flock -n 9 || { err "another deploy is running (lock: $state_dir/lock)"; return 1; }

  local started; started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local sha="" prev=""
  trap 'on_fail "$sha" "$started" "$actor" "$state_dir"' ERR

  # ── 1. dirty tree ─────────────────────────────────────────────────────────
  step "1/7 working tree must be clean"
  local dirty; dirty="$(git status --porcelain)"
  if [[ -n "$dirty" ]]; then
    err "working tree is DIRTY: someone changed files on the server by hand."
    err "Not deploying. Commit these to a branch + PR (or remove them), then redeploy:"
    printf '%s\n' "$dirty" >&2
    git --no-pager diff --stat >&2 || true
    return 1
  fi

  # ── 2. fetch + checkout ───────────────────────────────────────────────────
  step "2/7 fetch and check out $sha_arg"
  git fetch --prune --quiet origin
  sha="$(git rev-parse --verify --quiet "${sha_arg}^{commit}")" \
    || { err "unknown commit: $sha_arg"; return 1; }
  if ! git merge-base --is-ancestor "$sha" "origin/$branch"; then
    err "$sha is not on origin/$branch; refusing to deploy it."
    return 1
  fi
  prev="$(git rev-parse HEAD)"
  git -c advice.detachedHead=false checkout --quiet --detach "$sha"
  echo "    $prev -> $sha  ($(git log -1 --format=%s "$sha"))"

  # ── 3. backup ─────────────────────────────────────────────────────────────
  step "3/7 back up databases"
  if [[ "${SKIP_BACKUP:-0}" == 1 ]]; then
    echo "    skipped (SKIP_BACKUP=1)"
  else
    backup "$backup_root" "$sha" "$backup_keep"
  fi

  # ── 4. dependencies ───────────────────────────────────────────────────────
  step "4/7 npm dependencies"
  local svc dir
  for pair in smart-cam-backend:backend smart-cam-app:frontend; do
    svc="${pair%%:*}"; dir="${pair#*:}"
    if [[ "$prev" == "$sha" ]] || git diff --quiet "$prev" "$sha" -- "$dir/package-lock.json"; then
      echo "    $dir: lockfile unchanged"
    else
      echo "    $dir: lockfile changed -> npm ci in $svc's node_modules volume"
      docker compose run --rm --no-deps -T "$svc" npm ci --no-audit --no-fund
    fi
  done

  # ── 5. build + up ─────────────────────────────────────────────────────────
  step "5/7 docker compose build + up"
  docker compose build --quiet
  docker compose up -d --remove-orphans

  # ── 6. health + migrations ────────────────────────────────────────────────
  step "6/7 health checks"
  local entry url limit
  for entry in $health_urls; do
    url="${entry%=*}"; limit="${entry##*=}"
    wait_healthy "$url" "$limit"
  done
  echo "    migrations (already applied at container start; this verifies them)"
  docker compose exec -T smart-cam-backend npx sequelize-cli db:migrate
  docker compose exec -T smart-cam-ai alembic upgrade head

  # ── 7. record ─────────────────────────────────────────────────────────────
  step "7/7 record deployed version"
  local finished; finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'sha=%s\nsubject=%s\ndeployed_at=%s\nactor=%s\nprevious=%s\n' \
    "$sha" "$(git log -1 --format=%s "$sha")" "$finished" "$actor" "$prev" \
    > "$state_dir/last-deployed"
  printf '%s OK     %s by %s (was %s)\n' "$finished" "$sha" "$actor" "$prev" >> "$state_dir/history.log"
  trap - ERR
  echo
  echo "✔ deployed $sha"
}

step() { printf '\n==> %s\n' "$*"; }
err()  { printf '✖ %s\n' "$*" >&2; }

on_fail() {
  local sha="$1" started="$2" actor="$3" state_dir="$4"
  printf '%s FAILED %s by %s (started %s)\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${sha:-?}" "$actor" "$started" >> "$state_dir/history.log" || true
  err "deploy FAILED. The checkout is left at ${sha:-its previous commit} for inspection."
  err "Logs: docker compose logs --since 15m <service>. Roll back: redeploy the last good SHA."
}

# Dump both databases before migrations can touch them. They are small (MBs).
backup() {
  local root="$1" sha="$2" keep="$3"
  local dir; dir="$root/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}"
  mkdir -p "$dir"
  docker compose exec -T mysql sh -c \
    'exec mysqldump -uroot ${MYSQL_ROOT_PASSWORD:+-p"$MYSQL_ROOT_PASSWORD"} --single-transaction --routines --triggers drishyamvms' \
    | gzip > "$dir/mysql-drishyamvms.sql.gz"
  docker compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -Fc vms_face' \
    > "$dir/postgres-vms_face.dump"
  echo "    $dir ($(du -sh "$dir" | cut -f1))"
  # Keep the newest $keep backup dirs.
  ls -1dt "$root"/*/ 2>/dev/null | tail -n +"$((keep + 1))" | xargs -r rm -rf --
}

wait_healthy() {
  local url="$1" limit="$2" waited=0
  until curl -fsS -o /dev/null --max-time 5 "$url"; do
    if (( waited >= limit )); then
      err "unhealthy after ${limit}s: $url"
      return 1
    fi
    sleep 5; waited=$((waited + 5))
  done
  echo "    ok  $url  (${waited}s)"
}

main "$@"
exit $?
