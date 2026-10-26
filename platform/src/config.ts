function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required. Run ops/setup.sh before starting.`);
  return value;
}
const publicURL = required('PUBLIC_URL').replace(/\/$/, '');
const u = new URL(publicURL);
if (process.env.NODE_ENV === 'production' && u.protocol !== 'https:')
  throw new Error('Production PUBLIC_URL must use HTTPS');
const authSecret = required('BETTER_AUTH_SECRET');
if (authSecret.length < 32)
  throw new Error('BETTER_AUTH_SECRET must be at least 32 random characters');
export const config = {
  publicURL,
  databaseURL: required('DATABASE_URL'),
  authDatabaseURL: required('AUTH_DATABASE_URL'),
  workerDatabaseURL: process.env.WORKER_DATABASE_URL || '',
  authSecret,
  deepseekKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  sonioxKey: process.env.SONIOX_API_KEY || '',
  sonioxModel: process.env.SONIOX_MODEL || 'stt-rt-v5',
  voiceDailyLimit: Number(process.env.VOICE_DAILY_LIMIT || 20),
  mapboxPublicToken: process.env.MAPBOX_PUBLIC_TOKEN || '',
  routingURL: process.env.ROUTING_BASE_URL || '',
  opsToken: required('OPS_TOKEN'),
  aiDailyLimit: Number(process.env.AI_DAILY_LIMIT || 20),
  port: Number(process.env.PORT || 3000),
  smtpURL: process.env.SMTP_URL || '',
  emailFrom: process.env.EMAIL_FROM || '',
  signupEnabled: process.env.DISABLE_SIGNUP !== 'true',
  razorpayKey: process.env.RAZORPAY_KEY_ID || '',
  razorpaySecret: process.env.RAZORPAY_KEY_SECRET || '',
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  razorpayPlanID: process.env.RAZORPAY_PLAN_ID || '',
  consoleRoot: process.env.CONSOLE_ROOT || '../console/dist',
  adminUserIDs: (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  mediaRoot: process.env.MEDIA_ROOT || './media',
  publicationSigningPrivateKey: (process.env.PUBLICATION_SIGNING_PRIVATE_KEY || '').replace(
    /\\n/g,
    '\n',
  ),
  publicationSigningKeyID: process.env.PUBLICATION_SIGNING_KEY_ID || '',
  publicationTrustedKeysJSON: process.env.PUBLICATION_TRUSTED_KEYS_JSON || '{}',
  publicationRevokedKeyIDs: process.env.PUBLICATION_REVOKED_KEY_IDS || '',
};
if (config.opsToken.length < 32) throw new Error('OPS_TOKEN must be at least 32 random characters');
if (!Number.isSafeInteger(config.voiceDailyLimit) || config.voiceDailyLimit < 1 || config.voiceDailyLimit > 200)
  throw new Error('VOICE_DAILY_LIMIT must be an integer between 1 and 200');
if (!/^stt-rt-[a-z0-9][a-z0-9._-]{0,60}$/.test(config.sonioxModel))
  throw new Error('SONIOX_MODEL must name a real-time speech model');
