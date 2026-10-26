import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { api, type APIError, displayDate } from './api';
import { Button, Field, Status } from './ui';
import './admin.css';

type Claim = {
  id: string;
  tenantID: string;
  placeID: string;
  placeName: string;
  address: string;
  city: string;
  placeState: string;
  workspaceName: string;
  submittedBy: string;
  submitter: { name: string; email: string } | null;
  evidence: { description?: string; url?: string; [key: string]: unknown };
  state: string;
  submittedAt: string;
  reviewedAt: string | null;
  reviewReason: string | null;
};

function evidenceLink(raw?: string) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function AdminPage() {
  const [access, setAccess] = useState<'loading' | 'signin' | 'denied' | 'ready'>('loading');
  const [admin, setAdmin] = useState<{ name: string; email: string } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [filter, setFilter] = useState<'submitted' | 'all'>('submitted');
  const [claims, setClaims] = useState<Claim[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const requestSequence = useRef(0);

  const checkAccess = useCallback(async () => {
    setError('');
    try {
      const result = await api('/v1/admin/me');
      setAdmin(result.user);
      setAccess('ready');
    } catch (caught) {
      const e = caught as APIError;
      setAccess(e.status === 401 ? 'signin' : 'denied');
      if (e.status !== 401) setError(e.message);
    }
  }, []);

  const loadClaims = useCallback(
    async (offset = 0, append = false) => {
      const sequence = ++requestSequence.current;
      setBusy('load');
      setError('');
      try {
        const result = await api(
          `/v1/admin/claims?state=${filter}&offset=${offset}`,
        );
        if (sequence === requestSequence.current) {
          setClaims((previous) => (append ? [...previous, ...result.claims] : result.claims));
          setNextOffset(result.nextOffset ?? null);
        }
      } catch (caught) {
        if (sequence === requestSequence.current) setError((caught as Error).message);
      } finally {
        if (sequence === requestSequence.current) setBusy('');
      }
    },
    [filter],
  );

  useEffect(() => {
    void checkAccess();
  }, [checkAccess]);
  useEffect(() => {
    if (access === 'ready') void loadClaims();
  }, [access, loadClaims]);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy('signin');
    setError('');
    try {
      await api('/api/auth/sign-in/email', {
        method: 'POST',
        body: { email, password },
      });
      setPassword('');
      await checkAccess();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy('');
    }
  };

  const review = async (claim: Claim, decision: 'approved' | 'rejected') => {
    const reason = (reasons[claim.id] || '').trim();
    if (reason.length < 10) {
      setError('Enter a review reason of at least 10 characters.');
      return;
    }
    if (
      decision === 'approved' &&
      !window.confirm(`Approve ownership of ${claim.placeName} after independent verification?`)
    )
      return;
    setBusy(claim.id);
    setError('');
    setMessage('');
    try {
      await api(`/v1/admin/claims/${claim.id}/review`, {
        method: 'POST',
        body: { decision, reason },
      });
      setMessage(`${claim.placeName}: claim ${decision}.`);
      setReasons((previous) => ({ ...previous, [claim.id]: '' }));
      await loadClaims();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div>
          <span className="eyebrow">KULTURE</span>
          <h1>Claim review</h1>
          <p>Review ownership evidence for the exact business branch before approving.</p>
        </div>
        <a href="/console/" className="admin-console-link">
          <ArrowLeft size={16} /> Business console
        </a>
      </header>
      <main className="admin-main">
        {error && <p className="notice" role="alert">{error}</p>}
        {message && <p className="notice success" role="status">{message}</p>}
        {access === 'loading' && <p>Checking administrator access…</p>}
        {access === 'signin' && (
          <section className="panel admin-signin">
            <h2>Administrator sign in</h2>
            <p>Use an account explicitly authorized for claim review.</p>
            <form onSubmit={signIn}>
              <Field label="Email address">
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </Field>
              <Field label="Password">
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
              <Button type="submit" busy={busy === 'signin'}>Sign in</Button>
            </form>
          </section>
        )}
        {access === 'denied' && (
          <section className="panel admin-signin">
            <h2>Administrator access required</h2>
            <p>This account is not authorized to review claims.</p>
            <Button
              variant="secondary"
              onClick={async () => {
                await api('/api/auth/sign-out', { method: 'POST', body: {} });
                setAdmin(null);
                setAccess('signin');
                setError('');
              }}
            >
              Sign in with another account
            </Button>
          </section>
        )}
        {access === 'ready' && (
          <>
            <div className="admin-toolbar">
              <div className="segmented" aria-label="Claim status">
                <button className={filter === 'submitted' ? 'active' : ''} onClick={() => setFilter('submitted')}>
                  Pending
                </button>
                <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
                  All submissions
                </button>
              </div>
              <div className="actions">
                <span className="admin-account">{admin?.name} · {admin?.email}</span>
                <Button variant="secondary" busy={busy === 'load'} onClick={() => void loadClaims()}>
                  <RefreshCw size={15} /> Refresh
                </Button>
              </div>
            </div>
            {claims.length === 0 && busy !== 'load' && (
              <section className="panel admin-empty">
                <ShieldCheck size={26} />
                <h2>{filter === 'submitted' ? 'No pending claims' : 'No submissions yet'}</h2>
                <p>New business-owner submissions will appear here after they are sent.</p>
              </section>
            )}
            <div className="admin-claims">
              {claims.map((claim) => {
                const link = evidenceLink(claim.evidence?.url);
                return (
                  <article className="panel admin-claim" key={claim.id}>
                    <div className="admin-claim-head">
                      <div>
                        <span className="eyebrow">{claim.workspaceName}</span>
                        <h2>{claim.placeName}</h2>
                        <p>{claim.address} · {claim.city}</p>
                      </div>
                      <Status value={claim.state} />
                    </div>
                    {claim.evidence?.description?.startsWith('DEMO SUBMISSION ONLY') && (
                      <p className="notice" role="note">
                        Demo test submission. It does not establish ownership of this branch.
                      </p>
                    )}
                    <dl className="admin-claim-meta">
                      <div><dt>Submitted by</dt><dd>{claim.submitter?.name || claim.submittedBy}</dd></div>
                      <div><dt>Contact</dt><dd>{claim.submitter?.email || 'Unavailable'}</dd></div>
                      <div><dt>Submitted</dt><dd>{displayDate(claim.submittedAt)}</dd></div>
                      <div><dt>Location state</dt><dd>{claim.placeState}</dd></div>
                    </dl>
                    <div className="admin-evidence">
                      <h3>Ownership evidence</h3>
                      <p>{claim.evidence?.description || 'No description supplied.'}</p>
                      {link && <a href={link} target="_blank" rel="noopener noreferrer">Open supplied evidence link ↗</a>}
                    </div>
                    {claim.state === 'submitted' ? (
                      <div className="admin-review">
                        <Field label="Review reason (required)">
                          <textarea
                            rows={3}
                            value={reasons[claim.id] || ''}
                            onChange={(e) => setReasons((previous) => ({ ...previous, [claim.id]: e.target.value }))}
                            placeholder="Record the independent checks and decision."
                            minLength={10}
                            maxLength={2000}
                          />
                        </Field>
                        <div className="actions">
                          <Button
                            disabled={!!busy || (reasons[claim.id] || '').trim().length < 10}
                            busy={busy === claim.id}
                            onClick={() => void review(claim, 'approved')}
                          >
                            <Check size={15} /> Approve claim
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={!!busy || (reasons[claim.id] || '').trim().length < 10}
                            onClick={() => void review(claim, 'rejected')}
                          >
                            <X size={15} /> Reject claim
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="admin-reviewed">
                        Reviewed {displayDate(claim.reviewedAt)}. {claim.reviewReason || 'No reason recorded.'}
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
            {nextOffset !== null && (
              <Button variant="secondary" busy={busy === 'load'} onClick={() => void loadClaims(nextOffset, true)}>
                Load more submissions
              </Button>
            )}
          </>
        )}
      </main>
    </div>
  );
}
