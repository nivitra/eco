#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -e .env ]; then echo '.env exists; preserving your settings.'; exit 0; fi
umask 077
python3 - <<'PY'
import secrets
from pathlib import Path
s=lambda:secrets.token_hex(32)
admin,app,auth,worker=s(),s(),s(),s()
text=f'''# Replace localhost with your HTTPS domain for production. Keep this file private.
PUBLIC_URL=http://localhost:3000
DOMAIN=localhost
NODE_ENV=development
POSTGRES_DB=kulture
POSTGRES_USER=kulture_admin
POSTGRES_PASSWORD={admin}
APP_DB_PASSWORD={app}
AUTH_DB_PASSWORD={auth}
WORKER_DB_PASSWORD={worker}
ADMIN_DATABASE_URL=postgresql://kulture_admin:{admin}@db:5432/kulture
DATABASE_URL=postgresql://kulture_app:{app}@db:5432/kulture
AUTH_DATABASE_URL=postgresql://kulture_auth:{auth}@db:5432/kulture
WORKER_DATABASE_URL=postgresql://kulture_worker:{worker}@db:5432/kulture
BETTER_AUTH_SECRET={s()}
OPS_TOKEN={s()}
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-flash
AI_DAILY_LIMIT=20
ROUTING_BASE_URL=
SMTP_URL=
EMAIL_FROM=
DISABLE_SIGNUP=false
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
RAZORPAY_PLAN_ID=
'''
Path('.env').write_text(text)
PY
./ops/generate-signing-key.sh
printf '%s\n' 'Created private .env with separate database credentials. Set PUBLIC_URL and DOMAIN before public launch.'
