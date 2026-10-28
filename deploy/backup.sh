#!/bin/sh
set -eu
umask 077
: "${REDPILOT_RUNTIME_DIR:?请指定运行目录}"
: "${REDPILOT_BACKUP_DIR:?请指定备份目录}"
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$REDPILOT_BACKUP_DIR"
chown 1000:1000 "$REDPILOT_BACKUP_DIR"
backup_dir="$REDPILOT_BACKUP_DIR/redpilot-$(date -u +%Y%m%dT%H%M%SZ)"
# Stop both the application and browser before copying their databases.
docker compose -f "$project_dir/deploy/compose.yaml" stop redpilot
restart() { docker compose -f "$project_dir/deploy/compose.yaml" start redpilot; }
trap restart EXIT
docker compose -f "$project_dir/deploy/compose.yaml" run --rm --no-deps --entrypoint node -v "$REDPILOT_BACKUP_DIR:/backups" redpilot scripts/runtime-backup.mjs create --runtime /data --output "/backups/$(basename -- "$backup_dir")"
docker compose -f "$project_dir/deploy/compose.yaml" run --rm --no-deps --entrypoint node -v "$REDPILOT_BACKUP_DIR:/backups" redpilot scripts/prune-backups.mjs --directory /backups --keep 7
