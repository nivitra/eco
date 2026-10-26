import { useState } from 'react';
import { Check, Sparkles, Upload, X } from 'lucide-react';
import { uploadOfferingImage, type Profile } from './api';
import { Button, Field } from './ui';

type Suggestion = {
  id: string;
  selected: boolean;
  fileName: string;
  name: string;
  kind?: 'product' | 'service';
  category: string;
  description: string | null;
  priceMinor: number | null;
  priceQualifier: 'fixed' | 'from' | 'range' | 'on_request' | 'unknown';
  priceMaxMinor: number | null;
  priceUnit: string | null;
  confidence: 'high' | 'medium' | 'low';
  sourceType: 'printed_text' | 'visual_inference';
  sourceText: string | null;
};

export function OfferingImport({ base, profile, onChange, readOnly }: {
  base: string;
  profile: Profile;
  onChange: (next: Profile) => void;
  readOnly: boolean;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const edit = (id: string, patch: Partial<Suggestion>) =>
    setSuggestions((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  async function scan(files: File[]) {
    setError('');
    setNotice('');
    if (files.length > 3) return setError('Choose up to three images per scan.');
    if (files.some((file) => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024))
      return setError('Use JPEG, PNG or WebP images up to 5 MiB each.');
    setBusy(true);
    let added = 0;
    const failures: string[] = [];
    for (const [index, file] of files.entries()) {
      setProgress(`Scanning ${index + 1} of ${files.length}: ${file.name}`);
      try {
        const result = await uploadOfferingImage<{ items: Omit<Suggestion, 'id' | 'selected' | 'fileName'>[] }>(base, file);
        const found = result.items.map((item) => ({ ...item, id: crypto.randomUUID(), selected: true, fileName: file.name }));
        setSuggestions((current) => [...current, ...found]);
        added += found.length;
      } catch (cause) {
        failures.push(`${file.name}: ${cause instanceof Error ? cause.message : 'Scan failed'}`);
      }
    }
    setProgress('');
    setBusy(false);
    if (failures.length) setError(failures.join(' '));
    if (!failures.length) setNotice(added ? `${added} suggestion${added === 1 ? '' : 's'} ready for review.` : 'No recognizable offerings were found. Try a clearer image or add an offering manually.');
  }
  function addReviewed() {
    const selected = suggestions.filter((item) => item.selected && item.name.trim() && item.category.trim());
    if (!selected.length) return setError('Select at least one suggestion with a name and category.');
    const existing = profile.offerings ?? [];
    if (existing.length + selected.length > 250) return setError('A business can have at most 250 offerings.');
    const next = selected.map((item) => ({
      id: crypto.randomUUID(),
      name: item.name.trim(),
      kind: item.kind,
      category: item.category.trim(),
      description: item.description?.trim() || null,
      currency: 'INR',
      priceQualifier: item.priceQualifier,
      priceMinor: item.priceMinor,
      priceMaxMinor: item.priceQualifier === 'range' ? item.priceMaxMinor : null,
      priceUnit: item.priceUnit?.trim() || null,
      availability: 'unknown',
    }));
    if (next.some((item) => ['fixed', 'from', 'range'].includes(item.priceQualifier) && item.priceMinor == null || item.priceQualifier === 'range' && (item.priceMaxMinor == null || item.priceMinor != null && item.priceMaxMinor < item.priceMinor)))
      return setError('Check the selected price types and amounts before adding.');
    onChange({ ...profile, offerings: [...existing, ...next] });
    setSuggestions((current) => current.filter((item) => !item.selected));
    setError('');
    setNotice(`${next.length} reviewed offering${next.length === 1 ? '' : 's'} added to your private draft. Save the draft to keep them.`);
  }
  return <section className="import-studio" aria-label="Import offerings from images">
    <div className="import-studio-head">
      <div className="import-studio-icon"><Sparkles size={23} /></div>
      <div><h3>Turn images into offerings</h3><p>Upload a menu or product photo. AI groups the items; you check every detail before adding them.</p></div>
      <label className="button secondary import-upload"><Upload size={17} /> Upload images
        <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy || readOnly} onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void scan(files); }} />
      </label>
    </div>
    <p className="import-privacy">Up to 3 images per scan · 5 MiB each · Images are sent to DeepSeek for extraction and are not stored by Kulture. Suggestions stay private until you add and publish them.</p>
    {busy && <p className="import-progress" role="status"><span className="spinner-dot" />{progress}</p>}
    {error && <p className="notice" role="alert">{error}</p>}
    {notice && <p className="import-notice" role="status">{notice}</p>}
    {!!suggestions.length && <div className="import-review">
      <div className="import-review-title"><div><strong>Review suggestions</strong><p>Edit names, categories and prices before adding.</p></div><span>{suggestions.filter((item) => item.selected).length} selected</span></div>
      <div className="suggestion-grid">{suggestions.map((item) => <article className="suggestion-card" key={item.id}>
        <div className="suggestion-top"><label><input type="checkbox" checked={item.selected} onChange={(event) => edit(item.id, { selected: event.target.checked })} /> Include</label><span className={`confidence ${item.confidence}`}>{item.confidence} confidence</span><button type="button" aria-label={`Remove ${item.name} suggestion`} onClick={() => setSuggestions((current) => current.filter((entry) => entry.id !== item.id))}><X size={16} /></button></div>
        <div className="form-grid"><Field label="Offering name"><input value={item.name} onChange={(event) => edit(item.id, { name: event.target.value })} /></Field><Field label="Category"><input value={item.category} onChange={(event) => edit(item.id, { category: event.target.value })} /></Field><Field label="Type"><select value={item.kind ?? ''} onChange={(event) => edit(item.id, { kind: event.target.value ? event.target.value as Suggestion['kind'] : undefined })}><option value="">Choose type</option><option value="product">Product</option><option value="service">Service</option></select></Field><Field label="Price type"><select value={item.priceQualifier} onChange={(event) => edit(item.id, { priceQualifier: event.target.value as Suggestion['priceQualifier'] })}>{['unknown', 'fixed', 'from', 'range', 'on_request'].map((type) => <option key={type} value={type}>{type.replaceAll('_', ' ')}</option>)}</select></Field><Field label="Price (₹)"><input type="number" min="0" step="0.01" value={item.priceMinor == null ? '' : item.priceMinor / 100} onChange={(event) => edit(item.id, { priceMinor: event.target.value === '' ? null : Math.round(Number(event.target.value) * 100) })} /></Field>{item.priceQualifier === 'range' && <Field label="Maximum price (₹)"><input type="number" min="0" step="0.01" value={item.priceMaxMinor == null ? '' : item.priceMaxMinor / 100} onChange={(event) => edit(item.id, { priceMaxMinor: event.target.value === '' ? null : Math.round(Number(event.target.value) * 100) })} /></Field>}</div>
        <Field label="Description"><textarea rows={2} value={item.description ?? ''} onChange={(event) => edit(item.id, { description: event.target.value || null })} /></Field>
        <p className="suggestion-source">{item.sourceType === 'visual_inference' ? 'Inferred from the photo — verify carefully' : item.sourceText ? `Read from image: “${item.sourceText}”` : 'Read from image'} · {item.fileName}</p>
      </article>)}</div>
      <Button type="button" onClick={addReviewed} disabled={readOnly}><Check size={17} /> Add reviewed offerings</Button>
    </div>}
  </section>;
}
