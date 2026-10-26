import { useState } from 'react';
import { Plus, Upload, Trash2, Download, Check, Users, ExternalLink, RefreshCw, ArrowRight } from 'lucide-react';
import { api, displayDate, downloadJSON, type Tenant } from './api';
import { useResource, type Run } from './hooks';
import { Button, Panel, Field, Status, Empty, CheckLine, External } from './ui';
export function Photos({
  base,
  tenantID,
  placeID,
  run,
  busy,
  canPublish,
}: {
  base: string;
  tenantID: string;
  placeID: string;
  run: Run;
  busy: string;
  canPublish: boolean;
}) {
  const media = useResource(base + '/media'),
    [file, setFile] = useState<File | null>(null),
    [alt, setAlt] = useState(''),
    [holder, setHolder] = useState(''),
    [basis, setBasis] = useState('owned'),
    [permission, setPermission] = useState(''),
    [publicUse, setPublicUse] = useState(false);
  return (
    <>
      <Panel
        title="Photos & evidence"
        subtitle="Originals stay private. You explicitly approve each public derivative."
      >
        <div className="upload-grid">
          <label className="upload-zone">
            <Upload size={24} />
            <strong>{file?.name ?? 'Choose a real business photo'}</strong>
            <span>JPEG, PNG or WebP · up to 5 MiB</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <div>
            <Field label="Image description">
              <input
                value={alt}
                onChange={(e) => setAlt(e.target.value)}
                placeholder="Describe what customers will see"
              />
            </Field>
            <div className="form-grid">
              <Field label="Rights holder">
                <input value={holder} onChange={(e) => setHolder(e.target.value)} />
              </Field>
              <Field label="Permission basis">
                <select value={basis} onChange={(e) => setBasis(e.target.value)}>
                  <option value="owned">Owned by this business</option>
                  <option value="licensed">Licensed for use</option>
                </select>
              </Field>
            </div>
            <Field label="Permission note">
              <input
                value={permission}
                onChange={(e) => setPermission(e.target.value)}
                placeholder="Who supplied and approved this photo?"
              />
            </Field>
            <CheckLine checked={publicUse} onChange={setPublicUse}>
              Permission includes public display.
            </CheckLine>
            <Button
              disabled={!file || !alt || !holder || permission.length < 5}
              busy={busy === 'Upload photo'}
              onClick={() =>
                run('Upload photo', async () => {
                  if (!file) return;
                  if (file.size > 5 * 1024 * 1024)
                    throw new Error('Choose an image smaller than 5 MiB.');
                  const r = await api('/v1/media/uploads', {
                    method: 'POST',
                    body: {
                      tenantID,
                      placeID,
                      purpose: 'business_photo',
                      alt,
                      rights: {
                        basis,
                        holder,
                        publicUse,
                        permissionNote: permission,
                        expiresAt: null,
                      },
                    },
                  });
                  const response = await fetch(r.uploadPath, {
                    method: 'PUT',
                    credentials: 'include',
                    headers: { 'Content-Type': file.type },
                    body: file,
                  });
                  if (!response.ok) {
                    const d = await response.json();
                    throw new Error(d.error?.message ?? 'Upload failed');
                  }
                  setFile(null);
                  setAlt('');
                  media.reload();
                })
              }
            >
              <Upload size={15} />
              Upload privately
            </Button>
          </div>
        </div>
      </Panel>
      <Panel
        title="Your library"
        subtitle={`${media.data?.assets?.length ?? 0} of 100 images · 250 MiB allowance`}
      >
        {media.error && <p className="notice">{media.error}</p>}
        <div className="photo-grid">
          {media.data?.assets?.map((a: any) => (
            <article className="photo-card" key={a.id}>
              {a.state === 'ready' ? (
                <img src={'/v1/media/' + a.id + '/preview'} alt={a.alt} loading="lazy" />
              ) : (
                <div className="photo-placeholder">
                  <Status value={a.state} />
                </div>
              )}
              <div>
                <strong>{a.alt}</strong>
                <p>
                  {a.rights.holder} · {a.width ?? '—'} × {a.height ?? '—'}
                </p>
                <Status value={a.state} />
                <div className="actions">
                  {a.state === 'ready' && a.rights.publicUse && canPublish && (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        run('Approve photo', async () => {
                          await api('/v1/media/' + a.id + '/approve-public', {
                            method: 'POST',
                            body: { reviewed: true, permissionConfirmed: true },
                          });
                          media.reload();
                        })
                      }
                    >
                      <Check size={14} />
                      Approve public use
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    aria-label={'Revoke ' + a.alt}
                    onClick={() => {
                      if (confirm('Remove this photo from public use?'))
                        run('Revoke photo', async () => {
                          await api('/v1/media/' + a.id, { method: 'DELETE' });
                          media.reload();
                        });
                    }}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
        {!media.data?.assets?.length && (
          <p className="muted">
            No uploaded photos. Images are checked and stripped of embedded location metadata.
          </p>
        )}
      </Panel>
    </>
  );
}
export function Team({
  tenant,
  places,
  run,
  busy,
}: {
  tenant: Tenant;
  places: any[];
  run: Run;
  busy: string;
}) {
  const team = useResource(`/v1/tenants/${tenant.id}/members`),
    [email, setEmail] = useState(''),
    [role, setRole] = useState('editor'),
    [scope, setScope] = useState<string[]>([]),
    [publish, setPublish] = useState(false),
    [destinations, setDestinations] = useState(false),
    [link, setLink] = useState('');
  return (
    <>
      <Panel
        title="People & permissions"
        subtitle="One owner and two invited team members. Each person uses their own account."
      >
        {team.error && <p className="notice">{team.error}</p>}
        {team.data?.members?.map((m: any) => (
          <div className="record" key={m.userID}>
            <div className="person">
              <div className="avatar">
                <Users size={18} />
              </div>
              <div>
                <strong>{m.name ?? m.email ?? m.userID}</strong>
                {m.email && <small>{m.email}</small>}
                <p>
                  {m.role} ·{' '}
                  {m.scopeMode === 'all'
                    ? 'All locations'
                    : `${m.placeIDs.length} selected locations`}
                </p>
              </div>
            </div>
            <div className="actions">
              <Status value={m.state} />
              {m.role !== 'owner' && m.state === 'active' && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    run('Revoke member', async () => {
                      await api(`/v1/tenants/${tenant.id}/members/${m.userID}`, {
                        method: 'PATCH',
                        body: {
                          state: 'revoked',
                          permissions: {
                            role: m.role,
                            scopeMode: m.scopeMode,
                            placeIDs: m.placeIDs,
                            canPublish: m.canPublish,
                            canManageDestinations: m.canManageDestinations,
                          },
                        },
                      });
                      team.reload();
                    })
                  }
                >
                  Revoke access
                </Button>
              )}
            </div>
          </div>
        ))}
      </Panel>
      <Panel
        title="Invite a teammate"
        subtitle="The link expires in seven days and only works for the verified email you specify."
      >
        {!places.length && (
          <p className="notice">Add a location before inviting teammates to manage it.</p>
        )}
        <div className="form-grid">
          <Field label="Recipient email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Role">
            <select
              value={role}
              onChange={(e) => {
                setRole(e.target.value);
                setPublish(false);
                setDestinations(false);
              }}
            >
              <option value="editor">Editor — edit facts and maps</option>
              <option value="manager">Manager — optional publishing grants</option>
              <option value="viewer">Viewer — read only</option>
            </select>
          </Field>
        </div>
        <p className="label">Assigned locations</p>
        <div className="location-checks">
          {places.map((p) => (
            <CheckLine
              key={p.id}
              checked={scope.includes(p.id)}
              onChange={(v) => setScope(v ? [...scope, p.id] : scope.filter((id) => id !== p.id))}
            >
              {p.name}
            </CheckLine>
          ))}
        </div>
        {role === 'manager' && (
          <>
            <CheckLine checked={publish} onChange={setPublish}>
              Can approve and publish reviewed changes.
            </CheckLine>
            <CheckLine checked={destinations} onChange={setDestinations}>
              Can manage website destinations.
            </CheckLine>
          </>
        )}
        <Button
          disabled={!email || !scope.length}
          busy={busy === 'Create invitation'}
          onClick={() =>
            run('Create invitation', async () => {
              const r = await api(`/v1/tenants/${tenant.id}/invitations`, {
                method: 'POST',
                body: {
                  email,
                  permissions: {
                    role,
                    scopeMode: 'selected',
                    placeIDs: scope,
                    canPublish: publish,
                    canManageDestinations: destinations,
                  },
                },
              });
              setLink(r.acceptURL);
              team.reload();
            })
          }
        >
          <Plus size={15} />
          Create invitation
        </Button>
        {link && (
          <div className="notice success">
            <div>
              <strong>Invitation ready to share</strong>
              <p className="break-all">{link}</p>
              <Button
                variant="secondary"
                onClick={() =>
                  run('Copy invitation', async () => navigator.clipboard.writeText(link))
                }
              >
                Copy link
              </Button>
            </div>
          </div>
        )}
      </Panel>
      <Panel title="Invitation history">
        {team.data?.invitations?.map((i: any) => (
          <div className="record" key={i.id}>
            <div>
              <strong>{i.email}</strong>
              <p>
                {i.role} · expires {displayDate(i.expiresAt)}
              </p>
            </div>
            {i.acceptedAt ? (
              <Status value="accepted" />
            ) : i.revokedAt ? (
              <Status value="revoked" />
            ) : (
              <Button
                variant="ghost"
                onClick={() =>
                  run('Revoke invitation', async () => {
                    await api(`/v1/tenants/${tenant.id}/invitations/${i.id}`, { method: 'DELETE' });
                    team.reload();
                  })
                }
              >
                Revoke
              </Button>
            )}
          </div>
        ))}
      </Panel>
    </>
  );
}
export function Billing({
  tenantID,
  placeID,
  run,
  busy,
}: {
  tenantID: string;
  placeID: string;
  run: Run;
  busy: string;
}) {
  const billing = useResource(`/v1/tenants/${tenantID}/billing`),
    entitlement = useResource(
      placeID ? `/v1/tenants/${tenantID}/places/${placeID}/entitlement` : null,
    ),
    destinations = useResource(
      placeID ? `/v1/tenants/${tenantID}/places/${placeID}/destinations` : null,
    ),
    [terms, setTerms] = useState(false),
    [destinationID, setDestinationID] = useState('');
  const b = billing.data,
    e = entitlement.data?.capabilities.publish,
    subs = b?.subscriptions?.filter((s: any) => !placeID || s.placeID === placeID) ?? [];
  return (
    <>
      <div className="plan-hero">
        <div>
          <span className="eyebrow">ONE PHYSICAL LOCATION</span>
          <h2>
            Keep your business
            <br />
            accurate and discoverable.
          </h2>
          <p>
            Maintained facts, a business website, publishing updates,
            <br />
            arrival guidance and measured visibility.
          </p>
        </div>
        <div className="price">
          ₹299<span>/ month</span>
          <small>Total monthly checkout amount</small>
        </div>
      </div>
      {placeID ? (
        <>
      <Panel title="Current access" action={<Status value={e?.source ?? 'none'} />}>
        <p>{e?.reason ?? entitlement.error ?? 'Loading entitlement…'}</p>
        {e?.validUntil && <p>Valid through {displayDate(e.validUntil)}</p>}
        <p className="hint">
          Essential factual corrections and export stay available after a plan ends. Payment does
          not verify ownership or guarantee a search ranking.
        </p>
      </Panel>
      <Panel title="Activate this location">
        {billing.error && <p className="notice">{billing.error}</p>}
        {!b?.configured ? (
          <div className="notice">
            Payment activation is not connected on this server. Your draft and preview remain
            available. A merchant account and a verified ₹299 monthly provider plan are required
            before checkout.
          </div>
        ) : (
          <>
            <Field label="First website destination">
              <select value={destinationID} onChange={(e) => setDestinationID(e.target.value)}>
                <option value="">Choose the website you reviewed</option>
                {destinations.data?.destinations?.map((d: any) => (
                  <option key={d.id} value={d.id}>
                    {d.publicURL}
                  </option>
                ))}
              </select>
            </Field>
            <p>{b.policy?.summary}</p>
            <CheckLine checked={terms} onChange={setTerms}>
              I accept the ₹299 recurring monthly plan and the cancellation, delivery and retention
              terms.
            </CheckLine>
            <Button
              disabled={!terms || !destinationID}
              busy={busy === 'Create checkout'}
              onClick={() =>
                run('Create checkout', async () => {
                  const r = await api(`/v1/tenants/${tenantID}/billing/checkout`, {
                    method: 'POST',
                    body: {
                      placeID,
                      destinationID,
                      termsVersion: 'location-plan-v1',
                      termsAccepted: true,
                    },
                  });
                  if (r.checkoutURL) window.location.assign(r.checkoutURL);
                  billing.reload();
                })
              }
            >
              Continue to secure checkout
              <ExternalLink size={14} />
            </Button>
          </>
        )}
      </Panel>
        </>
      ) : (
        <Panel title="Choose a location for its plan">
          <Empty title="No location selected">
            Add a location to check its access and activate a plan. Workspace payment history is
            available below.
          </Empty>
        </Panel>
      )}
      <Panel title="Plan & payment history">
        {billing.error && <p className="notice">{billing.error}</p>}
        {!subs.length && (
          <p className="muted">
            No checkout has been created for {placeID ? 'this location' : 'this workspace'}.
          </p>
        )}
        {subs.map((s: any) => (
          <div className="subscription" key={s.id}>
            <div className="record">
              <div>
                {!placeID && <small>Location {s.placeID}</small>}
                <Status value={s.status} />
                <p>Paid through {displayDate(s.paidUntil)}</p>
                {s.cancelAtPeriodEnd && (
                  <small>Cancellation confirmed for the end of the paid period.</small>
                )}
              </div>
              <div className="actions">
                <External href={s.checkoutURL}>Checkout</External>
                {s.providerID &&
                  !s.cancelAtPeriodEnd &&
                  !['cancelled', 'completed', 'expired'].includes(s.status) && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        if (
                          confirm(
                            'Cancel renewal after the paid period? Your current paid access remains until its end.',
                          )
                        )
                          run('Cancel renewal', async () => {
                            await api(`/v1/tenants/${tenantID}/billing/${s.id}/cancel`, {
                              method: 'POST',
                              body: { approval: true },
                            });
                            billing.reload();
                          });
                      }}
                    >
                      Cancel renewal
                    </Button>
                  )}
                {s.renewalsPausedAt && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      run('Resume renewal', async () => {
                        await api(`/v1/tenants/${tenantID}/billing/${s.id}/resume`, {
                          method: 'POST',
                          body: { approval: true },
                        });
                        billing.reload();
                      })
                    }
                  >
                    Resume after resolution
                  </Button>
                )}
              </div>
            </div>
            {s.reconcileError && (
              <p className="notice">
                Payment status needs reconciliation. Access follows verified paid periods.
              </p>
            )}
          </div>
        ))}
        {b?.commands?.map((c: any) => (
          <div className="record" key={c.id}>
            <span>
              {c.kind} request · {displayDate(c.createdAt)}
            </span>
            <Status value={c.state} />
          </div>
        ))}
      </Panel>
    </>
  );
}
export function Settings({
  tenantID,
  placeID,
  base,
  run,
  busy,
  places,
  onSelectPlace,
  onEditPlace,
  onAddPlace,
}: {
  tenantID: string;
  placeID: string;
  base: string;
  run: Run;
  busy: string;
  places: Array<{ id: string; name: string; claimState: string }>;
  onSelectPlace: (id: string) => void;
  onEditPlace: () => void;
  onAddPlace?: () => void;
}) {
  const settings = useResource('/v1/settings'),
    requests = useResource('/v1/service-requests'),
    [kind, setKind] = useState('support'),
    [message, setMessage] = useState('');
  return (
    <>
      <Panel
        title="Your businesses"
        subtitle="Switch the active business, edit its private details, or add another location."
      >
        {places.length > 0 ? (
          <>
            <Field label="Active business">
              <select value={placeID} onChange={(e) => onSelectPlace(e.target.value)}>
                {places.map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.name} · {place.claimState.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </Field>
            <div className="actions">
              <Button variant="secondary" onClick={onEditPlace} disabled={!placeID}>
                Edit business details
              </Button>
              {onAddPlace && (
                <Button onClick={onAddPlace}>
                  <Plus size={16} /> Add or claim a business
                </Button>
              )}
            </div>
          </>
        ) : (
          <Empty
            title="No business added yet"
            action={onAddPlace ? <Button onClick={onAddPlace}>Add or claim a business</Button> : undefined}
          >
            Search for an existing branch or add a new private location.
          </Empty>
        )}
      </Panel>
      <Panel
        title="Your data"
        subtitle="Download business facts, drafts and publication history in a portable format."
      >
        {placeID ? (
          <>
        <Button
          variant="secondary"
          onClick={() =>
            run('Export business', async () => {
              downloadJSON(await api(base + '/export'), `kulture-${placeID}.json`);
            })
          }
        >
          <Download size={16} />
          Export facts JSON
        </Button>{' '}
        <a className="button secondary" href={base + '/export/archive'} download>
          <Download size={16} />
          Download website & photos
        </a>
          </>
        ) : (
          <Empty title="No location to export">
            Add or select a location to download its business data.
          </Empty>
        )}
        <p className="hint">
          Private ownership documents and site credentials are excluded. Request verified access to
          private evidence below.
        </p>
      </Panel>
      <Panel title="Notifications">
        {settings.error && <p className="notice">{settings.error}</p>}
        {settings.data && (
          <>
            <CheckLine
              checked={settings.data.preferences.productUpdates}
              onChange={(v) =>
                settings.setData({
                  ...settings.data,
                  preferences: { ...settings.data.preferences, productUpdates: v },
                })
              }
            >
              Product updates
            </CheckLine>
            <CheckLine
              checked={settings.data.preferences.serviceNotifications}
              onChange={(v) =>
                settings.setData({
                  ...settings.data,
                  preferences: { ...settings.data.preferences, serviceNotifications: v },
                })
              }
            >
              Optional service reminders
            </CheckLine>
            <p className="hint">
              Essential security, billing and service-delivery notices remain available in your
              account.
            </p>
            <Button
              variant="secondary"
              onClick={() =>
                run('Save preferences', async () => {
                  await api('/v1/settings', {
                    method: 'PUT',
                    version: settings.data.revision,
                    body: settings.data.preferences,
                  });
                  settings.reload();
                })
              }
            >
              Save preferences
            </Button>
          </>
        )}
      </Panel>
      <Panel
        title="Get help"
        subtitle="Requests are recorded for review, with a status you can follow."
      >
        <Field label="Request type">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {[
              ['support', 'Support'],
              ['correction', 'Report incorrect information'],
              ['refund', 'Request a refund'],
              ['ownership_transfer', 'Transfer business ownership'],
              ['export', 'Private evidence access'],
              ['deletion', 'Request account / data deletion'],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="What should we review?">
          <textarea
            rows={4}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            minLength={10}
            maxLength={4000}
          />
        </Field>
        <Button
          disabled={message.length < 10}
          busy={busy === 'Submit request'}
          onClick={() =>
            run('Submit request', async () => {
              await api('/v1/service-requests', {
                method: 'POST',
                body: { tenantID, placeID: placeID || null, kind, message },
              });
              setMessage('');
              requests.reload();
            })
          }
        >
          Submit request
        </Button>
      </Panel>
      <Panel title="Your requests">
        {requests.error && <p className="notice">{requests.error}</p>}
        {requests.data?.requests
          ?.filter((r: any) => r.tenantID === tenantID || !r.tenantID)
          .map((r: any) => (
            <div className="record" key={r.id}>
              <div>
                <strong>{r.kind.replaceAll('_', ' ')}</strong>
                <p>{r.body.message}</p>
                {r.resolution && <p>{r.resolution}</p>}
                <small>{displayDate(r.createdAt)}</small>
              </div>
              <Status value={r.state} />
            </div>
          ))}
        {!requests.data?.requests?.length && <p className="muted">No requests yet.</p>}
      </Panel>
    </>
  );
}
export function Visibility({ base, approved, onEdit, onPublish, places, placeID, onSelectPlace }: { base: string; approved: boolean; onEdit: () => void; onPublish: () => void; places: { id: string; name: string; claimState: string }[]; placeID: string; onSelectPlace: (id: string) => void }) {
  const readiness = useResource(base + '/readiness');
  const data = useResource(approved ? base + '/visibility' : null);
  const report = readiness.data;
  return (
    <>
      <section className="visibility-hero">
        <div><span className="eyebrow">DISCOVERY READINESS</span><h2>Make your business easier to find.</h2><p>Two practical scores for {report?.businessName ?? 'your business'}, calculated from your saved facts and public page.</p></div>
        <Button variant="secondary" type="button" onClick={() => readiness.reload()} disabled={readiness.loading}><RefreshCw size={17} className={readiness.loading ? 'spin' : ''} /> Recalculate scores</Button>
      </section>
      {readiness.error && <p className="notice" role="alert">{readiness.error}</p>}
      {report && <>
        <div className="readiness-grid">
          {[{ key: 'geo', short: 'GEO', title: 'Generative engine readiness', detail: 'How complete and useful your public facts are for AI discovery tools such as ChatGPT and Gemini.' }, { key: 'seo', short: 'SEO', title: 'Search engine readiness', detail: 'How ready your business page is for crawling and indexing by search engines.' }].map((item) => {
            const result = report[item.key];
            return <article className={`readiness-card ${item.key}`} key={item.key}>
              <div className="readiness-card-top"><span>{item.short} SCORE</span><span>Readiness · not ranking</span></div>
              <div className="readiness-number"><strong>{result.score}</strong><span>/ 100</span></div>
              <div className="readiness-meter" role="meter" aria-label={`${item.short} readiness`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={result.score}><i style={{ width: `${result.score}%` }} /></div>
              <h3>{item.title}</h3><p>{item.detail}</p>
              <div className="readiness-checks">{result.checks.map((check: any) => <div className="readiness-check" key={check.id}><span className={check.passed ? 'passed' : ''}>{check.passed ? '✓' : '○'}</span><div><strong>{check.label}</strong>{!check.passed && <small>{check.action}</small>}</div><b>{check.passed ? '+' : ''}{check.passed ? check.weight : 0}/{check.weight}</b></div>)}</div>
            </article>;
          })}
        </div>
        <Panel title="Get your business into discovery" subtitle="The next steps for this business, based on its current state.">
          <div className="discovery-steps">
            <div><span>01</span><div><strong>Complete the facts</strong><p>Use your real name, address, hours, contact details and categorized offerings. The scores update from the latest saved draft.</p></div><Button variant="ghost" onClick={onEdit}>Edit facts <ArrowRight size={15} /></Button></div>
            <div><span>02</span><div><strong>Publish the approved page</strong><p>{report.claimState === 'approved' ? 'Review the preview and publish to create a canonical business page with structured data and a sitemap entry.' : 'Your ownership claim needs approval before your page can be published. You can improve the private draft now.'}</p></div><Button variant="ghost" onClick={onPublish}>Review <ArrowRight size={15} /></Button></div>
            <div><span>03</span><div><strong>Submit and monitor search indexing</strong><p>Once live, the owner of the published domain can verify it in Google Search Console and submit the sitemap. Kulture manages this for pages on its own domain. Search engines decide indexing and rankings.</p><div className="visibility-links"><External href="https://search.google.com/search-console/">Open Search Console</External>{report.publicURL && <><External href={report.publicURL}>Open business page</External><External href={report.sitemapURL}>Open sitemap</External></>}</div></div></div>
            <div><span>04</span><div><strong>Keep it useful for AI discovery</strong><p>Keep public facts accurate, specific and current. AI services choose their own sources and answers; this score cannot confirm citations or recommendations.</p></div></div>
          </div>
          <p className="hint">{report.methodology} Recalculated {displayDate(report.computedAt)} from {report.profileSource === 'latest_saved_draft' ? 'the latest saved draft' : 'the business record'}.</p>
        </Panel>
      </>}
      {places.length > 1 && <Panel title="All your businesses" subtitle="Select a business to see its own GEO and SEO readiness.">
        <div className="visibility-businesses">{places.map((place) => <button className={place.id === placeID ? 'active' : ''} type="button" key={place.id} onClick={() => onSelectPlace(place.id)} aria-current={place.id === placeID ? 'true' : undefined}><span><strong>{place.name}</strong><small>Ownership {place.claimState}</small></span><span>{place.id === placeID ? 'Viewing scores' : 'View scores →'}</span></button>)}</div>
      </Panel>}
      {!approved && <Empty title="Crawler measurements open after approval">GEO and SEO readiness are available above. Measured discovery activity requires an approved claim and connected evidence.</Empty>}
      {approved && <>
      <Panel
        title="Discovery evidence"
        subtitle="Observed activity, with the method and coverage attached."
        action={<Status value={data.data?.coverage?.status ?? 'unavailable'} />}
      >
        {data.error && <p className="notice">{data.error}</p>}
        <p>{data.data?.coverage?.reason ?? 'Loading authenticated discovery observations…'}</p>
        <div className="metrics-grid">
          {data.data?.metrics?.map((m: any) => (
            <article className="metric" key={m.kind}>
              <span>{m.kind.replaceAll('_', ' ')}</span>
              <strong>{m.value.toLocaleString('en-IN')}</strong>
              <p>{m.definition}</p>
              <small>{m.method}</small>
            </article>
          ))}
        </div>
        {!data.data?.metrics?.length && (
          <Empty title="No measured crawler activity yet">
            Connect authenticated edge logs before reporting crawl counts. Unavailable evidence is
            never displayed as zero.
          </Empty>
        )}
      </Panel>
      <Panel title="How to read this report">
        {data.data?.notes?.map((n: string) => (
          <p className="method-note" key={n}>
            {n}
          </p>
        ))}
        <p className="hint">
          Report window: {displayDate(data.data?.from)} → {displayDate(data.data?.to)}
        </p>
      </Panel>
      </>}
    </>
  );
}
