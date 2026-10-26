#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo 'Run ops/setup.sh first.' >&2; exit 1; }
if rg -q '^PUBLICATION_SIGNING_PRIVATE_KEY=.' .env 2>/dev/null || grep -q '^PUBLICATION_SIGNING_PRIVATE_KEY=.' .env; then
  echo 'An active signing key already exists; use the documented rotation procedure.'; exit 0
fi
umask 077
mkdir -p .secrets
if command -v node >/dev/null; then
  node --input-type=module <<'JS'
import {generateKeyPairSync} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
writeFileSync('.secrets/publication-private.pem',privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
writeFileSync('.secrets/publication-public.pem',publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
JS
else
  openssl genpkey -algorithm ED25519 -out .secrets/publication-private.pem
  openssl pkey -in .secrets/publication-private.pem -pubout -out .secrets/publication-public.pem
fi
python3 - <<'PY'
import json,secrets
from pathlib import Path
p=Path('.env');text=p.read_text();names={'PUBLICATION_SIGNING_PRIVATE_KEY','PUBLICATION_SIGNING_KEY_ID','PUBLICATION_TRUSTED_KEYS_JSON','PUBLICATION_REVOKED_KEY_IDS'}
text='\n'.join(line for line in text.splitlines() if line.split('=',1)[0] not in names)+'\n'
kid='kulture-'+secrets.token_hex(6)
private=Path('.secrets/publication-private.pem').read_text().replace('\n','\\n')
public=Path('.secrets/publication-public.pem').read_text()
text+="PUBLICATION_SIGNING_PRIVATE_KEY='"+private+"'\nPUBLICATION_SIGNING_KEY_ID="+kid+"\nPUBLICATION_TRUSTED_KEYS_JSON='"+json.dumps({kid:public},separators=(',',':'))+"'\nPUBLICATION_REVOKED_KEY_IDS=\n"
p.write_text(text);p.chmod(0o600)
print('Created a private Ed25519 publication key and matching public keyring. No key material was printed.')
PY
