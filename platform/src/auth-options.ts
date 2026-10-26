import type { BetterAuthOptions } from 'better-auth';
import type pg from 'pg';
import { bearer } from 'better-auth/plugins';
import nodemailer from 'nodemailer';
import { config } from './config.js';
const mailer = config.smtpURL ? nodemailer.createTransport(config.smtpURL) : null;
async function send(to: string, subject: string, url: string) {
  if (!mailer || !config.emailFrom) throw new Error('Email delivery is not configured');
  await mailer.sendMail({
    from: config.emailFrom,
    to,
    subject,
    text: `${subject}\n\n${url}\n\nIf you did not request this, ignore this message.`,
  });
}
export function authOptions(database: pg.Pool) {
  return {
    appName: 'Kulture',
    baseURL: config.publicURL,
    secret: config.authSecret,
    database,
    trustedOrigins: [config.publicURL],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !config.signupEnabled,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: !!mailer,
      revokeSessionsOnPasswordReset: true,
      ...(mailer
        ? {
            sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) =>
              send(user.email, 'Reset your Kulture password', url),
          }
        : {}),
    },
    ...(mailer
      ? {
          emailVerification: {
            sendOnSignUp: true,
            sendVerificationEmail: async ({
              user,
              url,
            }: {
              user: { email: string };
              url: string;
            }) => send(user.email, 'Verify your Kulture email', url),
          },
        }
      : {}),
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 60,
      customRules: {
        '/sign-in/email': { window: 60, max: 8 },
        '/sign-up/email': { window: 3600, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: new URL(config.publicURL).protocol === 'https:',
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
    },
    plugins: [bearer({ requireSignature: true })],
  } satisfies BetterAuthOptions;
}
