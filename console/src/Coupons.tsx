import { useEffect, useState } from 'react';
import { ArrowRight, Copy, ExternalLink, Gift, Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { api, type Profile } from './api';
import { useResource } from './hooks';
import { Button, Field, Panel } from './ui';

type Scope = 'selected' | 'all_products' | 'all_services' | 'all_offerings';
type DiscountKind = 'percent' | 'amount';
type Coupon = {
  id: string; code: string; title: string; description: string; terms: string;
  discountKind: DiscountKind; discountValue: number; scope: Scope; offeringIDs: string[];
  startsOn: string | null; endsOn: string | null; enabled: boolean; version: number;
  publiclyVisible: boolean; createdAt: string;
};
type CouponList = { claimState: string; publicURL: string | null; coupons: Coupon[] };
type Draft = Omit<Coupon, 'id' | 'version' | 'publiclyVisible' | 'createdAt'>;
const initialDraft = (): Draft => ({
  code: '', title: '', description: '', terms: '', discountKind: 'percent', discountValue: 10,
  scope: 'all_offerings', offeringIDs: [], startsOn: null, endsOn: null, enabled: false,
});
const scopeNames: Record<Scope, string> = {
  all_offerings: 'Every product & service',
  all_products: 'Every product',
  all_services: 'Every service',
  selected: 'Selected items only',
};
const discountText = (coupon: Pick<Coupon, 'discountKind' | 'discountValue'>) =>
  coupon.discountKind === 'percent' ? `${coupon.discountValue}% off` :
    `${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(coupon.discountValue / 100)} off`;
function indiaDate() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function couponState(coupon: Coupon, list: CouponList | null) {
  if (!coupon.enabled) return 'Off';
  const today = indiaDate();
  if (coupon.endsOn && coupon.endsOn < today) return 'Expired';
  if (coupon.startsOn && coupon.startsOn > today) return 'Scheduled';
  if (coupon.publiclyVisible) return 'Public now';
  if (list?.claimState !== 'approved') return 'Awaiting ownership';
  if (!list?.publicURL) return 'Awaiting publication';
  return 'Publish eligible items';
}

export function Coupons({ base, profile, dirty, readOnly, onSaveDraft, onEditOfferings }: {
  base: string;
  profile: Profile;
  dirty: boolean;
  readOnly: boolean;
  onSaveDraft: () => Promise<void>;
  onEditOfferings: () => void;
}) {
  const resource = useResource<CouponList>(base + '/coupons');
  const [form, setForm] = useState<Draft>(initialDraft);
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const offerings = (profile.offerings ?? []) as { id: string; name: string; kind?: 'product' | 'service'; availability?: string }[];
  const available = offerings.filter((item) => item.availability !== 'unavailable');
  const applicable = form.scope === 'all_products' ? available.filter((item) => item.kind === 'product') :
    form.scope === 'all_services' ? available.filter((item) => item.kind === 'service') :
      form.scope === 'selected' ? available.filter((item) => form.offeringIDs.includes(item.id)) : available;
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setForm((current) => ({ ...current, [key]: value }));
  useEffect(() => { setForm(initialDraft()); setEditing(null); setFormOpen(false); setError(''); setSuccess(''); }, [base]);
  function openCreate() { setForm(initialDraft()); setEditing(null); setFormOpen(true); setError(''); setSuccess(''); }
  function openEdit(coupon: Coupon) {
    setForm({ code: coupon.code, title: coupon.title, description: coupon.description, terms: coupon.terms,
      discountKind: coupon.discountKind, discountValue: coupon.discountValue, scope: coupon.scope,
      offeringIDs: coupon.offeringIDs, startsOn: coupon.startsOn, endsOn: coupon.endsOn, enabled: coupon.enabled });
    setEditing(coupon); setFormOpen(true); setError(''); setSuccess('');
  }
  async function submit() {
    setError(''); setSuccess('');
    if (dirty) return setError('Save your business details and offerings before creating a coupon.');
    if (readOnly) return setError('Your role cannot manage coupons.');
    if (!form.title.trim() || !form.code.trim()) return setError('Add a title and coupon code.');
    if (!applicable.length) return setError(form.scope === 'selected' ? 'Select at least one available offering.' : 'Add and classify an available offering for this coupon scope.');
    setBusy('save');
    try {
      if (editing) await api(base + '/coupons/' + editing.id, { method: 'PUT', body: { ...form, version: editing.version } });
      else await api(base + '/coupons', { method: 'POST', body: form });
      resource.reload(); setFormOpen(false); setEditing(null);
      setSuccess(editing ? 'Coupon updated.' : 'Coupon created.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The coupon could not be saved.'); }
    finally { setBusy(''); }
  }
  async function toggle(coupon: Coupon) {
    setError(''); setSuccess(''); setBusy(coupon.id);
    try {
      await api(base + '/coupons/' + coupon.id + '/toggle', { method: 'PATCH', body: { version: coupon.version, enabled: !coupon.enabled } });
      resource.reload(); setSuccess(coupon.enabled ? 'Coupon turned off.' : 'Coupon turned on.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The coupon could not be changed.'); resource.reload(); }
    finally { setBusy(''); }
  }
  async function archive(coupon: Coupon) {
    if (!confirm(`Archive ${coupon.code}? The code will stop appearing publicly.`)) return;
    setError(''); setSuccess(''); setBusy(coupon.id);
    try {
      await api(base + '/coupons/' + coupon.id, { method: 'DELETE', body: { version: coupon.version } });
      resource.reload(); setSuccess('Coupon archived.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The coupon could not be archived.'); resource.reload(); }
    finally { setBusy(''); }
  }
  async function copyCode(code: string) {
    try { await navigator.clipboard.writeText(code); setSuccess(`${code} copied.`); }
    catch { setError('Could not copy automatically. Select the code and copy it.'); }
  }
  const coupons = resource.data?.coupons ?? [];
  const active = coupons.filter((coupon) => coupon.enabled).length;
  return <div className="coupon-page">
    <section className="coupon-hero">
      <div><span className="eyebrow">OFFERS FOR YOUR BUSINESS</span><h2>Give customers a reason to come back.</h2><p>Create a clear offer, choose exactly what it covers, and switch it on or off at any time.</p></div>
      <Button onClick={openCreate} disabled={readOnly}><Plus size={18} /> Create coupon</Button>
    </section>
    <div className="coupon-stats"><div><strong>{coupons.length}</strong><span>Total coupons</span></div><div><strong>{active}</strong><span>Switched on</span></div><div><strong>{coupons.filter((coupon) => coupon.publiclyVisible).length}</strong><span>Public now</span></div></div>
    {resource.error && <p className="notice" role="alert">{resource.error} <Button variant="ghost" onClick={resource.reload}>Retry</Button></p>}
    {error && <p className="notice" role="alert">{error}</p>}
    {success && <p className="import-notice" role="status">{success}</p>}
    {dirty && <Panel title="Save your offerings first" subtitle="Coupon eligibility uses the latest saved business draft."><p>Your current business edits are still being saved. Save them before creating or changing coupon details.</p><Button onClick={() => void onSaveDraft()} disabled={readOnly}>Save business draft</Button></Panel>}
    {resource.data?.claimState !== 'approved' && resource.data && <div className="notice">Coupons may be prepared now. They only become public after ownership approval and a live business page.</div>}
    {resource.data?.publicURL && <p className="coupon-public-link"><a href={resource.data.publicURL} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} /> Open public coupon page</a><span>The page updates when coupons are switched on or off.</span></p>}
    {!formOpen && <Panel title="Your coupons" subtitle="Switch a coupon off to remove it from the public offer page immediately." action={<Button variant="secondary" onClick={openCreate} disabled={readOnly}><Plus size={16} /> New coupon</Button>}>
      {resource.loading && !resource.data && <p>Loading coupons…</p>}
      {!resource.loading && !coupons.length && <div className="coupon-empty"><Gift size={31} /><h3>Your first offer starts here</h3><p>Add a coupon for selected offerings, every product, every service, or everything you sell.</p><Button onClick={openCreate} disabled={readOnly}>Create a coupon <ArrowRight size={16} /></Button></div>}
      <div className="coupon-list">{coupons.map((coupon) => <article className="coupon-card" key={coupon.id}>
        <div className="coupon-card-top"><span className="coupon-discount">{discountText(coupon)}</span><span className={`coupon-state ${coupon.publiclyVisible ? 'live' : coupon.enabled ? 'pending' : ''}`}>{couponState(coupon, resource.data)}</span></div>
        <h3>{coupon.title}</h3>{coupon.description && <p>{coupon.description}</p>}
        <div className="coupon-code-row"><code>{coupon.code}</code><button type="button" onClick={() => void copyCode(coupon.code)} aria-label={`Copy ${coupon.code}`}><Copy size={16} /></button></div>
        <p className="coupon-scope"><Tag size={15} /> {scopeNames[coupon.scope]}{coupon.scope === 'selected' ? ` · ${coupon.offeringIDs.length} item${coupon.offeringIDs.length === 1 ? '' : 's'}` : ''}</p>
        <p className="coupon-dates">{coupon.startsOn ? `From ${coupon.startsOn}` : 'Available immediately'}{coupon.endsOn ? ` · Until ${coupon.endsOn}` : ' · No end date'}</p>
        <div className="coupon-card-actions"><button className={`coupon-switch ${coupon.enabled ? 'on' : ''}`} role="switch" aria-checked={coupon.enabled} aria-label={`${coupon.enabled ? 'Turn off' : 'Turn on'} ${coupon.code}`} disabled={readOnly || !!busy} onClick={() => void toggle(coupon)}><i /><span>{coupon.enabled ? 'On' : 'Off'}</span></button><Button variant="ghost" onClick={() => openEdit(coupon)} disabled={readOnly || !!busy}><Pencil size={15} /> Edit</Button><Button variant="ghost" onClick={() => void archive(coupon)} disabled={readOnly || !!busy}><Trash2 size={15} /> Archive</Button></div>
      </article>)}</div>
    </Panel>}
    {formOpen && <Panel title={editing ? 'Edit coupon' : 'Create a coupon'} subtitle="The details below are shown to customers when this offer is live." action={<Button variant="ghost" onClick={() => setFormOpen(false)}>Cancel</Button>}>
      <fieldset disabled={readOnly || !!busy}>
        <div className="form-grid"><Field label="Coupon title"><input maxLength={100} value={form.title} onChange={(event) => update('title', event.target.value)} placeholder="20% off your next visit" /></Field><Field label="Coupon code"><input maxLength={24} value={form.code} onChange={(event) => update('code', event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))} placeholder="WELCOME20" autoCapitalize="characters" /></Field></div>
        <Field label="Short description"><textarea maxLength={500} rows={2} value={form.description} onChange={(event) => update('description', event.target.value)} placeholder="What will customers get?" /></Field>
        <div className="form-grid"><Field label="Discount type"><select value={form.discountKind} onChange={(event) => setForm((current) => ({ ...current, discountKind: event.target.value as DiscountKind, discountValue: event.target.value === 'percent' ? 10 : 10000 }))}><option value="percent">Percentage off</option><option value="amount">Fixed amount off</option></select></Field><Field label={form.discountKind === 'percent' ? 'Discount (%)' : 'Discount (₹)'}><input type="number" min={form.discountKind === 'percent' ? 1 : 0.01} max={form.discountKind === 'percent' ? 100 : 100000} step={form.discountKind === 'percent' ? 1 : 0.01} value={form.discountKind === 'percent' ? form.discountValue : form.discountValue / 100} onChange={(event) => update('discountValue', form.discountKind === 'percent' ? Number(event.target.value) : Math.round(Number(event.target.value) * 100))} /></Field></div>
        <div className="coupon-scope-picker"><h3>What does it apply to?</h3><p>Only published offerings can appear on the customer page.</p><div>{(Object.keys(scopeNames) as Scope[]).map((scope) => <label className={form.scope === scope ? 'selected' : ''} key={scope}><input type="radio" name="coupon-scope" checked={form.scope === scope} onChange={() => setForm((current) => ({ ...current, scope, offeringIDs: scope === 'selected' ? current.offeringIDs : [] }))} /><span>{scopeNames[scope]}</span><small>{scope === 'all_products' ? `${available.filter((item) => item.kind === 'product').length} products` : scope === 'all_services' ? `${available.filter((item) => item.kind === 'service').length} services` : scope === 'all_offerings' ? `${available.length} offerings` : 'Pick below'}</small></label>)}</div></div>
        {form.scope === 'selected' && <div className="coupon-offering-list"><strong>Choose eligible offerings</strong>{available.map((item) => <label key={item.id}><input type="checkbox" checked={form.offeringIDs.includes(item.id)} onChange={(event) => update('offeringIDs', event.target.checked ? [...form.offeringIDs, item.id] : form.offeringIDs.filter((id) => id !== item.id))} /><span>{item.name}</span><small>{item.kind ?? 'Type not set'}</small></label>)}</div>}
        {!applicable.length && <div className="coupon-help">No available offering matches this scope. Add an offering or set its type in Products & services. <Button variant="ghost" type="button" onClick={onEditOfferings}>Edit offerings <ArrowRight size={14} /></Button></div>}
        <div className="form-grid"><Field label="Start date" hint="Optional · India time"><input type="date" value={form.startsOn ?? ''} onChange={(event) => update('startsOn', event.target.value || null)} /></Field><Field label="End date" hint="Optional · India time"><input type="date" min={form.startsOn ?? undefined} value={form.endsOn ?? ''} onChange={(event) => update('endsOn', event.target.value || null)} /></Field></div>
        <Field label="Terms & conditions"><textarea maxLength={600} rows={3} value={form.terms} onChange={(event) => update('terms', event.target.value)} placeholder="One use per customer, dine-in only, cannot be combined with other offers…" /></Field>
        <label className="coupon-activate"><input type="checkbox" checked={form.enabled} onChange={(event) => update('enabled', event.target.checked)} /><span><strong>Turn coupon on</strong><small>Visible publicly when the claim is approved, the business page is live and the offer is in date.</small></span></label>
      </fieldset>
      <div className="actions"><Button onClick={() => void submit()} busy={busy === 'save'} disabled={readOnly || dirty || !applicable.length}>{editing ? 'Save coupon' : 'Create coupon'}</Button><Button variant="ghost" onClick={() => setFormOpen(false)}>Cancel</Button></div>
    </Panel>}
  </div>;
}
