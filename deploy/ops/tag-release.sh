#!/usr/bin/env bash
#
# Stamp the images that are RUNNING RIGHT NOW with the commit they were built
# from, so there is something to roll back to.
#
#   sudo bash /opt/ems/deploy/ops/tag-release.sh
#
# WHY THIS EXISTS
# ---------------
# A deploy is `docker compose up -d --build`, which overwrites `:latest` in
# place. Until this script existed, the previous build had no name — so "put
# yesterday's version back" meant checking out an old commit and rebuilding,
# which is 6-10 minutes of downtime, needs the network and the package index to
# cooperate, and has never once been rehearsed. That is not a rollback, it is a
# hope.
#
# Four `rollback-*` tags were on the VM from an ad-hoc session, none newer than
# four days, and none for the release actually serving traffic. Tagging that
# happens when someone remembers is tagging that is absent on the day it counts.
#
# WHAT IT TAGS
# ------------
# The image ID the running container is USING — not `:latest`, and not a fresh
# build of the current source. Those three can differ, and the only one that
# matters is what is serving requests. `:latest` in particular is a moving
# pointer; a container started before the last build is still running the older
# layers regardless of what `:latest` now means.
#
# It also records a manifest per release: the commit, the subject line, the
# image IDs, and — the part that matters for a rollback decision — the Alembic
# revision the database was at. Code can be moved backwards in seconds. Schema
# cannot. Knowing which migration a release ran against is the difference
# between an informed rollback and a guess.
set -uo pipefail

RELEASE_DIR="${RELEASE_DIR:-/opt/ems-releases}"
EMS_DIR="${EMS_DIR:-/opt/ems}"
KEEP="${KEEP:-10}"

log()  { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) tag-release: $*"; }
fail() { log "FAIL: $*"; exit 1; }

# service name -> compose image repository. Only services built from this
# source tree; redis/rabbitmq/certbot are upstream images pinned by tag and
# roll back by themselves.
SERVICES="ems_backend ems_nginx ems_celery_worker ems_celery_beat"

command -v docker >/dev/null || fail "docker not found"
[ -d "$EMS_DIR/.git" ] || fail "$EMS_DIR is not a git checkout"

SHA=$(git -C "$EMS_DIR" rev-parse --short HEAD 2>/dev/null) || fail "cannot read git HEAD"
SUBJECT=$(git -C "$EMS_DIR" log -1 --pretty=%s 2>/dev/null)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$RELEASE_DIR" || fail "cannot create $RELEASE_DIR"

# ── The Alembic revision this release is running against ────────────────────
# Best-effort: a release is still worth tagging if the backend is unhealthy —
# arguably more so.
DB_REV=$(docker exec ems_backend python -m alembic current 2>/dev/null \
         | grep -oE '^[0-9a-f]{12}' | head -1)
[ -n "${DB_REV:-}" ] || DB_REV="unknown"

# ── Tag what is actually running ────────────────────────────────────────────
entries=""
tagged=0
for svc in $SERVICES; do
  if ! docker inspect "$svc" >/dev/null 2>&1; then
    log "WARN  $svc is not running — not tagged"
    continue
  fi
  img_id=$(docker inspect "$svc" --format '{{.Image}}' 2>/dev/null | cut -c1-19)
  [ -n "$img_id" ] || { log "WARN  $svc has no image id — not tagged"; continue; }

  repo="ems-$svc"
  if ! docker tag "$img_id" "$repo:release-$SHA" 2>/dev/null; then
    log "WARN  could not tag $svc ($img_id)"
    continue
  fi
  short=$(echo "$img_id" | sed 's/^sha256://' | cut -c1-12)
  log "tagged $repo:release-$SHA -> $short"
  entries="${entries}    \"$svc\": {\"image\": \"$repo:release-$SHA\", \"id\": \"$short\"},
"
  tagged=$((tagged+1))
done

[ "$tagged" -gt 0 ] || fail "nothing was tagged — no application containers are running"
if [ "$tagged" -lt 4 ]; then
  log "WARN  only $tagged of 4 services tagged; a rollback to $SHA will be incomplete"
fi

# ── Manifest ────────────────────────────────────────────────────────────────
manifest="$RELEASE_DIR/${STAMP}-${SHA}.json"
{
  echo "{"
  echo "  \"sha\": \"$SHA\","
  echo "  \"subject\": \"$(echo "$SUBJECT" | sed 's/\\/\\\\/g; s/"/\\"/g')\","
  echo "  \"tagged_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"alembic_revision\": \"$DB_REV\","
  echo "  \"services_tagged\": $tagged,"
  echo "  \"images\": {"
  echo "$entries" | sed '/^$/d' | sed '$ s/,$//'
  echo "  }"
  echo "}"
} > "$manifest" || fail "could not write $manifest"
log "manifest $manifest (alembic $DB_REV)"

# ── Retention ───────────────────────────────────────────────────────────────
# Manifests are tiny; the images behind them are not. Keeping the newest $KEEP
# manifests bounds the directory, but note the weekly `docker image prune -af
# --filter until=720h` is what actually reclaims the images — a manifest older
# than 30 days may name images that are gone. rollback.sh checks for that
# rather than trusting the manifest.
count=$(ls -1 "$RELEASE_DIR"/*.json 2>/dev/null | wc -l)
if [ "$count" -gt "$KEEP" ]; then
  ls -1t "$RELEASE_DIR"/*.json | tail -n +$((KEEP+1)) | while read -r old; do
    log "pruning old manifest $(basename "$old")"
    rm -f "$old"
  done
fi

log "OK: release $SHA tagged ($tagged services) — rollback.sh --list to confirm"
exit 0
