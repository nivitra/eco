import { useEffect, useRef, useState } from 'react';
import {
  Globe,
  Link,
  ArrowUpRight,
  RefreshCw,
  Undo2,
  ShieldCheck,
  X,
  Image as ImageIcon,
  Monitor,
  Smartphone,
} from 'lucide-react';
import { api, displayDate } from './api';
import { useResource, type Run } from './hooks';
import { Button, Panel, Field, Status, Empty, CheckLine, External } from './ui';

type Artifact = {
  kind: 'publication' | 'domain';
  data: any;
  context: string;
  base: string;
  destinationID: string;
  key: string;
};
function checkedPreview(value: any) {
  if (
    !value ||
    typeof value.html !== 'string' ||
    !value.html.trim() ||
    !/^[a-f0-9]{64}$/.test(value.digest ?? '') ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !Array.isArray(value.blockingIssues)
  )
    throw new Error(
      'The server did not return a complete reviewable preview. Refresh and try again.',
    );
  return value;
}
function publicApproved(asset: any, now = Date.now()) {
  return (
    asset.publicApproved === true &&
    asset.state === 'ready' &&
    asset.rights?.publicUse === true &&
    (!asset.rights.expiresAt ||
      (Number.isFinite(Date.parse(asset.rights.expiresAt)) &&
        Date.parse(asset.rights.expiresAt) > now))
  );
}
function ApprovedPhoto({
  asset,
  selected,
  onChange,
  disabled,
}: {
  asset: any;
  selected: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <label className={'website-photo-option' + (selected ? ' selected' : '')}>
      {failed ? (
        <div className="website-photo-unavailable">
          <ImageIcon size={22} />
          <span>Preview unavailable</span>
        </div>
      ) : (
        <img
          src={'/v1/media/' + encodeURIComponent(asset.id) + '/preview'}
          alt={asset.alt || 'Approved business photo'}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
      <span className="website-photo-choice">
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          <strong>{asset.alt || 'Approved business photo'}</strong>
          <small>
            Approved for public use · {asset.width} × {asset.height}
          </small>
          {asset.rights?.expiresAt && (
            <small>Permission expires {displayDate(asset.rights.expiresAt)}</small>
          )}
        </span>
      </span>
    </label>
  );
}
function ExactReview({
  artifact,
  busy,
  canApprove,
  onClose,
  onApprove,
  approvalError,
}: {
  artifact: Artifact;
  busy: boolean;
  canApprove: boolean;
  onClose: () => void;
  onApprove: () => void;
  approvalError: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    loads = useRef(0);
  const [approved, setApproved] = useState(false),
    [loaded, setLoaded] = useState(false),
    [navigated, setNavigated] = useState(false),
    [width, setWidth] = useState<'desktop' | 'mobile'>('desktop'),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    dialog.current?.showModal();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const preview = artifact.data,
    expired = Date.parse(preview.expiresAt) <= now,
    blocked = preview.blockingIssues.length > 0;
  const approve = () => {
    if (
      !approved ||
      !loaded ||
      navigated ||
      Date.parse(preview.expiresAt) <= Date.now() ||
      blocked ||
      !canApprove
    )
      return;
    onApprove();
  };
  return (
    <dialog
      className="website-review-dialog"
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      aria-labelledby="website-preview-title"
    >
      <div className="preview-modal">
        <header>
          <div>
            <span className="eyebrow">EXACT SERVER OUTPUT</span>
            <h2 id="website-preview-title">
              {artifact.kind === 'domain' ? 'Review your domain change' : 'Review your website'}
            </h2>
            <p>
              {artifact.kind === 'domain' ? (
                <>
                  <span className="preview-url-old">{preview.previousURL}</span>
                  <br />
                  <strong>{preview.publicURL}</strong>
                </>
              ) : (
                <>
                  Draft {preview.draftVersion} · {preview.publicURL}
                </>
              )}
            </p>
          </div>
          <Button
            variant="ghost"
            aria-label="Close preview"
            onClick={onClose}
            disabled={busy}
            autoFocus
          >
            <X size={20} />
          </Button>
        </header>
        <div className="website-preview-controls">
          <div className="segmented" aria-label="Preview viewport">
            <button
              className={width === 'desktop' ? 'active' : ''}
              onClick={() => setWidth('desktop')}
              aria-pressed={width === 'desktop'}
            >
              <Monitor size={14} />
              Desktop
            </button>
            <button
              className={width === 'mobile' ? 'active' : ''}
              onClick={() => setWidth('mobile')}
              aria-pressed={width === 'mobile'}
            >
              <Smartphone size={14} />
              Mobile
            </button>
          </div>
          <span>{loaded ? 'Exact HTML loaded' : 'Loading the rendered page…'}</span>
        </div>
        <div className="website-preview-stage">
          <div className={'website-preview-viewport ' + width}>
            <iframe
              title={
                artifact.kind === 'domain'
                  ? 'Exact domain migration preview'
                  : 'Exact business website preview'
              }
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={preview.html}
              onLoad={() => {
                loads.current++;
                setApproved(false);
                if (loads.current === 1) setLoaded(true);
                else {
                  setLoaded(false);
                  setNavigated(true);
                }
              }}
            />
          </div>
        </div>
        <footer>
          {approvalError && (
            <p className="notice" role="alert">
              {approvalError}
            </p>
          )}
          {preview.blockingIssues.length > 0 && (
            <p className="notice">
              {preview.blockingIssues
                .map((v: unknown) =>
                  typeof v === 'string' ? v : 'A server review issue needs attention.',
                )
                .join(' · ')}
            </p>
          )}
          {navigated && (
            <p className="notice">
              The frame left the original preview. Close this review and prepare a fresh preview
              before approval.
            </p>
          )}
          {expired && (
            <p className="notice">
              This preview has expired. Close it and prepare a fresh version.
            </p>
          )}
          {artifact.kind === 'domain' && (
            <p className="hint">
              This exact page changes the public and canonical address shown above. Activation is
              queued; it is live only after independent checks.
            </p>
          )}
          <fieldset disabled={!loaded || navigated || expired || blocked || !canApprove || busy}>
            <CheckLine checked={approved} onChange={setApproved}>
              {artifact.kind === 'domain'
                ? 'I reviewed this exact page and approve the domain migration.'
                : 'I reviewed these facts and photos and authorize this exact publication.'}
            </CheckLine>
          </fieldset>
          <div className="actions">
            <span className="hint">
              Expires {displayDate(preview.expiresAt)} · scripts and forms are disabled
            </span>
            <Button
              disabled={!approved || !loaded || navigated || expired || blocked || !canApprove}
              busy={busy}
              onClick={approve}
            >
              {artifact.kind === 'domain' ? 'Approve domain migration' : 'Approve & publish'}
              <ArrowUpRight size={16} />
            </Button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}
const deliveryMessage = (code: string) =>
  (
    ({
      unsafe_url:
        'Public verification needs a public HTTPS address. Localhost and private network addresses are intentionally blocked.',
      public_check_failed:
        'The page is delivered but its independent public check needs attention.',
      awaiting_wordpress_sync: 'Waiting for the connected WordPress site to fetch this update.',
      bundle_expired_or_key_revoked:
        'This update expired or its signing key was revoked. Review and publish a fresh revision.',
      approval_revoked:
        'The original approval is no longer valid. An authorized publisher must review again.',
    }) as Record<string, string>
  )[code] ?? code.replaceAll('_', ' ');
export function Website({
  base,
  draft,
  run,
  busy,
  canManage,
  canPublish,
  onChange,
  review = false,
}: {
  base: string;
  draft: any;
  run: Run;
  busy: string;
  canManage: boolean;
  canPublish: boolean;
  onChange: () => void;
  review?: boolean;
}) {
  const destinations = useResource(base + '/destinations', true),
    media = useResource(base + '/media');
  const [pairingCode, setPairingCode] = useState(''),
    [selected, setSelected] = useState(''),
    [artifact, setArtifact] = useState<Artifact | null>(null),
    [hostname, setHostname] = useState(''),
    [domain, setDomain] = useState<any>(null),
    [photoMode, setPhotoMode] = useState<'retain' | 'choose'>('retain'),
    [assetIDs, setAssetIDs] = useState<string[]>([]),
    [mediaOpen, setMediaOpen] = useState(false),
    [queuedNotice, setQueuedNotice] = useState(''),
    [approvalError, setApprovalError] = useState('');
  const all = destinations.data?.destinations ?? [],
    target = all.find((d: any) => d.id === selected) ?? all[0];
  const deliveries = useResource(target ? base + '/deliveries?destinationID=' + target.id : null),
    access = useResource(target ? base + '/destinations/' + target.id + '/access' : null);
  const context = [
      base,
      target?.id ?? '',
      target?.version ?? '',
      draft?.id ?? '',
      draft?.version ?? '',
      photoMode,
      ...assetIDs,
    ].join('|'),
    currentContext = useRef(context);
  currentContext.current = context;
  const approvedPhotos = (media.data?.assets ?? []).filter((a: any) => publicApproved(a));
  const invalidSelection = assetIDs.some((id) => !approvedPhotos.some((a: any) => a.id === id));
  useEffect(() => {
    setArtifact(null);
    setApprovalError('');
    setDomain(null);
    setPhotoMode('retain');
    setAssetIDs([]);
  }, [base, target?.id]);
  useEffect(() => {
    setQueuedNotice('');
  }, [base, selected]);
  useEffect(() => {
    setArtifact(null);
  }, [draft?.id, draft?.version]);
  const refresh = () => {
    destinations.reload();
    deliveries.reload();
    access.reload();
    media.reload();
  };
  const create = (kind: string) =>
    run('Connect website', async () => {
      const expected = currentContext.current;
      const result = await api(base + '/destinations', {
        method: 'POST',
        body: kind === 'hosted' ? { kind } : { kind, pairingCode },
      });
      if (currentContext.current !== expected) return;
      if (!result.destination?.id)
        throw new Error('The connection response was incomplete. Refresh website status.');
      setSelected(result.destination.id);
      setPairingCode('');
      destinations.reload();
      onChange();
    });
  const openPreview = () =>
    run('Render exact preview', async () => {
      if (!target || !draft || draft.state !== 'draft')
        throw new Error('Save a current editable draft before review.');
      if (photoMode === 'choose' && (media.loading || media.error || invalidSelection))
        throw new Error('Refresh approved photos and resolve the selection before review.');
      const expected = context,
        destinationID = target.id;
      const result = await api(base + '/destinations/' + destinationID + '/preview', {
        method: 'POST',
        body: { draftID: draft.id, ...(photoMode === 'choose' ? { assetIDs } : {}) },
      });
      if (currentContext.current !== expected) return;
      const preview = checkedPreview(result.preview);
      if (!preview.id || preview.draftVersion !== draft.version)
        throw new Error(
          'The preview does not match this draft revision. Reload the draft before review.',
        );
      setApprovalError('');
      setArtifact({
        kind: 'publication',
        data: preview,
        context: expected,
        base,
        destinationID,
        key: crypto.randomUUID(),
      });
    });
  const openDomainPreview = () =>
    run('Preview domain', async () => {
      if (!target || target.kind !== 'hosted') return;
      const expected = context,
        destinationID = target.id;
      const result = await api(base + '/destinations/' + destinationID + '/domain/preview', {
        method: 'POST',
        body: {},
      });
      if (currentContext.current !== expected) return;
      const preview = checkedPreview(result.preview);
      setApprovalError('');
      setArtifact({
        kind: 'domain',
        data: preview,
        context: expected,
        base,
        destinationID,
        key: crypto.randomUUID(),
      });
    });
  const approveArtifact = () => {
    const chosen = artifact;
    if (!chosen || chosen.context !== currentContext.current) return;
    return run(
      chosen.kind === 'domain' ? 'Queue domain migration' : 'Publish website',
      async () => {
        setApprovalError('');
        try {
          if (Date.parse(chosen.data.expiresAt) <= Date.now())
            throw new Error('Prepare a fresh preview; this approval has expired.');
          const path = chosen.base + '/destinations/' + chosen.destinationID;
          const result = await api(
            path + (chosen.kind === 'domain' ? '/domain/activate' : '/publish'),
            {
              method: 'POST',
              key: chosen.key,
              ...(chosen.kind === 'publication' ? { version: chosen.data.draftVersion } : {}),
              body:
                chosen.kind === 'domain'
                  ? { previewDigest: chosen.data.digest, approval: true }
                  : {
                      previewID: chosen.data.id,
                      previewDigest: chosen.data.digest,
                      approval: true,
                    },
            },
          );
          if (currentContext.current !== chosen.context) return;
          if (chosen.kind === 'domain' && (!result.queued || !result.deliveryID))
            throw new Error(
              'The server did not confirm a queued migration. Refresh status before retrying.',
            );
          if (chosen.kind === 'publication' && !result.publication?.id)
            throw new Error(
              'The server did not return a publication. Refresh status before retrying.',
            );
          setArtifact(null);
          setQueuedNotice(
            chosen.kind === 'domain'
              ? 'Domain migration queued. Independent checks must pass before it is live.'
              : 'Publication queued. Inspect delivery status for the independently checked result.',
          );
          refresh();
          onChange();
        } catch (error) {
          if (currentContext.current === chosen.context) {
            setApprovalError(
              error instanceof Error
                ? error.message
                : 'Publication could not be confirmed. Refresh status before trying again.',
            );
          }
          throw error;
        }
      },
    );
  };
  return (
    <>
      {queuedNotice && (
        <p className="notice" role="status">
          {queuedNotice}
        </p>
      )}
      <Panel
        title={review ? 'Review & publish' : 'Your website'}
        subtitle="One approved version, delivered to the destination you choose."
        action={
          <Button variant="ghost" onClick={refresh} disabled={!!busy}>
            <RefreshCw size={15} />
            Refresh status
          </Button>
        }
      >
        {destinations.error && <p className="notice">{destinations.error}</p>}
        {destinations.loading ? (
          <p className="muted">Loading website connections…</p>
        ) : !all.length && !destinations.error ? (
          <Empty
            title="Choose where your business lives"
            action={
              canManage ? (
                <Button onClick={() => create('hosted')} busy={busy === 'Connect website'}>
                  <Globe size={16} />
                  Create Kulture website
                </Button>
              ) : undefined
            }
          >
            A hosted page with your services, hours, contact details and arrival guide. You can also
            connect WordPress below.
          </Empty>
        ) : (
          <>
            <div className="destination-tabs">
              {all.map((d: any) => (
                <button
                  key={d.id}
                  disabled={!!busy}
                  onClick={() => setSelected(d.id)}
                  className={d.id === target?.id ? 'selected' : ''}
                >
                  <Globe size={15} />
                  {d.kind === 'hosted'
                    ? 'Kulture website'
                    : d.kind === 'wordpress'
                      ? 'WordPress'
                      : 'Unknown destination'}
                  <Status value={d.state} />
                </button>
              ))}
            </div>
            {target && (
              <>
                <div className="site-address">
                  <div>
                    <span className="eyebrow">PUBLIC ADDRESS</span>
                    <p>{target.publicURL || 'Address not available'}</p>
                  </div>
                  <External href={target.publicURL}>Open site</External>
                </div>
                <div className="three-stats">
                  <div>
                    <span>Delivery state</span>
                    <Status value={target.state} />
                  </div>
                  <div>
                    <span>Last successful update</span>
                    <strong>{displayDate(target.lastSuccessAt)}</strong>
                  </div>
                  <div>
                    <span>Revision sequence</span>
                    <strong>{target.lastSequence ?? 'Not recorded'}</strong>
                  </div>
                </div>
                {target.lastError && (
                  <p className="notice">{deliveryMessage(String(target.lastError))}</p>
                )}
                <div className="website-photo-selection">
                  <button
                    className="website-photo-heading"
                    aria-expanded={mediaOpen}
                    onClick={() => setMediaOpen(!mediaOpen)}
                  >
                    <ImageIcon size={17} />
                    <span>Website photos</span>
                    <small>
                      {photoMode === 'retain'
                        ? 'Retain current published selection'
                        : `${assetIDs.length} selected for this preview`}
                    </small>
                  </button>
                  {mediaOpen && (
                    <div className="website-photo-body">
                      <p className="hint">
                        Only images explicitly approved for public use can be included. Upload and
                        approve new images in Photos & evidence.
                      </p>
                      <Field label="Photo selection">
                        <select
                          value={photoMode}
                          disabled={!!busy}
                          onChange={(e) => {
                            setPhotoMode(e.target.value as 'retain' | 'choose');
                            setArtifact(null);
                          }}
                        >
                          <option value="retain">Keep currently published photos</option>
                          <option value="choose">Choose approved photos for this version</option>
                        </select>
                      </Field>
                      {photoMode === 'retain' ? (
                        <p className="hint">
                          The server retains the last applied selection. For a first publication,
                          this includes no photos unless you choose them.
                        </p>
                      ) : (
                        <>
                          {media.loading && <p className="muted">Loading approved photos…</p>}
                          {media.error && (
                            <p className="notice">
                              Approved photo status could not be loaded: {media.error}
                            </p>
                          )}
                          {!media.loading && !media.error && !approvedPhotos.length && (
                            <p className="muted">
                              No currently approved public photos are available. Ready or private
                              uploads are not treated as approved.
                            </p>
                          )}
                          <div className="website-photo-grid">
                            {approvedPhotos.map((asset: any) => (
                              <ApprovedPhoto
                                key={asset.id + ':' + asset.revision}
                                asset={asset}
                                selected={assetIDs.includes(asset.id)}
                                disabled={!!busy}
                                onChange={(checked) => {
                                  setAssetIDs((ids) =>
                                    checked
                                      ? [...new Set([...ids, asset.id])]
                                      : ids.filter((id) => id !== asset.id),
                                  );
                                  setArtifact(null);
                                }}
                              />
                            ))}
                          </div>
                          {invalidSelection && (
                            <p className="notice">
                              A selected photo is no longer approved or available.{' '}
                              <Button
                                variant="secondary"
                                onClick={() => {
                                  setAssetIDs((ids) =>
                                    ids.filter((id) =>
                                      approvedPhotos.some((a: any) => a.id === id),
                                    ),
                                  );
                                  setArtifact(null);
                                }}
                              >
                                Remove unavailable selections
                              </Button>
                            </p>
                          )}
                          {!assetIDs.length && (
                            <p className="hint">
                              This explicit selection publishes no photos, including removal of
                              photos in the previous version. The exact preview shows the result.
                            </p>
                          )}
                        </>
                      )}
                      <Button variant="ghost" onClick={media.reload} disabled={!!busy}>
                        <RefreshCw size={14} />
                        Refresh photo approval status
                      </Button>
                    </div>
                  )}
                </div>
                <div className="actions">
                  <Button
                    onClick={openPreview}
                    disabled={
                      !draft ||
                      draft.state !== 'draft' ||
                      (photoMode === 'choose' &&
                        (media.loading || !!media.error || invalidSelection)) ||
                      !!busy
                    }
                    busy={busy === 'Render exact preview'}
                  >
                    <ShieldCheck size={16} />
                    Review current draft
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!canManage || !!busy}
                    onClick={() =>
                      run('Check public access', async () => {
                        await api(base + '/destinations/' + target.id + '/check', {
                          method: 'POST',
                          body: {},
                        });
                        refresh();
                      })
                    }
                  >
                    Check public access
                  </Button>
                </div>
                {!draft && (
                  <p className="hint">Save business details to create your first draft.</p>
                )}
                {draft && draft.state !== 'draft' && (
                  <p className="hint">
                    Create a new draft from Business details to publish another revision.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </Panel>
      {!review && canManage && (
        <div className="two-columns">
          <Panel
            title="Connect WordPress"
            subtitle="Manage one approved page or block. Keep your theme and other content."
          >
            <ol className="steps">
              <li>Install the Kulture Publisher plugin.</li>
              <li>Choose the page scope and create a pairing code in WordPress.</li>
              <li>Approve the same branch and site in both products.</li>
            </ol>
            <Field label="Pairing code">
              <input
                value={pairingCode}
                onChange={(e) => setPairingCode(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Button
              variant="secondary"
              onClick={() => create('wordpress')}
              disabled={!pairingCode || !!busy}
              busy={busy === 'Connect website'}
            >
              <Link size={15} />
              Pair website
            </Button>
            <p className="hint">
              <a href="/downloads/kulture-publisher.zip">Download the WordPress plugin</a>
            </p>
          </Panel>
          <Panel
            title="Use your own domain"
            subtitle="Domain ownership, DNS and secure routing are checked separately."
          >
            <Field label="Domain">
              <input
                value={hostname}
                onChange={(e) => setHostname(e.target.value.toLowerCase())}
                placeholder="www.yourbusiness.in"
              />
            </Field>
            <Button
              variant="secondary"
              disabled={!target || target.kind !== 'hosted' || !hostname || !!busy}
              onClick={() =>
                run('Create domain challenge', async () => {
                  const expected = context;
                  const result = await api(base + '/destinations/' + target.id + '/domain', {
                    method: 'POST',
                    body: { hostname },
                  });
                  if (currentContext.current === expected) {
                    setDomain(result);
                    setArtifact(null);
                    destinations.reload();
                  }
                })
              }
            >
              Get DNS instructions
            </Button>
            {domain?.challenge && (
              <div className="dns-instructions">
                <strong>Add the DNS ownership record</strong>
                <dl>
                  <dt>Type</dt>
                  <dd>{domain.challenge.type}</dd>
                  <dt>Name</dt>
                  <dd>{domain.challenge.name}</dd>
                  <dt>Value</dt>
                  <dd>{domain.challenge.value}</dd>
                  <dt>Expires</dt>
                  <dd>{displayDate(domain.challenge.expiresAt)}</dd>
                </dl>
                <p>Point this hostname to your Kulture server after verification.</p>
                <Button
                  variant="secondary"
                  disabled={!!busy}
                  onClick={() =>
                    run('Verify domain', async () => {
                      await api(base + '/destinations/' + target.id + '/domain/verify', {
                        method: 'POST',
                        body: {},
                      });
                      refresh();
                    })
                  }
                >
                  Verify DNS
                </Button>
              </div>
            )}
            {target?.domain && (
              <div className="website-domain-state">
                <div className="record">
                  <div>
                    <strong>{target.domain.hostname}</strong>
                    <p>Activation: {displayDate(target.domain.activatedAt)}</p>
                  </div>
                  <Status value={target.domain.state} />
                </div>
                <p className="hint">
                  A new hostname changes public and canonical URLs. Review the exact page before
                  activation. Existing published photos are revalidated for this migration.
                </p>
                <Button
                  variant="secondary"
                  disabled={target.domain.state !== 'tls_ready' || !!busy}
                  onClick={openDomainPreview}
                >
                  Review exact domain change
                </Button>
                {target.domain.state !== 'tls_ready' &&
                  target.domain.state !== 'live' &&
                  target.domain.state !== 'activating' && (
                    <p className="hint">
                      The server must confirm ownership, DNS routing and HTTPS before a migration
                      preview is available.
                    </p>
                  )}
              </div>
            )}
          </Panel>
        </div>
      )}
      {target && (
        <>
          <Panel
            title="Delivery history"
            subtitle="Queued, applied and independently verified are separate states."
          >
            {deliveries.error && <p className="notice">{deliveries.error}</p>}
            {deliveries.loading ? (
              <p className="muted">Loading delivery history…</p>
            ) : !deliveries.error && !deliveries.data?.deliveries?.length ? (
              <p className="muted">No deliveries yet.</p>
            ) : (
              !!deliveries.data?.deliveries?.length && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Revision</th>
                        <th>Status</th>
                        <th>Created</th>
                        <th>Verified</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries.data.deliveries.map((d: any) => (
                        <tr key={d.id}>
                          <td>#{d.sequence}</td>
                          <td>
                            <Status value={d.state} />
                            {d.errorCode && (
                              <small className="error-text">{deliveryMessage(d.errorCode)}</small>
                            )}
                          </td>
                          <td>{displayDate(d.createdAt)}</td>
                          <td>{displayDate(d.verifiedAt)}</td>
                          <td>
                            <div className="actions">
                              {canPublish && (
                                <>
                                  <Button
                                    variant="ghost"
                                    disabled={!!busy}
                                    onClick={() =>
                                      run('Retry delivery', async () => {
                                        await api(base + '/destinations/' + target.id + '/retry', {
                                          method: 'POST',
                                          body: { deliveryID: d.id },
                                        });
                                        refresh();
                                      })
                                    }
                                  >
                                    <RefreshCw size={14} />
                                    Retry
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    disabled={!!busy}
                                    onClick={() =>
                                      run('Prepare rollback', async () => {
                                        const expected = context;
                                        const result = await api(
                                          base + '/destinations/' + target.id + '/rollback',
                                          { method: 'POST', body: { deliveryID: d.id } },
                                        );
                                        if (currentContext.current !== expected) return;
                                        if (Array.isArray(result.assetIDs)) {
                                          setPhotoMode('choose');
                                          setAssetIDs(result.assetIDs);
                                        }
                                        onChange();
                                        refresh();
                                      })
                                    }
                                  >
                                    <Undo2 size={14} />
                                    Restore draft
                                  </Button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </Panel>
          <Panel
            title="Independent access checks"
            subtitle="These synthetic test fetches are excluded from organic crawler counts."
          >
            {access.error && <p className="notice">{access.error}</p>}
            {access.loading ? (
              <p className="muted">Loading completed checks…</p>
            ) : !access.error && !access.data?.observations?.length ? (
              <p className="muted">No completed access check. Run a check after publication.</p>
            ) : (
              access.data?.observations?.slice(0, 8).map((a: any) => (
                <div className="record" key={a.id}>
                  <div>
                    <strong>{String(a.outcome ?? 'Unknown outcome').replaceAll('_', ' ')}</strong>
                    <p>{a.observedURL ?? ''}</p>
                    {Array.isArray(a.checks) && (
                      <dl className="checks">
                        {a.checks.map((check: any, i: number) => (
                          <div key={check.name ?? i}>
                            <dt>{String(check.name ?? 'Check').replaceAll('_', ' ')}</dt>
                            <dd>
                              {check.status === 'pass'
                                ? 'Passed'
                                : check.status === 'fail'
                                  ? 'Needs attention'
                                  : 'Unknown'}
                              {check.detail ? ' · ' + check.detail : ''}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                  <small>{displayDate(a.observedAt)}</small>
                </div>
              ))
            )}
          </Panel>
          {canManage && (
            <div className="quiet-actions">
              <Button
                variant="ghost"
                disabled={!!busy}
                onClick={() => {
                  if (
                    confirm(
                      'Disconnect future Kulture updates? Existing website content will be retained.',
                    )
                  )
                    run('Disconnect website', async () => {
                      await api(base + '/destinations/' + target.id + '/disconnect', {
                        method: 'POST',
                        body: { retainContent: true },
                      });
                      refresh();
                    });
                }}
              >
                Disconnect future updates
              </Button>
            </div>
          )}
        </>
      )}
      {artifact && artifact.context === context && (
        <ExactReview
          key={artifact.key}
          artifact={artifact}
          approvalError={approvalError}
          busy={!!busy}
          canApprove={canPublish && (artifact.kind !== 'domain' || canManage)}
          onClose={() => setArtifact(null)}
          onApprove={() => {
            void approveArtifact();
          }}
        />
      )}
    </>
  );
}
