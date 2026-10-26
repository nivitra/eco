#!/usr/bin/env python3
"""Project the validated root photo feed onto existing app identities, image fields only."""
import argparse, hashlib, json
from pathlib import Path
PLATFORM = Path(__file__).resolve().parents[2]
REPO = PLATFORM.parent
TARGETS = [
 'native/iPhone/Edit3/KultureKit/Resources/jubilee-places.json',
 'native/Sources/KultureKit/Resources/jubilee-places.json',
 'app/src/main/assets/jubilee-places.json',
 'platform/data/places.json',
]
FIELDS = ['imageURL', 'imageSourceURL', 'imageCredit', 'imageRights']

def project(rows, images):
    from urllib.parse import urlsplit
    result=[]; added=[]
    for row in rows:
        photo=images.get(row['id'])
        if row.get('imageURL') or not photo:
            result.append(row);continue
        enriched={**row,'imageURL':photo['imageURL'],'imageSourceURL':photo['sourceURL'],
                  'imageCredit':'Photo source: '+urlsplit(photo['sourceURL']).hostname,
                  'imageRights':'source-preview-reuse-unverified'}
        assert {k:v for k,v in row.items() if k not in FIELDS} == {k:v for k,v in enriched.items() if k not in FIELDS}
        result.append(enriched);added.append(row['id'])
    assert [r['id'] for r in rows]==[r['id'] for r in result]
    return result,added

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true');parser.add_argument('--backup-dir',type=Path,required=True)
    args=parser.parse_args();feed=json.loads((PLATFORM/'data/place-images.json').read_text());assert feed['version']==1
    images={p['placeID']:p for p in feed['items']};assert len(images)==len(feed['items'])
    for p in images.values():
        assert p['downloadVerified'] and p['status']=='source-preview' and p['reusePermission']=='unverified'
        assert p['imageURL'].startswith('https://') and p['sourceURL'].startswith('https://')
    reports=[]
    for relative in TARGETS:
        target=REPO/relative;before=target.read_bytes();rows=json.loads(before);updated,added=project(rows,images)
        if args.apply and added:
            backup=args.backup_dir/relative;backup.parent.mkdir(parents=True,exist_ok=True)
            if not backup.exists():backup.write_bytes(before)
            temp=target.with_suffix('.json.tmp');temp.write_text(json.dumps(updated,indent=2,ensure_ascii=False)+'\n');temp.replace(target)
        reports.append({'target':relative,'records':len(rows),'photosBefore':sum(bool(r.get('imageURL')) for r in rows),
                        'photosAfter':sum(bool(r.get('imageURL')) for r in updated),'added':len(added),'nonImageFieldsPreserved':True,
                        'beforeSHA256':hashlib.sha256(before).hexdigest()})
    print(json.dumps({'applied':args.apply,'targets':reports},indent=2))
if __name__=='__main__':main()
