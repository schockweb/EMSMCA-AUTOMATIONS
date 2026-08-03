#!/usr/bin/env bash
#
# Put a previous release back, without rebuilding anything.
#
#   sudo bash /opt/ems/deploy/ops/rollback.sh --list
#   sudo bash /opt/ems/deploy/ops/rollback.sh <short-sha>
#   sudo bash /opt/ems/deploy/ops/rollback.sh --previous
#
# WHY THIS EXISTS
# ---------------
# "Roll back" was, in practice, "check out an old commit and rebuild": six to
# ten minutes with the site down, dependent on the network, the package index
# and the Docker build cache all behaving, attempted for the first time during
# whatever incident made it necessary. This swaps the image tags instead, which
# takes about twenty seconds and needs no network at all.
#
# THE PART THAT IS NOT AUTOMATIC, AND CANNOT BE
# ---------------------------------------------
# Code rolls back. THE DATABASE DOES NOT. If migrations ran after the release
# you are returning to, the old code meets a schema it has never seen. Usually
# that is survivable here — nearly every migration in this project adds a
# column, a table or an index, and SQLAlchemy ignores columns its models do not
# declare. It is NOT survivable when a migration made a column NOT NULL, dropped
# or renamed one, or changed a type: the old code will insert rows the new
# constraint rejects, or select a column that no longer exists.
#
# So this script does not guess. It tells you exactly which migrations the
# database has that your target release does not know about, and makes you say
# so out loud with --accept-schema-drift. `alembic downgrade` is deliberately
# NOT wired in: automatic, unattended downgrades of a database holding patient
# records is a worse failure than the one being fixed.
set -uo pipefail

RELEASE_DIR="${RELEASE_DIR:-/opt/ems-releases}"
EMS_DIR="${EMS_DIR:-/opt/ems}"
SERVICES="ems_backend ems_nginx ems_celery_worker ems_celery_beat"
# https, and -k. nginx 301s every plain-HTTP request to the domain, so a probe
# of http://localhost/health returns 301 forever and a health check written
# against it can never pass — it would report a good rollback as a failed one.
# -k because the certificate is issued for portal.emsmca.co.za, not localhost;
# this is a liveness probe on the loopback interface, not an identity check.
HEALTH_URL="${HEALTH_URL:-https://localhost/health}"
CURL_OPTS="${CURL_OPTS:--sk}"

log()  { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) rollback: $*"; }
fail() { log "FAIL: $*"; exit 1; }

