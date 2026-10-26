import { useState } from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { api } from './api';
import { Button, Field, Panel } from './ui';
import type { Run } from './hooks';

export function Recovery({
  token,
  run,
  busy,
  onDone,
}: {
  token: string;
  run: Run;
  busy: string;
  onDone: () => void;
}) {
  const [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [complete, setComplete] = useState(false);
  return (
    <div className="workspace-start">
      <Panel
        title={complete ? 'Password updated' : 'Choose a new password'}
        subtitle={
          complete
            ? 'Your previous sessions have been signed out.'
            : 'This recovery link can only be used once.'
        }
      >
        {complete ? (
          <>
            <p className="notice success">
              <ShieldCheck size={18} />
              Your account is ready to sign in again.
            </p>
            <Button onClick={onDone}>
              Return to sign in
              <ArrowRight size={16} />
            </Button>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run('Reset password', async () => {
                if (password !== confirmation) throw new Error('The passwords do not match.');
                await api('/api/auth/reset-password', {
                  method: 'POST',
                  body: { token, newPassword: password },
                });
                setPassword('');
                setConfirmation('');
                setComplete(true);
                history.replaceState(null, '', location.pathname);
              });
            }}
          >
            <Field
              label="New password"
              hint="12–128 characters. Use a password unique to this account."
            >
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
            </Field>
            <Field label="Confirm new password">
              <input
                type="password"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
            </Field>
            <div className="actions">
              <Button type="submit" busy={!!busy} disabled={!password || password !== confirmation}>
                Update password
              </Button>
              <Button variant="ghost" type="button" onClick={onDone}>
                Back to sign in
              </Button>
            </div>
          </form>
        )}
      </Panel>
    </div>
  );
}
