#!/usr/bin/env bash
# Nightly Postgres backup (custom format) into /opt/nanite/backups; keeps the newest 14.
# Cron: 15 3 * * * /opt/nanite/backup.sh >> /opt/nanite/backups/backup.log 2>&1
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/opt/nanite/backups}"
KEEP=14

mkdir -p "$BACKUP_DIR"
cd "$APP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp="$BACKUP_DIR/.nanite-$stamp.partial"
out="$BACKUP_DIR/nanite-$stamp.dump"
trap 'rm -f "$tmp"' EXIT

docker compose exec -T db pg_dump -U nanite -d nanite -Fc > "$tmp"
if [ ! -s "$tmp" ]; then
  echo "backup failed: empty dump" >&2
  exit 1
fi
chmod 600 "$tmp"
mv "$tmp" "$out"

# keep only the newest $KEEP dumps
ls -1t "$BACKUP_DIR"/nanite-*.dump | tail -n +$((KEEP + 1)) | xargs -r rm -f --

echo "$(date -u +%FT%TZ) backup ok: $(basename "$out") ($(du -h "$out" | cut -f1)), $(ls -1 "$BACKUP_DIR"/nanite-*.dump | wc -l) kept"
