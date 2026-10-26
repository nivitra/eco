#!/usr/bin/env bash
set -euo pipefail
test -s /etc/kulture-backup.env
test -x /opt/kulture/platform/ops/backup.sh
cat >/etc/systemd/system/kulture-backup.service <<'EOF'
[Unit]
Description=Kulture encrypted database and media backup (local artifact)
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/kulture/platform
EnvironmentFile=/etc/kulture-backup.env
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
UMask=0077
ExecStart=/usr/bin/flock -w 300 /run/lock/kulture-backup.lock /opt/kulture/platform/ops/backup.sh
TimeoutStartSec=1h
EOF
cat >/etc/systemd/system/kulture-backup.timer <<'EOF'
[Unit]
Description=Daily Kulture backup at 02:00 India time

[Timer]
OnCalendar=*-*-* 20:30:00 UTC
RandomizedDelaySec=60
Persistent=true
Unit=kulture-backup.service

[Install]
WantedBy=timers.target
EOF
cat >/etc/systemd/system/kulture-journal.service <<'EOF'
[Unit]
Description=Kulture encrypted retention and hold journal (local artifact)
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/kulture/platform
EnvironmentFile=/etc/kulture-backup.env
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
UMask=0077
ExecStart=/usr/bin/flock -w 300 /run/lock/kulture-backup.lock /opt/kulture/platform/ops/backup.sh --journal-only
TimeoutStartSec=15min
EOF
cat >/etc/systemd/system/kulture-journal.timer <<'EOF'
[Unit]
Description=Kulture retention journal every 15 minutes

[Timer]
OnCalendar=*:0/15
RandomizedDelaySec=30
Persistent=true
Unit=kulture-journal.service

[Install]
WantedBy=timers.target
EOF
systemd-analyze verify /etc/systemd/system/kulture-backup.service /etc/systemd/system/kulture-backup.timer /etc/systemd/system/kulture-journal.service /etc/systemd/system/kulture-journal.timer
systemctl daemon-reload
systemctl enable --now kulture-backup.timer kulture-journal.timer
systemctl list-timers 'kulture-*' --no-pager
