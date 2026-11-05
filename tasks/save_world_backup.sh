#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORLD_DIR="$ROOT_DIR/minecraft-data/world"
BACKUP_DIR="$ROOT_DIR/minecraft_backups"
CONTAINER_NAME="mindcraft-minecraft-1"

usage() {
  echo "Usage:"
  echo "  $0 save <backup-name>"
  echo "  $0 restore <backup-name>"
  echo ""
  echo "Examples:"
  echo "  $0 save ender-dragon-before-fight"
  echo "  $0 restore ender-dragon-before-fight"
}

if [[ $# -ne 2 ]]; then
  usage
  exit 1
fi

operation="$1"
backup_name="$2"

if [[ "$backup_name" == *"/"* ]]; then
  echo "Backup name must not contain '/'" >&2
  exit 1
fi

if [[ "$backup_name" != *.zip ]]; then
  backup_name="${backup_name}.zip"
fi

backup_file="$BACKUP_DIR/$backup_name"
mkdir -p "$BACKUP_DIR"

ensure_autosave_on() {
  if docker ps --filter "name=^/${CONTAINER_NAME}$" --filter "status=running" --quiet | grep -q .; then
    if ! docker exec "$CONTAINER_NAME" rcon-cli save-on >/dev/null; then
      echo "Warning: failed to re-enable autosave in $CONTAINER_NAME" >&2
    fi
  fi
}

save_world() {
  if [[ ! -d "$WORLD_DIR" ]]; then
    echo "World directory not found: $WORLD_DIR" >&2
    exit 1
  fi

  if docker ps --filter "name=^/${CONTAINER_NAME}$" --filter "status=running" --quiet | grep -q .; then
    echo "Flushing world state via rcon-cli in $CONTAINER_NAME..."
    trap ensure_autosave_on EXIT
    docker exec "$CONTAINER_NAME" rcon-cli save-off
    docker exec "$CONTAINER_NAME" rcon-cli save-all flush
  fi

  echo "Creating backup: $backup_file"
  python - "$ROOT_DIR" "$backup_file" <<'PY'
import os
import sys
import zipfile

root_dir, out_file = sys.argv[1], sys.argv[2]
source = os.path.join(root_dir, "minecraft-data", "world")
with zipfile.ZipFile(out_file, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for current_root, _, files in os.walk(source):
        for name in files:
            full_path = os.path.join(current_root, name)
            rel_path = os.path.relpath(full_path, root_dir)
            zf.write(full_path, rel_path)
PY
  echo "Backup complete: $backup_file"
}

restore_world() {
  if [[ ! -f "$backup_file" ]]; then
    echo "Backup not found: $backup_file" >&2
    exit 1
  fi

  timestamp="$(date +%Y%m%d-%H%M%S)"
  echo "Stopping containers..."
  docker compose -f "$ROOT_DIR/docker-compose.yml" stop mindcraft minecraft >/dev/null 2>&1 || true

  if [[ -d "$WORLD_DIR" ]]; then
    mv "$WORLD_DIR" "$ROOT_DIR/minecraft-data/world.pre-restore-$timestamp"
  fi
  mkdir -p "$WORLD_DIR"

  echo "Restoring backup: $backup_file"
  python - "$backup_file" "$ROOT_DIR" "$WORLD_DIR" <<'PY'
import os
import sys
import zipfile

backup, root_dir, world_dir = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(backup) as zf:
    entries = [n for n in zf.namelist() if not n.endswith("/")]
    has_repo_layout = any(n.startswith("minecraft-data/world/") for n in entries)
    if has_repo_layout:
        zf.extractall(root_dir)
    else:
        zf.extractall(world_dir)
PY

  echo "Starting containers..."
  docker compose -f "$ROOT_DIR/docker-compose.yml" up -d minecraft mindcraft
  echo "Restore complete from: $backup_file"
}

case "$operation" in
  save) save_world ;;
  restore) restore_world ;;
  *)
    usage
    exit 1
    ;;
esac
