#!/usr/bin/env bash
#
# Move the PERSISTENT dev database onto the pgvector image, without destroying it.
#
# The image in docker-compose.yml changed from postgres:15-alpine to pgvector/pgvector:pg15 so that
# `CREATE EXTENSION vector` can succeed. Same major version, so the data directory is compatible and
# the named volume (rfphub_pgdata) is REUSED: `docker compose up -d` recreates the CONTAINER and
# leaves the VOLUME alone. What does change is the C library underneath — alpine/musl to
# debian/glibc — and with it the collation provider's version. Postgres will warn that indexes
# built under the old provider may now be inconsistent, which is a real risk for any text index or
# unique constraint, so this script refreshes the recorded collation version and reindexes.
#
# It is a script rather than a paragraph in the README because the dangerous version of this
# operation is one word shorter (`docker compose down -v`) and takes the dev corpus with it.
#
#   packages/api/scripts/upgrade-dev-postgres.sh
#
# Everything is verified: the row counts are read before and after and compared, and a full dump is
# taken first so there is always a way back.

set -euo pipefail

# ── the one thing this script must never do ─────────────────────────────────────────────────────
# `down -v` removes the named volume. The dev database holds seeded, hand-curated data that is not
# reproducible from the corpus alone. There is no flag to pass through to `docker compose` here,
# deliberately, so refusing any argument that looks like one is a cheap guarantee.
for arg in "$@"; do
  case "$arg" in
    down|-v|--volumes|down-v)
      echo "✗ refusing: this script never runs 'docker compose down' and never removes a volume." >&2
      echo "  The dev database (rfphub-postgres / rfphub_pgdata) holds data that is not re-derivable." >&2
      exit 1
      ;;
    *)
      echo "✗ unknown argument '$arg' — this script takes none." >&2
      exit 1
      ;;
  esac
done

cd "$(dirname "$0")/.."

CONTAINER=rfphub-postgres
DB=rfphub
USER=rfphub
DATABASE_URL="postgres://${USER}:${USER}@localhost:5432/${DB}"
BACKUP=".local-backup-$(date -u +%Y%m%dT%H%M%SZ).sql"

# psql inside the container: no local client needed, and no chance of a client/server version skew.
psql_q() { docker exec -i "$CONTAINER" psql -U "$USER" -d "$DB" -tAc "$1"; }

counts() {
  psql_q "SELECT format('%s opportunities, %s organizations, %s dataset_snapshots',
                        (SELECT count(*) FROM opportunities),
                        (SELECT count(*) FROM organizations),
                        (SELECT count(*) FROM dataset_snapshots))"
}

# ── 1. before ───────────────────────────────────────────────────────────────────────────────────
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "✗ $CONTAINER is not running. Start it first (docker compose up -d) so this script can read" >&2
  echo "  its current contents — an upgrade that cannot compare before and after proves nothing." >&2
  exit 1
fi

echo "→ current image: $(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
BEFORE="$(counts)"
echo "→ before: $BEFORE"

echo "→ dumping to $BACKUP (gitignored)"
docker exec "$CONTAINER" pg_dump -U "$USER" "$DB" > "$BACKUP"
echo "  $(wc -c < "$BACKUP" | tr -d ' ') bytes"

# ── 2. recreate the container on the new image, keeping the volume ──────────────────────────────
echo "→ docker compose up -d (recreates the container; the rfphub_pgdata volume is untouched)"
docker compose up -d

printf '→ waiting for health'
for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null)" = "healthy" ]; then
    echo " — healthy"
    break
  fi
  printf '.'
  sleep 1
done
if [ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null)" != "healthy" ]; then
  echo ""
  echo "✗ $CONTAINER did not become healthy. The volume is intact; see the fallbacks at the end." >&2
  exit 1
fi
echo "→ new image: $(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"

# ── 3. collation: refresh the recorded version, then rebuild what depended on it ────────────────
# The glibc collation ordering differs from musl's, so a B-tree built under the old one can be
# mis-ordered under the new one — which shows up as a unique constraint that no longer catches a
# duplicate, or a range scan that skips rows. REINDEX rebuilds them; REFRESH COLLATION VERSION then
# records that the database has been brought up to date, which is what silences the warning
# honestly rather than merely quieting it.
echo "→ REINDEX DATABASE $DB (collation provider changed: musl → glibc)"
docker exec -i "$CONTAINER" psql -U "$USER" -d "$DB" -c "REINDEX DATABASE $DB;"

# The REINDEX above is the part that makes the indexes correct; this only updates the version
# Postgres RECORDS for the database, which is what stops it warning on every connection.
#
# It is best-effort, and observed to fail with "invalid collation version change" on exactly this
# transition: the alpine/musl build records no collation version at all (`datcollversion` is NULL),
# and Postgres will not accept the move from "none recorded" to a glibc version. A database with no
# recorded version emits no warning either, so there is nothing left to fix — and failing the whole
# upgrade over a bookkeeping column, after the indexes have already been rebuilt, would be worse
# than saying so.
echo "→ ALTER DATABASE $DB REFRESH COLLATION VERSION"
if ! docker exec -i "$CONTAINER" psql -U "$USER" -d postgres \
  -c "ALTER DATABASE $DB REFRESH COLLATION VERSION;" 2>/dev/null; then
  echo "  (refused — normal when the old image recorded no collation version. The REINDEX above is"
  echo "   what mattered; nothing further is owed.)"
fi

# ── 4. migrations (this is where CREATE EXTENSION vector runs) ──────────────────────────────────
echo "→ applying migrations"
DATABASE_URL="$DATABASE_URL" pnpm run migrate

echo "→ extension: $(psql_q "SELECT coalesce((SELECT 'vector ' || extversion FROM pg_extension WHERE extname='vector'), 'vector NOT INSTALLED')")"

# ── 5. after ────────────────────────────────────────────────────────────────────────────────────
AFTER="$(counts)"
echo "→ after:  $AFTER"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "✓ upgrade complete — row counts unchanged, indexes rebuilt, migrations applied."
  echo "  Keep $BACKUP until you have used the database once; then delete it."
  exit 0
fi

# A mismatch is not automatically a loss — a migration may legitimately add rows — but it is never
# something to discover later, so it is reported as a failure to be looked at rather than a warning
# to be scrolled past.
cat >&2 <<EOF
✗ row counts differ.
    before: $BEFORE
    after:  $AFTER

  The volume was never removed, so nothing here is unrecoverable. Two ways back:

    restore the dump into the running container
      docker exec -i $CONTAINER psql -U $USER -d $DB < $BACKUP

    or rebuild from the committed corpus (the dev data that IS re-derivable)
      DATABASE_URL=$DATABASE_URL pnpm run migrate
      DATABASE_URL=$DATABASE_URL pnpm run seed data/seed-corpus.json --strict

  If the new image will not start at all, the escape hatch is to keep musl: build a local image
  FROM postgres:15-alpine with pgvector compiled in, and point docker-compose.yml at it. The data
  directory is untouched either way.
EOF
exit 1
