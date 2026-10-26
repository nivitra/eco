import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  Check,
  ChevronDown,
  Compass,
  CreditCard,
  FileCheck2,
  Globe,
  HelpCircle,
  Home,
  Image,
  Layers,
  LogOut,
  MapPin,
  Menu,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Users,
  X,
  Clock3,
  LoaderCircle,
  RefreshCw,
  Save,
  Bell,
  Activity,
} from 'lucide-react';
import { api, APIError, displayDate, emptyProfile, type Tenant, type Profile } from './api';
import { useResource, type Run } from './hooks';
import { Button, Panel, Field, Status, Empty, CheckLine, External } from './ui';
import { Facts, Offerings, Hours } from './facts';
import { Website } from './website';
import { Photos, Team, Billing, Settings, Visibility } from './manage';
import { useFactDraft } from './useFactDraft';
import { Recovery } from './Recovery';
import { actionSuccess } from './action-feedback';
import { MapEditor } from './maps/MapEditor';
const navigation = [
  ['home', 'Overview', Home],
  ['details', 'Business details', Building2],
  ['hours', 'Opening hours', Clock3],
  ['offerings', 'Products & services', Layers],
  ['website', 'Website', Globe],
  ['photos', 'Photos & evidence', Image],
  ['arrival', 'Entrance & directions', MapPin],
  ['review', 'Review & publish', FileCheck2],
  ['visibility', 'Visibility', Activity],
  ['team', 'Team & locations', Users],
  ['billing', 'Plan & billing', CreditCard],
  ['settings', 'Settings & help', Settings2],
] as const;
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Compass size={23} strokeWidth={1.35} />
      </span>
      <span>
        kulture<span className="brand-dot">.</span>
        <small>BUSINESS</small>
      </span>
    </div>
  );
}
function Auth({
  onAuthenticated,
  run,
  busy,
}: {
  onAuthenticated: () => void;
  run: Run;
  busy: string;
}) {
  const [mode, setMode] = useState('signin'),
    [name, setName] = useState(''),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [sent, setSent] = useState(false),
    capabilities = useResource('/v1/capabilities');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(
      mode === 'reset' ? 'Send recovery email' : mode === 'signup' ? 'Create account' : 'Sign in',
      async () => {
        if (mode === 'reset') {
          await api('/api/auth/request-password-reset', {
            method: 'POST',
            body: { email, redirectTo: location.origin + '/console/' },
          });
          setSent(true);
          return;
        }
        await api('/api/auth/' + (mode === 'signup' ? 'sign-up/email' : 'sign-in/email'), {
          method: 'POST',
          body: { email, password, ...(mode === 'signup' ? { name } : {}) },
        });
        onAuthenticated();
      },
    );
  };
  return (
    <div className="auth-layout">
      <section className="auth-story">
        <Brand />
        <div>
          <span className="eyebrow">KULTURE BUSINESS</span>
          <h1>
            Your business.
            <br />
            <em>Connected.</em>
          </h1>
          <p>
            Keep your business facts, website and
            <br />
            directions connected in one place.
          </p>
          <div className="auth-route">
            <span className="route-dot" />
            <div />
            <MapPin size={24} />
            <small>From discovery to your door.</small>
          </div>
        </div>
        <footer>Business details · Websites · Arrival guides</footer>
      </section>
      <section className="auth-form">
        <div>
          <span className="eyebrow">KULTURE BUSINESS</span>
          <h2>
            {mode === 'signup'
              ? 'Create your account'
              : mode === 'reset'
                ? 'Recover your account'
                : 'Welcome back'}
          </h2>
          <p>
            {mode === 'signup'
              ? 'Start with your business. Publish after review.'
              : 'Your business, ready for the next visit.'}
          </p>
          <form onSubmit={submit}>
            {mode === 'signup' && (
              <Field label="Your name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  required
                />
              </Field>
            )}
            <Field label="Email address">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </Field>
            {mode !== 'reset' && (
              <Field
                label="Password"
                hint={mode === 'signup' ? 'At least 12 characters.' : undefined}
              >
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  minLength={12}
                  maxLength={128}
                  required
                />
              </Field>
            )}
            <Button type="submit" busy={!!busy}>
              {mode === 'signup'
                ? 'Create account'
                : mode === 'reset'
                  ? 'Send recovery email'
                  : 'Continue'}
              <ArrowRight size={16} />
            </Button>
          </form>
          {sent && (
            <p className="notice success">
              If this address has an account, a recovery email will arrive shortly.
            </p>
          )}
          <div className="auth-switch">
            <button
              onClick={() => {
                setMode(mode === 'signup' ? 'signin' : 'signup');
                setSent(false);
              }}
            >
              {mode === 'signup'
                ? 'Already have an account? Sign in'
                : 'New to Kulture? Create an account'}
            </button>
            {capabilities.data?.email?.configured && mode !== 'reset' && (
              <button onClick={() => setMode('reset')}>Forgot password?</button>
            )}
          </div>
          <p className="auth-footnote">
            Consumer discovery is free. A maintained business location plan is ₹299/month, activated
            separately.
          </p>
        </div>
      </section>
    </div>
  );
}
function Onboarding({
  tenant,
  types,
  run,
  busy,
  onCreated,
}: {
  tenant: Tenant;
  types: any[];
  run: Run;
  busy: string;
  onCreated: (id: string) => void;
}) {
  const [mode, setMode] = useState('search'),
    [query, setQuery] = useState(''),
    [results, setResults] = useState<any[]>([]),
    [searchedQuery, setSearchedQuery] = useState<string | null>(null),
    [selected, setSelected] = useState<any>(null),
    [evidence, setEvidence] = useState(''),
    [profile, setProfile] = useState<Profile>(structuredClone(emptyProfile)),
    [duplicate, setDuplicate] = useState(false);
  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">START WITH THE RIGHT BRANCH</span>
        <h1>Add your business</h1>
        <p>Search before creating a new location. Every physical branch keeps one identity.</p>
      </div>
      <div className="segmented">
        <button className={mode === 'search' ? 'active' : ''} onClick={() => setMode('search')}>
          Find & claim
        </button>
        <button className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>
          Create a new location
        </button>
      </div>
      {mode === 'search' ? (
        <Panel title="Find your location">
          <form
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();
              run('Search locations', async () => {
                const requestedQuery = query.trim();
                const r = await api('/v1/locations/search?q=' + encodeURIComponent(requestedQuery));
                setResults(r.places);
                setSelected(null);
                setSearchedQuery(requestedQuery);
              });
            }}
          >
            <div className="search-input">
              <Search size={17} />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected(null);
                }}
                required
                placeholder="Business name, locality or address"
                minLength={2}
              />
            </div>
            <Button type="submit" busy={busy === 'Search locations'}>
              Search
            </Button>
          </form>
          {searchedQuery === query.trim() && results.length === 0 && (
            <p className="notice" role="status">
              No matching locations found. Try another name or address, or choose Create a new
              location.
            </p>
          )}
          {(searchedQuery === query.trim() ? results : []).map((p) => (
            <button
              className={`place-result ${selected?.id === p.id ? 'selected' : ''}`}
              key={p.id}
              onClick={() => setSelected(p)}
            >
              <MapPin size={19} />
              <div>
                <strong>{p.name}</strong>
                <p>
                  {p.address} · {p.city}
                </p>
              </div>
              {selected?.id === p.id && <Check size={18} />}
            </button>
          ))}
          {selected && (
            <div className="claim-form">
              <h3>Claim {selected.name}</h3>
              <Field
                label="How can we confirm your authority?"
                hint="Explain your role and provide an independently checkable business contact or official website. Do not paste identity numbers."
              >
                <textarea
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  rows={4}
                  minLength={30}
                />
              </Field>
              <Button
                disabled={evidence.length < 30}
                busy={busy === 'Submit ownership claim'}
                onClick={() =>
                  run('Submit ownership claim', async () => {
                    await api(`/v1/tenants/${tenant.id}/claims`, {
                      method: 'POST',
                      body: { placeID: selected.id, evidence: { description: evidence } },
                    });
                    onCreated(selected.id);
                  })
                }
              >
                Submit for review
              </Button>
            </div>
          )}
        </Panel>
      ) : (
        <>
          <Facts profile={profile} onChange={setProfile} types={types} />
          <Panel title="Authority & duplicate review">
            <Field label="Your authority to manage this location">
              <textarea
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
                rows={4}
                minLength={30}
              />
            </Field>
            <CheckLine checked={duplicate} onChange={setDuplicate}>
              If another location has the same name, I confirm this is a different physical branch.
            </CheckLine>
            <p className="hint">
              This starts a private draft. It is not public until ownership, facts, publication
              rights and the exact preview are approved.
            </p>
            <Button
              disabled={evidence.length < 30 || !profile.name}
              busy={busy === 'Create location'}
              onClick={() =>
                run('Create location', async () => {
                  const r = await api(`/v1/tenants/${tenant.id}/locations`, {
                    method: 'POST',
                    body: {
                      profile,
                      evidence: { description: evidence },
                      duplicateAcknowledged: duplicate,
                    },
                  });
                  onCreated(r.place.id);
                })
              }
            >
              Create private location draft
              <ArrowRight size={16} />
            </Button>
          </Panel>
        </>
      )}
    </>
  );
}
function Overview({
  detail,
  base,
  tenant,
  go,
}: {
  detail: any;
  base: string;
  tenant: Tenant;
  go: (screen: string) => void;
}) {
  const destinations = useResource(base + '/destinations'),
    arrival = useResource('/v1/places/' + detail.place.id + '/arrival'),
    entitlement = useResource(base + '/entitlement'),
    notifications = useResource(`/v1/tenants/${tenant.id}/notifications`),
    d = detail;
  const stages = [
    {
      n: '01',
      label: 'Confirm your business',
      detail:
        d.claim.state === 'approved'
          ? 'Ownership reviewed'
          : (d.claim.reviewReason ?? 'Ownership review is pending'),
      done: d.claim.state === 'approved',
      screen: 'details',
    },
    {
      n: '02',
      label: 'Make the facts useful',
      detail: d.draft
        ? `Draft ${d.draft.version} · ${d.draft.state}`
        : 'Add hours, offerings and contact details',
      done: !!d.draft,
      screen: 'details',
    },
    {
      n: '03',
      label: 'Publish with confidence',
      detail:
        d.latestPublication?.status === 'live'
          ? 'An approved page is live'
          : 'Review the exact page customers will see',
      done: d.latestPublication?.status === 'live',
      screen: 'review',
    },
    {
      n: '04',
      label: 'Guide them to your door',
      detail: arrival.data?.capability ?? 'Add entrance photos and directions',
      done: !!arrival.data?.route,
      screen: 'arrival',
    },
  ];
  return (
    <>
      <div className="overview-hero">
        <div>
          <span className="eyebrow">YOUR BUSINESS, CLEARLY FOUND</span>
          <h1>{d.place.name}</h1>
          <p>
            {d.place.neighborhood}
            {d.place.city ? ' · ' + d.place.city : ''}
          </p>
          <div className="actions">
            <Button onClick={() => go(d.claim.state === 'approved' ? 'review' : 'details')}>
              {d.claim.state === 'approved' ? 'Review your next update' : 'View business details'}
              <ArrowUpRight size={16} />
            </Button>
            <Button variant="ghost" onClick={() => go('arrival')}>
              Improve directions
              <ArrowRight size={15} />
            </Button>
          </div>
        </div>
        <div className="hero-compass" aria-hidden="true">
          <span />
          <span />
          <span />
          <MapPin size={38} strokeWidth={1.1} />
          <small>
            YOUR PLACE.
            <br />
            CONNECTED.
          </small>
        </div>
      </div>
      <div className="status-grid">
        <article>
          <ShieldCheck size={18} />
          <span>Business authority</span>
          <Status value={d.claim.state} />
        </article>
        <article>
          <Globe size={18} />
          <span>Website</span>
          <strong>
            {destinations.data?.destinations?.length
              ? `${destinations.data.destinations.length} connected destination${destinations.data.destinations.length > 1 ? 's' : ''}`
              : 'Choose a destination'}
          </strong>
        </article>
        <article>
          <MapPin size={18} />
          <span>Arrival guidance</span>
          <strong>
            {arrival.data?.route ? 'Reviewed route available' : 'Entrance not yet verified'}
          </strong>
        </article>
        <article>
          <CreditCard size={18} />
          <span>Location plan</span>
          <Status value={entitlement.data?.capabilities?.publish?.source ?? 'none'} />
        </article>
      </div>
      <div className="two-columns weighted">
        <Panel
          title="The next useful step"
          subtitle="A clear path from accurate facts to an easier visit."
        >
          {stages.map((s) => (
            <button className="setup-step" key={s.n} onClick={() => go(s.screen)}>
              <span className={s.done ? 'step-number complete' : 'step-number'}>
                {s.done ? <Check size={15} /> : s.n}
              </span>
              <div>
                <strong>{s.label}</strong>
                <p>{s.detail}</p>
              </div>
              <ArrowRight size={16} />
            </button>
          ))}
        </Panel>
        <Panel title="Publication record" subtitle="Your most recent approved change.">
          {d.latestPublication ? (
            <>
              <div className="publication-summary">
                <Status value={d.latestPublication.status} />
                <h3>Revision {d.latestPublication.revision}</h3>
                <p>
                  {displayDate(d.latestPublication.publishedAt ?? d.latestPublication.createdAt)}
                </p>
                <External href={d.latestPublication.publicURL}>Open published page</External>
              </div>
              {d.latestPublication.error && <p className="notice">{d.latestPublication.error}</p>}
            </>
          ) : (
            <Empty title="Ready when you are">
              Save your facts, review the rendered page, then explicitly approve publication.
            </Empty>
          )}
          <div className="small-principle">
            <ShieldCheck size={16} />
            <p>Ownership, fact quality, website access and payment each have their own status.</p>
          </div>
        </Panel>
      </div>
      {notifications.data?.notifications?.length > 0 && (
        <Panel title="Needs your attention">
          {notifications.data.notifications.slice(0, 5).map((n: any) => (
            <div className="record" key={n.id}>
              <div>
                <strong>{n.title}</strong>
                <p>{n.body}</p>
                <small>{displayDate(n.createdAt)}</small>
              </div>
              <Bell size={18} />
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}
export default function App() {
  const [resetToken, setResetToken] = useState(() =>
    new URLSearchParams(location.search).get('token'),
  );
  const [me, setMe] = useState<any>(null),
    [boot, setBoot] = useState(true),
    [tenantID, setTenantID] = useState(''),
    [placeID, setPlaceID] = useState(''),
    [screen, setScreen] = useState(() => {
      const wanted = new URLSearchParams(location.search).get('section');
      return navigation.some((n) => n[0] === wanted) ? wanted! : 'home';
    }),
    [busy, setBusy] = useState(''),
    [error, setError] = useState<{ message: string; code?: string; requestID?: string } | null>(
      () =>
        new URLSearchParams(location.search).get('error') === 'INVALID_TOKEN'
          ? {
              message:
                'This recovery link has expired or was already used. Request a new recovery email.',
            }
          : null,
    ),
    [success, setSuccess] = useState(''),
    [mobileMenu, setMobileMenu] = useState(false),
    [newLocation, setNewLocation] = useState(false),
    [workspaceName, setWorkspaceName] = useState('');
  const run: Run = useCallback(async (name, fn) => {
    setBusy(name);
    setError(null);
    setSuccess('');
    try {
      await fn();
      setSuccess(actionSuccess(name));
    } catch (e) {
      const err = e as APIError;
      setError({ message: err.message, code: err.code, requestID: err.requestID });
    } finally {
      setBusy('');
    }
  }, []);
  const loadMe = useCallback(async () => {
    try {
      const m = await api('/v1/me');
      setMe(m);
      setTenantID((t) => {
        const desired = t || new URLSearchParams(location.search).get('tenant');
        return m.tenants.some((v: Tenant) => v.id === desired)
          ? desired!
          : (m.tenants[0]?.id ?? '');
      });
    } catch (e) {
      if ((e as APIError).status === 401) setMe(null);
      else setError({ message: (e as Error).message });
    } finally {
      setBoot(false);
    }
  }, []);
  useEffect(() => {
    loadMe();
  }, [loadMe]);
  const tenant: Tenant | undefined = me?.tenants.find((t: Tenant) => t.id === tenantID),
    types = useResource('/v1/business-taxonomy'),
    capabilities = useResource('/v1/capabilities'),
    places = useResource(tenant ? `/v1/tenants/${tenant.id}/places` : null),
    base = tenant && placeID ? `/v1/tenants/${tenant.id}/places/${placeID}` : '',
    detail = useResource(base || null, true);
  useEffect(() => {
    if (places.data?.places) {
      setPlaceID((id) => {
        const desired = id || new URLSearchParams(location.search).get('place');
        return places.data.places.some((p: any) => p.id === desired)
          ? desired!
          : (places.data.places[0]?.id ?? '');
      });
    }
  }, [places.data]);
  const canEdit = !!tenant && ['owner', 'manager', 'editor'].includes(tenant.role),
    canPublish =
      !!tenant && (tenant.role === 'owner' || (tenant.role === 'manager' && tenant.canPublish)),
    canManage =
      !!tenant &&
      (tenant.role === 'owner' || (tenant.role === 'manager' && tenant.canManageDestinations));
  const facts = useFactDraft({
    scope:
      me && tenant && placeID ? `${location.origin}|${me.user.id}|${tenant.id}|${placeID}` : null,
    detail: detail.data,
    base,
    enabled: canEdit && detail.data?.claim?.state === 'approved',
    onError: (e) => setError({ message: e.message, code: (e as APIError).code }),
    onSaved: () => {
      detail.reload();
    },
  });
  const { profile, rights, dirty } = facts;
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(''), 5000);
    return () => clearTimeout(t);
  }, [success]);
  const setFacts = (p: Profile) => facts.setProfile(p),
    go = (s: string) => {
      setScreen(s);
      setMobileMenu(false);
    },
    changeLocation = async (id: string) => {
      if (dirty && !confirm('Keep unsynced edits in local recovery and switch locations?')) return;
      setPlaceID(id);
      setNewLocation(false);
    },
    onCreated = (id: string) => {
      setPlaceID(id);
      setNewLocation(false);
      places.reload();
      go('home');
    };
  const save = () =>
    run('Save business draft', async () => {
      await facts.save();
      places.reload();
    });
  const invited = location.hash.startsWith('#invite=') ? location.hash.slice(8) : null;
  if (boot)
    return (
      <div className="boot">
        <Brand />
        <LoaderCircle className="spin" size={24} />
        <p>Opening your workspace…</p>
      </div>
    );
  return (
    <>
      {error && (
        <div className="global-message error-message" role="alert">
          <div>
            <strong>{error.message}</strong>
            {error.code && (
              <small>
                {error.code.replaceAll('_', ' ')}
                {error.requestID ? ' · Reference ' + error.requestID : ''}
              </small>
            )}
            {['draft_changed', 'place_changed', 'version_conflict', 'settings_changed'].includes(
              error.code ?? '',
            ) && (
              <p>
                Your unsaved changes remain here. Copy or reconcile them before reloading the saved
                version.
              </p>
            )}
          </div>
          <button aria-label="Dismiss error" onClick={() => setError(null)}>
            <X size={18} />
          </button>
        </div>
      )}
      {success && (
        <div className="toast" role="status">
          <Check size={15} />
          {success}
        </div>
      )}
      {resetToken ? (
        <Recovery
          token={resetToken}
          run={run}
          busy={busy}
          onDone={() => {
            history.replaceState(null, '', location.pathname);
            setResetToken(null);
            loadMe();
          }}
        />
      ) : !me ? (
        <Auth onAuthenticated={loadMe} run={run} busy={busy} />
      ) : !tenant ? (
        <div className="workspace-start">
          <Brand />
          <Panel
            title="Create your workspace"
            subtitle="Your locations and invited team members stay together here."
          >
            <Field label="Workspace name">
              <input
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="Your business or brand"
              />
            </Field>
            <Button
              disabled={!workspaceName}
              busy={!!busy}
              onClick={() =>
                run('Create workspace', async () => {
                  await api('/v1/tenants', { method: 'POST', body: { name: workspaceName } });
                  await loadMe();
                })
              }
            >
              Create workspace
              <ArrowRight size={16} />
            </Button>
          </Panel>
          {invited && (
            <Button
              variant="secondary"
              onClick={() =>
                run('Accept invitation', async () => {
                  await api('/v1/team/invitations/accept', {
                    method: 'POST',
                    body: { token: invited },
                  });
                  location.hash = '';
                  await loadMe();
                })
              }
            >
              Accept workspace invitation
            </Button>
          )}
        </div>
      ) : (
        <div className="app-shell">
          <aside className={mobileMenu ? 'sidebar open' : 'sidebar'}>
            <Brand />
            <div className="workspace-selector">
              <span>WORKSPACE</span>
              <select
                aria-label="Workspace"
                value={tenantID}
                onChange={(e) => {
                  if (
                    !dirty ||
                    confirm('Keep unsynced edits in local recovery and switch workspace?')
                  ) {
                    setTenantID(e.target.value);
                    setPlaceID('');
                  }
                }}
              >
                {me.tenants.map((t: Tenant) => (
                  <option value={t.id} key={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <small>{tenant.role}</small>
            </div>
            <nav aria-label="Business navigation">
              {navigation
                .filter(([id]) => !['team', 'billing'].includes(id) || tenant.role === 'owner')
                .map(([id, label, Icon]) => (
                  <button
                    key={id}
                    className={screen === id && !newLocation ? 'active' : ''}
                    onClick={() => {
                      setNewLocation(false);
                      go(id);
                    }}
                  >
                    <Icon size={17} strokeWidth={1.6} />
                    <span>{label}</span>
                    {id === 'review' && dirty && <i className="nav-dot" />}
                  </button>
                ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="account-avatar">{me.user.name.slice(0, 1).toUpperCase()}</div>
              <div>
                <strong>{me.user.name}</strong>
                <small>{me.user.email}</small>
              </div>
              <button
                aria-label="Sign out"
                onClick={() =>
                  run('Sign out', async () => {
                    if (
                      dirty &&
                      !confirm('Keep unsynced edits in encrypted local recovery and sign out?')
                    )
                      return;
                    await api('/api/auth/sign-out', { method: 'POST', body: {} });
                    setMe(null);
                    setPlaceID('');
                    setTenantID('');
                  })
                }
              >
                <LogOut size={16} />
              </button>
            </div>
          </aside>
          {mobileMenu && (
            <button
              className="sidebar-scrim"
              aria-label="Close navigation"
              onClick={() => setMobileMenu(false)}
            />
          )}
          <main className="main-content">
            <header className="topbar">
              <button
                className="mobile-menu"
                aria-label="Open navigation"
                onClick={() => setMobileMenu(!mobileMenu)}
              >
                <Menu size={21} />
              </button>
              <div className="breadcrumb">
                Business<span>/</span>
                <strong>
                  {newLocation ? 'Add location' : navigation.find((n) => n[0] === screen)?.[1]}
                </strong>
              </div>
              <div className="topbar-actions">
                {places.data?.places?.length > 0 && (
                  <div className="location-selector">
                    <MapPin size={14} />
                    <select
                      aria-label="Current location"
                      value={placeID}
                      onChange={(e) => changeLocation(e.target.value)}
                    >
                      {places.data.places.map((p: any) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={13} />
                  </div>
                )}
                {tenant.role === 'owner' && (
                  <Button
                    variant="secondary"
                    aria-label="Add location"
                    onClick={() => {
                      if (
                        !dirty ||
                        confirm('Keep unsynced edits in local recovery and add a location?')
                      ) {
                        setNewLocation(true);
                      }
                    }}
                  >
                    <Plus size={15} />
                    <span>Add location</span>
                  </Button>
                )}
              </div>
            </header>
            <div className="page-content">
              {invited && (
                <div className="notice">
                  <p>A workspace invitation is ready for this account.</p>
                  <Button
                    onClick={() =>
                      run('Accept invitation', async () => {
                        await api('/v1/team/invitations/accept', {
                          method: 'POST',
                          body: { token: invited },
                        });
                        location.hash = '';
                        await loadMe();
                      })
                    }
                  >
                    Accept invitation
                  </Button>
                </div>
              )}
              {!me.user.emailVerified && capabilities.data?.email?.configured && (
                <div className="notice subtle">
                  <ShieldCheck size={16} />
                  <span>
                    Your email is not verified. Verify it before accepting team invitations.
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      run('Send verification email', async () => {
                        await api('/api/auth/send-verification-email', {
                          method: 'POST',
                          body: {
                            email: me.user.email,
                            callbackURL: location.origin + '/console/',
                          },
                        });
                      })
                    }
                  >
                    Send verification
                  </Button>
                </div>
              )}
              {places.error && <p className="notice">{places.error}</p>}
              {newLocation || (!placeID && !places.loading) ? (
                <Onboarding
                  tenant={tenant}
                  types={types.data?.types ?? []}
                  run={run}
                  busy={busy}
                  onCreated={onCreated}
                />
              ) : !detail.data ? (
                <div className="section-loading">
                  {detail.error ? (
                    <>
                      <p className="notice">{detail.error}</p>
                      <Button onClick={detail.reload} variant="secondary">
                        Retry
                      </Button>
                    </>
                  ) : (
                    <>
                      <LoaderCircle className="spin" size={23} />
                      <p>Loading location…</p>
                    </>
                  )}
                </div>
              ) : (
                <>
                  {screen !== 'home' && (
                    <div className="page-heading">
                      <span className="eyebrow">{detail.data.place.name}</span>
                      <h1>{navigation.find((n) => n[0] === screen)?.[1]}</h1>
                      {['details', 'hours', 'offerings'].includes(screen) && (
                        <p>Edits stay in your draft until you review and publish them.</p>
                      )}
                    </div>
                  )}
                  {facts.recovery && (
                    <Panel
                      title="Recover unsynced changes"
                      subtitle="Encrypted edits for this account and location were found on this device."
                    >
                      <div className="actions">
                        <Button onClick={facts.restoreRecovery}>Review recovered edits</Button>
                        <Button variant="secondary" onClick={facts.discardRecovery}>
                          Keep server version
                        </Button>
                      </div>
                    </Panel>
                  )}
                  {facts.conflict && (
                    <Panel
                      title="Resolve concurrent edits"
                      subtitle="Another editor changed these fields. Choose which values to retain."
                    >
                      {facts.conflict.fields.map((f) => (
                        <div className="conflict-field" key={f.key}>
                          <h3>{f.label}</h3>
                          <div className="two-columns">
                            <div>
                              <span className="eyebrow">YOUR EDIT</span>
                              <pre className="code-value">{JSON.stringify(f.local, null, 2)}</pre>
                              <Button
                                variant="secondary"
                                onClick={() => facts.chooseConflict(f.key, true)}
                              >
                                Keep mine
                              </Button>
                            </div>
                            <div>
                              <span className="eyebrow">SAVED ON SERVER</span>
                              <pre className="code-value">{JSON.stringify(f.remote, null, 2)}</pre>
                              <Button
                                variant="secondary"
                                onClick={() => facts.chooseConflict(f.key, false)}
                              >
                                Keep server value
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}
                      <Button
                        disabled={facts.conflict.fields.length > 0}
                        onClick={facts.finishConflict}
                      >
                        Finish reconciliation
                      </Button>
                    </Panel>
                  )}
                  {screen === 'home' && (
                    <Overview detail={detail.data} base={base} tenant={tenant} go={go} />
                  )}{' '}
                  {['details', 'hours', 'offerings'].includes(screen) && profile && (
                    <>
                      <div className="draft-toolbar">
                        <div>
                          <Status value={detail.data.draft?.state ?? 'new draft'} />
                          <span>{facts.status}</span>
                        </div>
                        <div className="actions">
                          <Button
                            variant="ghost"
                            onClick={() => {
                              if (
                                !dirty ||
                                confirm('Discard your edits and reload the saved draft?')
                              )
                                run('Reload saved facts', facts.reload);
                            }}
                          >
                            <RefreshCw size={15} />
                            Reload saved
                          </Button>
                          <Button
                            disabled={facts.blocked || (!dirty && !!facts.draft)}
                            busy={facts.saving || busy === 'Save business draft'}
                            onClick={save}
                          >
                            <Save size={15} />
                            {detail.data.draft?.state === 'published'
                              ? 'Save as new draft'
                              : 'Save draft'}
                          </Button>
                        </div>
                      </div>
                      {detail.data.claim.state !== 'approved' && (
                        <div className="notice">
                          Ownership review is {detail.data.claim.state}. Publishing and edits
                          require an approved claim.
                          {detail.data.claim.reviewReason && ' ' + detail.data.claim.reviewReason}
                        </div>
                      )}
                      {facts.validationIssues.length > 0 && (
                        <div className="notice" role="status">
                          <strong>Complete these fields to sync</strong>
                          <ul>
                            {facts.validationIssues.slice(0, 6).map((i) => (
                              <li key={i.path}>
                                {i.path}: {i.message}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {screen === 'details' ? (
                        <Facts
                          profile={profile}
                          onChange={setFacts}
                          types={types.data?.types ?? []}
                          readOnly={facts.blocked || !!busy}
                        />
                      ) : screen === 'hours' ? (
                        <Hours
                          profile={profile}
                          onChange={setFacts}
                          readOnly={facts.blocked || !!busy}
                        />
                      ) : (
                        <Offerings
                          profile={profile}
                          onChange={setFacts}
                          readOnly={facts.blocked || !!busy}
                        />
                      )}
                      <Panel title="Publication permission">
                        <fieldset disabled={facts.blocked || !!busy}>
                          <CheckLine checked={rights} onChange={(v) => facts.setRights(v)}>
                            I am authorized to publish these facts and have permission for the
                            supplied content.
                          </CheckLine>
                        </fieldset>
                        <p className="hint">
                          Ownership review does not independently verify every fact. A saved draft
                          is not public.
                        </p>
                      </Panel>
                    </>
                  )}
                  {(screen === 'website' || screen === 'review') &&
                    (dirty || facts.recovery || facts.conflict ? (
                      <Panel title="Save before reviewing">
                        <p>
                          Your unsaved changes are still in this browser. Save the draft so the
                          preview can match a specific server revision.
                        </p>
                        <div className="actions">
                          <Button
                            onClick={save}
                            busy={!!busy || facts.saving}
                            disabled={facts.blocked || facts.validationIssues.length > 0}
                          >
                            Save draft
                          </Button>
                          <Button variant="secondary" onClick={() => go('details')}>
                            Review business details
                          </Button>
                        </div>
                        {(facts.recovery || facts.conflict) && (
                          <p className="hint">
                            Resolve the recovery or conflicting edits above before saving.
                          </p>
                        )}
                        {facts.validationIssues.length > 0 && (
                          <p className="hint">
                            Complete the highlighted fields in Business details before preparing a
                            preview.
                          </p>
                        )}
                      </Panel>
                    ) : (
                      <Website
                        base={base}
                        draft={facts.draft ?? detail.data.draft}
                        run={run}
                        busy={busy}
                        canManage={canManage}
                        canPublish={canPublish}
                        onChange={() => {
                          detail.reload();
                          places.reload();
                        }}
                        review={screen === 'review'}
                      />
                    ))}
                  {screen === 'photos' && (
                    <Photos
                      base={base}
                      tenantID={tenant.id}
                      placeID={placeID}
                      run={run}
                      busy={busy}
                      canPublish={canPublish}
                    />
                  )}{' '}
                  {screen === 'arrival' &&
                    (detail.data.claim.state === 'approved' ? (
                      <MapEditor
                        tenantID={tenant.id}
                        placeID={placeID}
                        readOnly={!canEdit}
                        onPublished={() => detail.reload()}
                      />
                    ) : (
                      <Empty title="Ownership review comes first">
                        Once authority for this location is approved, you can record entrance
                        photos, floors and directions.
                      </Empty>
                    ))}{' '}
                  {screen === 'visibility' && <Visibility base={base} />}{' '}
                  {screen === 'team' && tenant.role === 'owner' && (
                    <Team
                      tenant={tenant}
                      places={places.data?.places ?? []}
                      run={run}
                      busy={busy}
                    />
                  )}{' '}
                  {screen === 'billing' && tenant.role === 'owner' && (
                    <Billing tenantID={tenant.id} placeID={placeID} run={run} busy={busy} />
                  )}{' '}
                  {screen === 'settings' && (
                    <Settings
                      tenantID={tenant.id}
                      placeID={placeID}
                      base={base}
                      run={run}
                      busy={busy}
                    />
                  )}
                </>
              )}
              <footer className="page-footer">
                <span>Kulture Business</span>
                <span>One maintained record. A clearer next visit.</span>
                <button onClick={() => go('settings')}>
                  <HelpCircle size={13} />
                  Help
                </button>
              </footer>
            </div>
          </main>
          <nav className="mobile-bottom-nav" aria-label="Primary navigation">
            {[
              ['home', 'Overview', Home],
              ['website', 'Website', Globe],
              ['arrival', 'Directions', MapPin],
            ].map(([id, label, Icon]: any) => (
              <button
                key={id}
                className={screen === id ? 'active' : ''}
                onClick={() => {
                  setNewLocation(false);
                  go(id);
                }}
              >
                <Icon size={19} />
                <span>{label}</span>
              </button>
            ))}
            <button onClick={() => setMobileMenu(true)} aria-expanded={mobileMenu}>
              <Menu size={19} />
              <span>Menu</span>
            </button>
          </nav>
        </div>
      )}
    </>
  );
}
