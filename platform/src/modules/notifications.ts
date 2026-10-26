import type { Hono } from 'hono';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { config } from '../config.js';
import { requireUser, authPool } from '../auth.js';
import { withActor, requireRole, HttpError, workerPool } from '../db.js';
const transport = config.smtpURL ? nodemailer.createTransport(config.smtpURL) : null;
export function registerNotifications(app: Hono) {
  app.get('/v1/tenants/:tenantID/notifications', async (c) => {
    const u = await requireUser(c),
      tid = z.uuid().parse(c.req.param('tenantID'));
    return c.json(
      await withActor(u.id, async (db) => {
        await requireRole(db, tid, ['owner', 'manager', 'editor', 'viewer']);
        return {
          notifications: (
            await db.query(
              'SELECT id,place_id AS "placeID",kind,title,body,created_at AS "createdAt",acknowledged_at AS "acknowledgedAt",email_state AS "emailState" FROM business_notifications WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',
              [tid],
            )
          ).rows,
        };
      }),
    );
  });
  app.post('/v1/tenants/:tenantID/notifications/:id/acknowledge', async (c) => {
    const u = await requireUser(c),
      tid = z.uuid().parse(c.req.param('tenantID')),
      id = z.uuid().parse(c.req.param('id'));
    return c.json(
      await withActor(u.id, async (db) => {
        await requireRole(db, tid, ['owner']);
        const r = await db.query(
          'UPDATE business_notifications SET acknowledged_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id',
          [tid, id],
        );
        if (!r.rowCount)
          throw new HttpError(404, 'notification_not_found', 'Notification not found');
        return { acknowledged: true };
      }),
    );
  });
}
export async function processNotification() {
  const n = (
    await workerPool.query(
      "UPDATE business_notifications SET next_attempt_at=now()+interval '10 minutes' WHERE id=(SELECT id FROM business_notifications WHERE email_state='pending' AND next_attempt_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",
    )
  ).rows[0];
  if (!n) return false;
  if (!transport || !config.emailFrom) {
    await workerPool.query(
      "UPDATE business_notifications SET email_state='unconfigured' WHERE id=$1",
      [n.id],
    );
    return true;
  }
  try {
    const owners = (
      await workerPool.query(
        "SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='owner' AND state='active'",
        [n.tenant_id],
      )
    ).rows;
    const recipients = (
      await authPool.query(
        'SELECT email FROM "user" WHERE id=ANY($1::text[]) AND "emailVerified"=true',
        [owners.map((r) => r.user_id)],
      )
    ).rows;
    if (!recipients.length) throw new Error('no_verified_recipient');
    for (const r of recipients)
      await transport.sendMail({
        from: config.emailFrom,
        to: r.email,
        subject: `Kulture: ${n.title}`,
        text: `${n.body}\n\nOpen your business console: ${config.publicURL}/console/\n\nThis is a service notice for your Kulture location.`,
      });
    await workerPool.query(
      "UPDATE business_notifications SET email_state='sent',email_attempts=email_attempts+1 WHERE id=$1",
      [n.id],
    );
  } catch {
    await workerPool.query(
      "UPDATE business_notifications SET email_attempts=email_attempts+1,email_state=CASE WHEN email_attempts>=4 THEN 'failed' ELSE 'pending' END,next_attempt_at=now()+interval '30 minutes' WHERE id=$1",
      [n.id],
    );
  }
  return true;
}
