#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --journal-only ]; }; then echo 'Usage: ops/backup.sh [--journal-only]' >&2; exit 1; fi
mkdir -p backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
base="backups/kulture-${stamp}"
worker_running=""
worker_ids=()
cleanup() {
  status=$?
  rm -f "$base.dump.part" "$base.media.tar.gz.part" "$base.retention.json.part"
  # Compose start traverses dependencies and can re-run old migrate/seed containers.
  # Resume only the exact containers that were running when this backup started.
  if [ "${#worker_ids[@]}" -gt 0 ]; then docker container start "${worker_ids[@]}" >/dev/null || { echo 'The backup could not restart the previously running worker; start it explicitly.' >&2; status=1; }; fi
  exit "$status"
}
trap cleanup EXIT
export_journal() {
  docker compose run --rm --no-deps -T --entrypoint node ops dist/scripts/retention-recovery.js export > "$base.retention.json.part"
  mv "$base.retention.json.part" "$base.retention.json"
  shasum -a 256 "$base.retention.json" > "$base.retention.sha256"
}
if [ "${1:-}" = --journal-only ]; then
  export_journal
  printf 'Retention journal + all hold/release records: %s.retention.json\nRotate this newer journal and its checksum to trusted encrypted off-host storage.\n' "$base"
  if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
    command -v age >/dev/null || { echo 'age is required when BACKUP_AGE_RECIPIENT is set.' >&2; exit 1; }
    tar -czf - "$base.retention.json" "$base.retention.sha256" | age -r "$BACKUP_AGE_RECIPIENT" -o "$base.retention.tar.gz.age"
  fi
  exit 0
fi
# Pause physical deletion while collecting the matched database and immutable objects.
worker_running="$(docker compose ps --status running -q worker)"
if [ -n "$worker_running" ]; then
  while IFS= read -r worker_id; do worker_ids+=("$worker_id"); done <<< "$worker_running"
fi
if [ -n "$worker_running" ]; then docker compose stop worker >/dev/null; fi
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$base.dump.part"
mv "$base.dump.part" "$base.dump"
docker compose run --rm --no-deps -T --entrypoint tar api -C /var/lib/kulture/media -czf - . > "$base.media.tar.gz.part"
mv "$base.media.tar.gz.part" "$base.media.tar.gz"
export_journal
python3 - "$base" <<'PY'
import json,sys
from pathlib import Path
base=Path(sys.argv[1])
Path(str(base)+'.manifest.json').write_text(json.dumps({'schemaVersion':2,'database':base.name+'.dump','media':base.name+'.media.tar.gz','retentionJournal':base.name+'.retention.json','retentionChecksum':base.name+'.retention.sha256','checksums':base.name+'.sha256','consistency':'Deletion worker paused; immutable media captured after database snapshot; journal and all holds exported in one read-only transaction. In-progress uploads may require retry.','excludes':['Publication private signing keys','Application environment credentials','Caddy certificates'],'recoveryEvidence':'Restore-check requires the latest separately rotated retention journal, not merely this historical copy. Replay and physical deletion must finish before any cutover.'},indent=2)+'\n')
PY
shasum -a 256 "$base.dump" "$base.media.tar.gz" "$base.retention.json" "$base.manifest.json" > "$base.sha256"
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null || { echo 'age is required when BACKUP_AGE_RECIPIENT is set.' >&2; exit 1; }
  tar -czf - "$base.dump" "$base.media.tar.gz" "$base.retention.json" "$base.retention.sha256" "$base.sha256" "$base.manifest.json" | age -r "$BACKUP_AGE_RECIPIENT" -o "$base.tar.gz.age"
  printf 'Encrypted off-host artifact ready: %s\n' "$base.tar.gz.age"
else
  printf '%s\n' 'Local backup is not encrypted. Encrypt and copy it to a separate host before treating it as disaster protection.'
fi
printf 'Database + media + retention snapshot: %s\n' "$base"
