#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
backup="${1:?Usage: ops/restore-check.sh snapshot.dump latest.retention.json latest.retention.sha256}"
journal="${2:?Supply the latest separately preserved retention journal}"
journal_checksums="${3:?Supply its trusted checksum file}"
[ "$#" -eq 3 ] || { echo 'Exactly a backup, current retention journal, and its checksum are required.' >&2; exit 1; }
[ -f "$backup" ] || { echo 'Backup does not exist'; exit 1; }
base="${backup%.dump}"
[ "$backup" != "$base" ] && [ -f "$base.media.tar.gz" ] && [ -f "$base.sha256" ] && [ -f "$base.retention.json" ] || { echo 'Matched database/media/journal archive and checksums are required.' >&2; exit 1; }
shasum -a 256 -c "$base.sha256"
journal_digest="$(python3 - "$journal" "$journal_checksums" "$base.retention.json" <<'PY'
import hashlib,json,re,sys
from pathlib import Path
latest,checks,old=map(Path,sys.argv[1:])
expected=[]
for line in checks.read_text().splitlines():
    match=re.fullmatch(r'([a-fA-F0-9]{64}) [ *](.+)',line)
    if match and Path(match[2]).name==latest.name:expected.append(match[1].lower())
data=latest.read_bytes();digest=hashlib.sha256(data).hexdigest()
if expected!=[digest]:raise SystemExit('Latest retention journal checksum is missing, ambiguous or mismatched')
a,b=json.loads(data),json.loads(old.read_bytes())
from datetime import datetime
if a.get('schemaVersion')!=1 or b.get('schemaVersion')!=1 or a.get('sourceDatabase')!=b.get('sourceDatabase'):raise SystemExit('Retention journal source/schema mismatch')
if datetime.fromisoformat(a['exportedAt'].replace('Z','+00:00'))<datetime.fromisoformat(b['exportedAt'].replace('Z','+00:00')) or int(a['highWaterSequence'])<int(b['highWaterSequence']):raise SystemExit('Supplied journal predates the backup; obtain the latest off-host journal')
print(digest)
PY
)"
umask 077
# Never targets the live database. Keep the isolated result for explicit operator review/cleanup.
restore_db="kulture_restore_$(date -u +%Y%m%d%H%M%S)_$(openssl rand -hex 4)"
restore_media="backups/$restore_db-media"
mkdir "$restore_media"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    printf 'Recovery did not complete. Do not expose this database.\n' > "$restore_media/QUARANTINED"
    printf 'Restore quarantined: database %s, files %s. No live database was replaced.\n' "$restore_db" "$restore_media" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
python3 - "$restore_media" "$restore_db" <<'PY'
import json,sys
from pathlib import Path
Path(sys.argv[1],'.kulture-restore.json').write_text(json.dumps({'schemaVersion':1,'database':sys.argv[2]})+'\n')
PY
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$restore_db"
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --exit-on-error' sh "$restore_db" < "$backup"
docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -c "SELECT count(*) AS places FROM places; SELECT count(*) AS migrations FROM schema_migrations;"' sh "$restore_db"
docker compose exec -T db sh -c 'psql -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -c "SELECT coalesce(jsonb_agg(jsonb_build_object('\''key'\'',derivative_key,'\''sha256'\'',sha256)), '\''[]'\''::jsonb) FROM public_media WHERE revoked_at IS NULL AND (valid_until IS NULL OR valid_until>now())"' sh "$restore_db" > "$restore_media/expected.json"
python3 - "$base.media.tar.gz" "$restore_media" <<'PY'
import hashlib,json,os,sys,tarfile
from pathlib import Path,PurePosixPath
archive,output=Path(sys.argv[1]),Path(sys.argv[2])
with tarfile.open(archive) as tar:
    members=tar.getmembers()
    if sum(m.size for m in members)>1024**4:raise SystemExit('Unexpected archive size')
    for m in members:
        p=PurePosixPath(m.name)
        if p.is_absolute() or '..' in p.parts or not(m.isfile() or m.isdir()):raise SystemExit('Unsafe archive entry')
        meaningful=[part for part in p.parts if part!='.']
        if meaningful and meaningful[0] not in ('private','derivatives'):raise SystemExit('Unexpected media archive root')
        # Replay runs without DAC override as this operator; archived node ownership must not survive.
        m.uid=os.getuid();m.gid=os.getgid();m.uname='';m.gname='';m.mode=0o700 if m.isdir() else 0o600
    tar.extractall(output,members=members)
expected=json.loads((output/'expected.json').read_text())
for asset in expected:
    key=PurePosixPath(asset['key'])
    if key.is_absolute() or '..' in key.parts:raise SystemExit('Unsafe restored storage key')
    path=output/key
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=asset['sha256']:raise SystemExit('Published media is missing or corrupt: '+str(key))
print(f'Verified {len(expected)} current public media objects against restored database hashes.')
PY
# Snapshot journal copied only after extraction; archive entries cannot overwrite the control files.
cp "$journal" "$restore_media/retention-replay.json"
restore_media_abs="$(cd "$restore_media" && pwd -P)"
# Run as the directory owner (often root on the VPS), preserving 0700/0600 backup permissions.
# Override the service's live media mount and use a second explicit isolated alias.
docker compose run --rm --no-deps -T --user "$(id -u):$(id -g)" \
  --volume "$restore_media_abs:/var/lib/kulture/media" --volume "$restore_media_abs:/restore-media" \
  --entrypoint node ops dist/scripts/retention-recovery.js replay \
  --database "$restore_db" --journal /restore-media/retention-replay.json --sha256 "$journal_digest" --media-root /restore-media > "$restore_media/retention-result.json.part"
mv "$restore_media/retention-result.json.part" "$restore_media/retention-result.json"
# Retention must preserve every approved public object, so check hashes again after physical cleanup.
python3 - "$restore_media" <<'PY'
import hashlib,json,sys
from pathlib import Path
root=Path(sys.argv[1]);result=json.loads((root/'retention-result.json').read_text())
if result.get('pendingFiles')!=0:raise SystemExit('Retention files remain pending')
for asset in json.loads((root/'expected.json').read_text()):
    path=root/asset['key']
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=asset['sha256']:raise SystemExit('Public media changed during retention replay')
(root/'RECOVERY-CHECKED').write_text('Database/media checks and supplied retention replay passed. Not an approval for production cutover.\n')
PY
printf 'Isolated recovery checks passed: database %s, media %s. Supplied retention journal replayed and physical cleanup complete. Review public content and hold reconciliation before cutover.\n' "$restore_db" "$restore_media"
printf 'After review, remove only this test database with: docker compose exec -T db sh -c '\''dropdb -U "$POSTGRES_USER" "$1"'\'' sh %s\n' "$restore_db"
printf 'Then remove only this extracted directory: %s\n' "$restore_media"