# This script lives inside the tree it is about to `git checkout`. Bash reads a
# script incrementally, from a file offset — so checking out a commit that
# predates this file (or merely changes its length) rewrites the bytes bash is
# still reading and execution continues at the wrong offset, in the middle of a
# different line. The failure is arbitrary, silent, and happens halfway through
# swapping production. Re-exec from a copy outside the tree first.
if [ -z "${EMS_ROLLBACK_DETACHED:-}" ]; then
  _self=$(readlink -f "$0" 2>/dev/null || echo "$0")
  case "$_self" in
    "$EMS_DIR"/*)
      _tmp=$(mktemp /tmp/ems-rollback.XXXXXX)
      cp "$_self" "$_tmp" && chmod +x "$_tmp" || fail "could not copy self to /tmp"
      EMS_ROLLBACK_DETACHED=1 exec bash "$_tmp" "$@"
      ;;
  esac
fi
[ -n "${EMS_ROLLBACK_DETACHED:-}" ] && trap 'rm -f "$0"' EXIT

ASSUME_YES=0
ACCEPT_DRIFT=0
TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --list|-l)             ACTION=list ;;
    --previous|-p)         TARGET=__previous__ ;;
    --yes|-y)              ASSUME_YES=1 ;;
    --accept-schema-drift) ACCEPT_DRIFT=1 ;;
    -h|--help)             sed -n '2,30p' "$0"; exit 0 ;;
    -*)                    fail "unknown option $1" ;;
    *)                     TARGET="$1" ;;
  esac
  shift
done

[ -d "$RELEASE_DIR" ] || fail "$RELEASE_DIR does not exist — no release has ever been tagged. Run tag-release.sh after your next deploy."

# ── Inventory ───────────────────────────────────────────────────────────────
# A manifest is a claim; the images are the fact. The weekly prune reclaims
# images older than 30 days, so a manifest can outlive what it names. Every
# listing states whether the images are STILL THERE, because finding that out
# during an incident is the worst possible time.
images_present_for() {
  local sha="$1" missing=0
  for svc in $SERVICES; do
    docker image inspect "ems-$svc:release-$sha" >/dev/null 2>&1 || missing=$((missing+1))
  done
  echo "$missing"
}

# Which release is ACTUALLY SERVING, determined from the image the backend
# container is running — not from git HEAD.
#
# The two diverge, and the first rehearsal proved it: after a rollback the
# checkout was detached at the old commit, `git checkout main` moved HEAD back
# to the new one, and the script then refused with "already on 4de5683" while
# production was still serving the OLD images. Git HEAD says what the disk
# holds. It says nothing about what is running.
#
# If two releases share an image ID — a build where nothing changed and Docker
# reused every layer — the newest manifest wins. They are the same bits, so it
# makes no practical difference.
running_release() {
  local img s rid
  img=$(docker inspect ems_backend --format '{{.Image}}' 2>/dev/null) || return 0
  [ -n "$img" ] || return 0
  for m in $(ls -1t "$RELEASE_DIR"/*.json 2>/dev/null); do
    s=$(grep -oP '"sha":\s*"\K[^"]+' "$m")
    rid=$(docker image inspect "ems-ems_backend:release-$s" --format '{{.Id}}' 2>/dev/null)
    if [ -n "$rid" ] && [ "$rid" = "$img" ]; then echo "$s"; return 0; fi
  done
}

list_releases() {
  local found=0
  printf '%-14s  %-9s  %-14s  %-8s  %s\n' "TAGGED (UTC)" "COMMIT" "ALEMBIC" "IMAGES" "SUBJECT"
  for m in $(ls -1t "$RELEASE_DIR"/*.json 2>/dev/null); do
    sha=$(grep -oP '"sha":\s*"\K[^"]+' "$m")
    rev=$(grep -oP '"alembic_revision":\s*"\K[^"]+' "$m")
    sub=$(grep -oP '"subject":\s*"\K[^"]+' "$m" | cut -c1-46)
    when=$(basename "$m" | cut -c1-13 | sed 's/T/ /')
    miss=$(images_present_for "$sha")
    if [ "$miss" -eq 0 ]; then state="present"; else state="GONE($miss)"; fi
    printf '%-14s  %-9s  %-14s  %-8s  %s\n' "$when" "$sha" "$rev" "$state" "$sub"
    found=$((found+1))
  done
  [ "$found" -gt 0 ] || echo "  (no releases tagged yet)"
  echo
  echo "Current checkout: $(git -C "$EMS_DIR" rev-parse --short HEAD 2>/dev/null) on $(git -C "$EMS_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  echo "ACTUALLY RUNNING: $(running_release || echo 'unrecognised image — not a tagged release')"
  echo "Database is at:   $(docker exec ems_backend python -m alembic current 2>/dev/null | grep -oE '^[0-9a-f]{12}' | head -1)"
}

if [ "${ACTION:-}" = "list" ] || [ -z "$TARGET" ]; then
  list_releases
  [ -z "$TARGET" ] && [ "${ACTION:-}" != "list" ] && { echo; echo "Give a commit to roll back to, or --previous."; }
  exit 0
fi

CURRENT_SHA=$(git -C "$EMS_DIR" rev-parse --short HEAD 2>/dev/null)

if [ "$TARGET" = "__previous__" ]; then
  # The newest tagged release that is not the one currently checked out.
  for m in $(ls -1t "$RELEASE_DIR"/*.json 2>/dev/null); do
    s=$(grep -oP '"sha":\s*"\K[^"]+' "$m")
    [ "$s" = "$CURRENT_SHA" ] && continue
    TARGET="$s"; break
  done
  [ "$TARGET" = "__previous__" ] && fail "no tagged release other than the current one ($CURRENT_SHA)"
  log "--previous resolves to $TARGET"
fi

MANIFEST=$(ls -1t "$RELEASE_DIR"/*-"$TARGET".json 2>/dev/null | head -1)
[ -n "$MANIFEST" ] || fail "no manifest for '$TARGET' — run with --list to see what is available"

TARGET_REV=$(grep -oP '"alembic_revision":\s*"\K[^"]+' "$MANIFEST")
TARGET_SUB=$(grep -oP '"subject":\s*"\K[^"]+' "$MANIFEST")

# ── Preconditions ───────────────────────────────────────────────────────────
RUNNING_SHA=$(running_release)
if [ "$TARGET" = "$CURRENT_SHA" ] && [ "$TARGET" = "${RUNNING_SHA:-}" ]; then
  fail "already on $TARGET — checkout and running images both"
fi
if [ "$TARGET" = "$CURRENT_SHA" ] && [ "$TARGET" != "${RUNNING_SHA:-}" ]; then
  log "checkout is already $TARGET but the RUNNING images are ${RUNNING_SHA:-unrecognised} — repointing them"
fi

missing=$(images_present_for "$TARGET")
if [ "$missing" -gt 0 ]; then
  log "$missing of 4 images for $TARGET are gone (pruned):"
  for svc in $SERVICES; do
    docker image inspect "ems-$svc:release-$TARGET" >/dev/null 2>&1 || echo "    missing: ems-$svc:release-$TARGET"
  done
  fail "cannot roll back to $TARGET without a rebuild. Pick a newer release, or redeploy that commit the slow way."
fi

# A deploy checkout should have no local edits. If it does, someone has been
# editing production by hand and `git checkout` is about to destroy that work.
# Untracked files (.env.prod, certs) are expected and are not touched.
dirty=$(git -C "$EMS_DIR" status --porcelain --untracked-files=no 2>/dev/null)
if [ -n "$dirty" ]; then
  log "the production checkout has uncommitted changes:"
  echo "$dirty" | sed 's/^/    /'
  fail "refusing to roll back over hand edits — commit, stash or discard them deliberately first"
fi

git -C "$EMS_DIR" cat-file -e "${TARGET}^{commit}" 2>/dev/null || fail "commit $TARGET is not in the local git history"

# ── Schema drift ────────────────────────────────────────────────────────────
DB_REV=$(docker exec ems_backend python -m alembic current 2>/dev/null | grep -oE '^[0-9a-f]{12}' | head -1)
DRIFT=""
if [ -n "${DB_REV:-}" ] && [ "$TARGET_REV" != "unknown" ] && [ "$DB_REV" != "$TARGET_REV" ]; then
  DRIFT=$(docker exec ems_backend python -m alembic history -r "${TARGET_REV}:${DB_REV}" 2>/dev/null \
          | grep -E '^[0-9a-f]{12}' | head -20)
fi

echo
echo "  ────────────────────────────────────────────────────────────────"
echo "   ROLLING BACK"
echo "     checkout at    $CURRENT_SHA"
echo "     images serving ${RUNNING_SHA:-unrecognised}"
echo "     to     $TARGET   $TARGET_SUB"
echo "     images already built — no rebuild, no network"
echo
if [ -n "$DRIFT" ]; then
  echo "   ⚠ THE DATABASE IS AHEAD OF THIS RELEASE"
  echo "     database at $DB_REV, release $TARGET ran against $TARGET_REV"
  echo "     migrations the old code has never seen:"
  echo "$DRIFT" | sed 's/^/       /'
  echo
  echo "     Additive migrations (new column/table/index) are safe: the old"
  echo "     models simply do not mention them. Dropped, renamed, retyped or"
  echo "     newly NOT NULL columns are NOT safe — read the migrations above"
  echo "     before continuing."
  echo
  if [ "$ACCEPT_DRIFT" -ne 1 ]; then
    echo "     Re-run with --accept-schema-drift once you have read them."
    echo "  ────────────────────────────────────────────────────────────────"
    exit 1
  fi
  echo "     --accept-schema-drift given; continuing."
else
  echo "   Schema: database and target release are both at $TARGET_REV — no drift."
fi
echo "  ────────────────────────────────────────────────────────────────"
echo

if [ "$ASSUME_YES" -ne 1 ]; then
  printf "Type the target commit (%s) to proceed: " "$TARGET"
  read -r confirm
  [ "$confirm" = "$TARGET" ] || fail "not confirmed"
fi

# ── Swap ────────────────────────────────────────────────────────────────────
# Record where we came from FIRST. A rollback that cannot itself be undone is
# a one-way door, and the forward release may be the one that was fine.
log "rolling forward point is $CURRENT_SHA (branch: $(git -C "$EMS_DIR" rev-parse --abbrev-ref HEAD))"
echo "$CURRENT_SHA" > "$RELEASE_DIR/.rolled-back-from"

# The tree, so bind-mounted config (nginx.conf, security-headers.conf) and the
# compose files themselves match the images. Rolling back only the images
# leaves the new nginx config in front of the old application.
git -C "$EMS_DIR" checkout --detach "$TARGET" --quiet || fail "git checkout $TARGET failed"
log "checkout now at $(git -C "$EMS_DIR" rev-parse --short HEAD) (detached)"

# Remember where :latest pointed. If the swap fails AFTER retagging, the tags
# name the target while the old containers are still serving — so the next
# routine `up -d` would quietly start the rolled-back code with nobody having
# asked for it. This happened on the first run: a failed compose step left
# :latest on 83bea1f with b2bd454 still running.
_saved=""
for svc in $SERVICES; do
  _id=$(docker image inspect "ems-$svc:latest" --format '{{.Id}}' 2>/dev/null)
  [ -n "${_id:-}" ] && _saved="$_saved $svc=$_id"
done
restore_tags() {
  local pair s i
  for pair in $_saved; do
    s=${pair%%=*}; i=${pair#*=}
    docker tag "$i" "ems-$s:latest" 2>/dev/null
  done
  log "restored :latest to the images that were serving before this attempt"
}

# Point the names compose builds to at the release images.
for svc in $SERVICES; do
  docker tag "ems-$svc:release-$TARGET" "ems-$svc:latest" || { restore_tags; fail "could not retag $svc"; }
done
log "image tags repointed to release-$TARGET"

cd "$EMS_DIR" || fail "cannot cd $EMS_DIR"

# docker-compose.worker.yml interpolates ${RABBITMQ_USER} and ${RABBITMQ_PASS}
# from the SHELL, not from env_file. Without them compose substitutes empty
# strings — and if rabbitmq is ever recreated in that state it comes up with
# blank credentials and every worker silently loses its broker. Compose only
# warns.
#
# Read them out; do NOT `. .env.prod`. That idiom is everywhere and it is wrong
# for this file: the values contain '$'. Sourcing it under `set -u` died on
# `line 2: $9: unbound variable`, and WITHOUT `set -u` it is worse — the shell
# would silently expand '$9' to nothing and export a truncated password, giving
# a broker that rejects every worker for a reason nothing reports. grep -oP
# takes the bytes literally, which is what backup-ems.sh already does.
for _v in RABBITMQ_USER RABBITMQ_PASS VITE_GOOGLE_MAPS_KEY; do
  _val=$(grep -oP "^${_v}=\K.*" "$EMS_DIR/.env.prod" 2>/dev/null)
  [ -n "${_val:-}" ] && export "$_v=$_val"
done
unset _v _val

# --no-build is the whole point: use the images we just pointed at, do not
# rebuild from the checked-out source (which would take minutes and could
# produce something subtly different from what was tested).
docker compose -f docker-compose.prod.yml   up -d --no-build || { restore_tags; fail "app stack did not come up"; }
docker compose -f docker-compose.worker.yml up -d --no-build || { restore_tags; fail "worker stack did not come up"; }

# nginx caches its upstream's IP from startup; recreating backend containers can
# move it, and every request then 502s while `docker ps` shows all healthy.
docker restart ems_nginx >/dev/null 2>&1 || log "WARN could not restart ems_nginx"

# ── Prove it ────────────────────────────────────────────────────────────────
log "waiting for health..."
ok=0
for i in $(seq 1 45); do
  code=$(curl $CURL_OPTS -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)
  if [ "$code" = "200" ]; then ok=1; log "healthy after ${i}s"; break; fi
  sleep 1
done

if [ "$ok" -ne 1 ]; then
  log "NOT HEALTHY after 45s (last HTTP code: ${code:-none})"
  docker compose -f docker-compose.prod.yml logs --tail=40 ems_backend 2>/dev/null | sed 's/^/    /'
  echo
  log "the rollback completed but the service is down. To go forward again:"
  log "  sudo git -C $EMS_DIR checkout main && sudo bash $0 --previous"
  exit 1
fi

echo
log "OK: production is running $TARGET"
log ""
log "The checkout is DETACHED at $TARGET. To go forward again, IN THIS ORDER:"
log "  sudo git -C $EMS_DIR checkout main && sudo git -C $EMS_DIR pull"
log "  sudo bash $EMS_DIR/deploy/ops/rollback.sh $CURRENT_SHA --yes"
log ""
log "The checkout must come first: this script may not exist at $TARGET, and"
log "restoring the branch alone changes only the disk — the OLD images keep"
log "serving until the second command repoints them."
exit 0
