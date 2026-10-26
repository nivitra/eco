import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test(
  'real Better Auth recovery: trusted callback, expiry, atomic single use, new password and old-session revocation',
  { skip: process.env.RUN_DB_TESTS !== 'true' },
  async () => {
    const { betterAuth } = await import('better-auth');
    const { authOptions } = await import('../src/auth-options.js');
    const { authPool } = await import('../src/auth.js');
    const { pool, workerPool } = await import('../src/db.js');
    const { config } = await import('../src/config.js');
    const { app } = await import('../src/app.js');
    const outbound: Array<{ email: string; token: string; url: string }> = [];
    const options = authOptions(authPool);
    // Same production auth/session/password policy; only email delivery is intercepted locally.
    const recoveryAuth = betterAuth({
      ...options,
      logger: { disabled: true },
      emailAndPassword: {
        ...options.emailAndPassword,
        sendResetPassword: async ({ user, token, url }) => {
          outbound.push({ email: user.email, token, url });
        },
      },
      emailVerification: {
        ...options.emailVerification,
        sendOnSignUp: false,
        sendOnSignIn: false,
        sendVerificationEmail: async () => {},
      },
    });
    const suffix = randomUUID(),
      email = `recovery-${suffix}@example.test`,
      initialPassword = 'Initial-local-fixture-password!',
      recoveredPasswords = ['Recovered-local-fixture-A!', 'Recovered-local-fixture-B!'];
    const origin = new URL(config.publicURL).origin;
    const headers = {
      'Content-Type': 'application/json',
      Origin: origin,
      'X-Real-IP': `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4, 8)}::9`,
    };
    let fixtureRequest = 20;
    // Keep the production limiter enabled; independent fixture requests use distinct TEST-NET /64s (Better Auth intentionally groups IPv6 hosts by subnet).
    const authRequest = (path: string, body?: unknown, method = 'POST') =>
      recoveryAuth.handler(
        new Request(config.publicURL + '/api/auth' + path, {
          method,
          headers: {
            ...headers,
            'X-Real-IP': `2001:db8:${suffix.slice(0, 4)}:${((parseInt(suffix.slice(4, 8), 16) + fixtureRequest++) & 65535).toString(16)}::9`,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const protectedRequest = (token: string) =>
      app.request(config.publicURL + '/v1/me', { headers: { Authorization: 'Bearer ' + token } });
    const resetRequest = () =>
      authRequest('/request-password-reset', { email, redirectTo: config.publicURL + '/console/' });
    const signIn = (password: string) => authRequest('/sign-in/email', { email, password });
    let userID: string | undefined;
    try {
      assert.equal(
        options.emailAndPassword.revokeSessionsOnPasswordReset,
        true,
        'Production policy must revoke old sessions',
      );
      const signup = await authRequest('/sign-up/email', {
        name: 'Controlled recovery fixture',
        email,
        password: initialPassword,
      });
      assert.equal(signup.status, 200);
      userID = ((await signup.json()) as any).user.id;
      // Verification is a fixture prerequisite, not a simulated delivery of a real email.
      await authPool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [userID]);
      const first = await signIn(initialPassword),
        second = await signIn(initialPassword);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      const firstToken = first.headers.get('set-auth-token')!,
        secondToken = second.headers.get('set-auth-token')!;
      assert(firstToken && secondToken && firstToken !== secondToken);
      assert.equal((await protectedRequest(firstToken)).status, 200);
      assert.equal((await protectedRequest(secondToken)).status, 200);

      const untrusted = await authRequest('/request-password-reset', {
        email,
        redirectTo: 'https://unrelated.example/receive-token',
      });
      assert.equal(untrusted.status, 403);
      assert.equal(outbound.length, 0, 'Untrusted redirect must not issue a recovery email');
      const requested = await resetRequest();
      assert.equal(requested.status, 200);
      const knownBody = await requested.json();
      assert.equal(outbound.length, 1);
      const expired = outbound[0];
      assert.equal(expired.email, email);
      assert(expired.token.length >= 20);
      assert.equal(new URL(expired.url).origin, origin);
      const unknown = await authRequest('/request-password-reset', {
        email: `missing-${suffix}@example.test`,
        redirectTo: config.publicURL + '/console/',
      });
      assert.equal(unknown.status, 200);
      assert.deepEqual(await unknown.json(), knownBody);
      assert.equal(outbound.length, 1, 'No email is emitted for an unknown account');
      const redirect = await recoveryAuth.handler(new Request(expired.url, { headers }));
      assert.equal(redirect.status, 302);
      const returned = new URL(redirect.headers.get('location')!);
      assert.equal(returned.origin, origin);
      assert.equal(returned.pathname, '/console/');
      assert.equal(returned.searchParams.get('token'), expired.token);
      const expiration = await authPool.query(
        'UPDATE verification SET "expiresAt"=now()-interval \'1 minute\' WHERE value=$1 RETURNING id',
        [userID],
      );
      assert.equal(expiration.rowCount, 1, 'The real reset token is stored in the auth database');
      const expiredRedirect = await recoveryAuth.handler(new Request(expired.url, { headers }));
      assert.equal(expiredRedirect.status, 302);
      assert.equal(
        new URL(expiredRedirect.headers.get('location')!).searchParams.get('error'),
        'INVALID_TOKEN',
      );
      const expiredAttempt = await authRequest('/reset-password', {
        token: expired.token,
        newPassword: 'Expired-token-must-never-change!',
      });
      assert.equal(expiredAttempt.status, 400);
      assert.equal(((await expiredAttempt.json()) as any).code, 'INVALID_TOKEN');
      assert.equal(
        (await protectedRequest(firstToken)).status,
        200,
        'An invalid reset must not revoke a valid session',
      );
      const accountBefore = (
        await authPool.query(
          'SELECT password FROM account WHERE "userId"=$1 AND "providerId"=\'credential\'',
          [userID],
        )
      ).rows[0].password;

      assert.equal((await resetRequest()).status, 200);
      assert.equal(outbound.length, 2);
      const active = outbound[1];
      assert.notEqual(active.token, expired.token);
      const shortPassword = await authRequest('/reset-password', {
        token: active.token,
        newPassword: 'short',
      });
      assert.equal(
        shortPassword.status,
        400,
        'The shared password policy applies before consuming the reset token',
      );
      const attempts = await Promise.all(
        recoveredPasswords.map((newPassword) =>
          authRequest('/reset-password', { token: active.token, newPassword }),
        ),
      );
      const winner = attempts.findIndex((response) => response.status === 200);
      assert.notEqual(winner, -1);
      assert.deepEqual(
        attempts.map((r) => r.status).sort(),
        [200, 400],
        'Concurrent reset-token consumption must have exactly one winner',
      );
      const loserBody = (await attempts[1 - winner].json()) as any;
      assert.equal(loserBody.code, 'INVALID_TOKEN');
      const accountAfter = (
        await authPool.query(
          'SELECT password FROM account WHERE "userId"=$1 AND "providerId"=\'credential\'',
          [userID],
        )
      ).rows[0].password;
      assert.notEqual(accountAfter, accountBefore);
      assert.notEqual(
        accountAfter,
        recoveredPasswords[winner],
        'The stored credential remains a password hash',
      );
      assert.equal((await protectedRequest(firstToken)).status, 401);
      assert.equal((await protectedRequest(secondToken)).status, 401);
      assert.equal(
        Number(
          (await authPool.query('SELECT count(*) AS n FROM session WHERE "userId"=$1', [userID]))
            .rows[0].n,
        ),
        0,
        'Reset revokes every pre-existing session',
      );
      assert.equal((await signIn(initialPassword)).status, 401);
      assert.equal((await signIn(recoveredPasswords[1 - winner])).status, 401);
      const fresh = await signIn(recoveredPasswords[winner]);
      assert.equal(fresh.status, 200);
      assert.equal((await protectedRequest(fresh.headers.get('set-auth-token')!)).status, 200);
      const replay = await authRequest('/reset-password', {
        token: active.token,
        newPassword: 'Replay-must-never-change-password!',
      });
      assert.equal(replay.status, 400);
      assert.equal(((await replay.json()) as any).code, 'INVALID_TOKEN');
      assert.equal(
        (await protectedRequest(fresh.headers.get('set-auth-token')!)).status,
        200,
        'A used token cannot revoke a newer legitimate session',
      );
    } finally {
      if (userID) {
        await authPool.query('DELETE FROM verification WHERE value=$1', [userID]).catch(() => {});
        await authPool.query('DELETE FROM session WHERE "userId"=$1', [userID]).catch(() => {});
      }
      outbound.splice(0);
      await Promise.all([
        pool.end(),
        authPool.end(),
        ...(workerPool !== pool ? [workerPool.end()] : []),
      ]);
    }
  },
);
