import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Field, Panel, CheckLine } from './ui';
import type { Profile } from './api';
function ListField({
  values,
  separator,
  onCommit,
  multiline = false,
}: {
  values: string[];
  separator: string;
  onCommit: (v: string[]) => void;
  multiline?: boolean;
}) {
  const [text, setText] = useState(values.join(separator)),
    [focused, setFocused] = useState(false),
    saved = values.join(separator);
  useEffect(() => {
    if (!focused) setText(saved);
  }, [saved, focused]);
  const props = {
    value: text,
    onFocus: () => setFocused(true),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setText(e.target.value);
      onCommit(
        e.target.value
          .split(separator.trim() || '\n')
          .map((v) => v.trim())
          .filter(Boolean),
      );
    },
    onBlur: () => {
      onCommit(
        text
          .split(separator.trim() || '\n')
          .map((v) => v.trim())
          .filter(Boolean),
      );
      setFocused(false);
    },
  };
  return multiline ? <textarea {...props} rows={2} /> : <input {...props} />;
}
export function Facts({
  profile: p,
  onChange,
  types,
  readOnly = false,
}: {
  profile: Profile;
  onChange: (p: Profile) => void;
  types: any[];
  readOnly?: boolean;
}) {
  const set = (k: string, v: unknown) => onChange({ ...p, [k]: v }),
    loc = (k: string, v: string) =>
      set('locality', {
        country: 'IN',
        state: '',
        city: '',
        citySlug: '',
        locality: '',
        street: '',
        ...p.locality,
        [k]: v || null,
      });
  return (
    <fieldset disabled={readOnly}>
      <Panel
        title="Business details"
        subtitle="The facts customers and discovery systems should find."
      >
        <div className="form-grid">
          <Field label="Business name">
            <input
              value={p.name}
              onChange={(e) => set('name', e.target.value)}
              maxLength={200}
              required
            />
          </Field>
          <Field label="Business type">
            <select
              value={p.businessType ?? ''}
              onChange={(e) => {
                const type = types.find((t) => t.id === e.target.value);
                onChange({
                  ...p,
                  businessType: type.id,
                  category: type.discoveryCategory ?? 'business',
                });
              }}
            >
              <option value="" disabled>
                Choose a business type
              </option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Public phone" hint="Include +91 for an Indian number.">
            <input
              type="tel"
              value={p.phone ?? ''}
              onChange={(e) => set('phone', e.target.value || null)}
              placeholder="+91"
            />
          </Field>
          <Field label="Public email">
            <input
              type="email"
              value={p.publicEmail ?? ''}
              onChange={(e) => set('publicEmail', e.target.value || null)}
            />
          </Field>
          <Field label="Existing website">
            <input
              type="url"
              value={p.website ?? ''}
              onChange={(e) => set('website', e.target.value || null)}
              placeholder="https://"
            />
          </Field>
          <Field label="Business status">
            <select value={p.status ?? 'unknown'} onChange={(e) => set('status', e.target.value)}>
              {['unknown', 'open', 'temporarily_closed', 'permanently_closed'].map((s) => (
                <option key={s} value={s}>
                  {s.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field
          label="What customers should know"
          hint="Useful, specific information. Avoid unsupported claims."
        >
          <textarea
            rows={4}
            value={p.summary}
            minLength={10}
            maxLength={2000}
            onChange={(e) => set('summary', e.target.value)}
          />
        </Field>
        <Field label="Tags" hint="Separate with commas; up to 15.">
          <ListField values={p.tags} separator=", " onCommit={(v) => set('tags', v)} />
        </Field>
        <Field
          label="Conditions"
          hint="One per line, such as appointment requirements or age restrictions."
        >
          <ListField
            values={p.conditions ?? []}
            separator={'\n'}
            multiline
            onCommit={(v) => set('conditions', v)}
          />
        </Field>
      </Panel>
      <Panel
        title="Location"
        subtitle="Help customers identify the right branch, building and floor."
      >
        <div className="form-grid">
          <Field label="Neighbourhood">
            <input
              value={p.neighborhood}
              onChange={(e) => {
                onChange({
                  ...p,
                  neighborhood: e.target.value,
                  ...(p.locality ? { locality: { ...p.locality, locality: e.target.value } } : {}),
                });
              }}
            />
          </Field>
          <Field label="Full address">
            <input value={p.address} onChange={(e) => set('address', e.target.value)} />
          </Field>
          <Field label="City">
            <input
              value={p.locality?.city ?? ''}
              onChange={(e) => {
                const city = e.target.value;
                set('locality', {
                  country: 'IN',
                  state: '',
                  locality: p.neighborhood,
                  street: p.address,
                  ...p.locality,
                  city,
                  citySlug: city
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, ''),
                });
              }}
            />
          </Field>
          <Field label="State / Union Territory">
            <input value={p.locality?.state ?? ''} onChange={(e) => loc('state', e.target.value)} />
          </Field>
          <Field label="Street">
            <input
              value={p.locality?.street ?? ''}
              onChange={(e) => loc('street', e.target.value)}
            />
          </Field>
          <Field label="PIN code">
            <input
              inputMode="numeric"
              pattern="[1-9][0-9]{5}"
              maxLength={6}
              value={p.locality?.postalCode ?? ''}
              onChange={(e) => loc('postalCode', e.target.value)}
            />
          </Field>
          {[
            ['building', 'Building / complex'],
            ['unit', 'Shop / unit'],
            ['floor', 'Floor label'],
            ['landmark', 'Landmark'],
          ].map(([k, label]) => (
            <Field key={k} label={label}>
              <input value={p.locality?.[k] ?? ''} onChange={(e) => loc(k, e.target.value)} />
            </Field>
          ))}
        </div>
        <Field
          label="Arrival note"
          hint="Text from the business; exact routes need a separate map review."
        >
          <textarea
            value={p.entranceNote ?? ''}
            onChange={(e) => set('entranceNote', e.target.value || null)}
            rows={3}
          />
        </Field>
      </Panel>
      <Panel title="Local names" subtitle="Keep English and local-script names together.">
        {(p.localizedNames ?? []).map((n: any, i: number) => (
          <div className="inline-fields" key={i}>
            <Field label="Language">
              <select
                value={n.language}
                onChange={(e) =>
                  set(
                    'localizedNames',
                    p.localizedNames.map((x: any, j: number) =>
                      j === i ? { ...x, language: e.target.value } : x,
                    ),
                  )
                }
              >
                {[
                  ['en', 'English'],
                  ['hi', 'Hindi'],
                  ['te', 'Telugu'],
                  ['ta', 'Tamil'],
                  ['mr', 'Marathi'],
                  ['kn', 'Kannada'],
                  ['ur', 'Urdu'],
                ].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name">
              <input
                value={n.name}
                onChange={(e) =>
                  set(
                    'localizedNames',
                    p.localizedNames.map((x: any, j: number) =>
                      j === i ? { ...x, name: e.target.value } : x,
                    ),
                  )
                }
              />
            </Field>
            <Button
              variant="ghost"
              type="button"
              aria-label="Remove local name"
              onClick={() =>
                set(
                  'localizedNames',
                  p.localizedNames.filter((_: any, j: number) => j !== i),
                )
              }
            >
              <Trash2 size={16} />
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          type="button"
          onClick={() =>
            set('localizedNames', [...(p.localizedNames ?? []), { language: 'te', name: '' }])
          }
        >
          <Plus size={15} />
          Add local name
        </Button>
      </Panel>
    </fieldset>
  );
}
export function Offerings({
  profile: p,
  onChange,
  readOnly = false,
}: {
  profile: Profile;
  onChange: (p: Profile) => void;
  readOnly?: boolean;
}) {
  const items = p.offerings ?? [],
    set = (v: any[]) => onChange({ ...p, offerings: v }),
    edit = (i: number, k: string, v: unknown) =>
      set(items.map((o, j) => (i === j ? { ...o, [k]: v } : o)));
  return (
    <fieldset disabled={readOnly}>
      <Panel
        title="Products & services"
        subtitle="Prices stay optional until you confirm them."
        action={
          <Button
            variant="secondary"
            type="button"
            onClick={() =>
              set([
                ...items,
                {
                  id: crypto.randomUUID(),
                  name: '',
                  description: null,
                  currency: 'INR',
                  priceQualifier: 'unknown',
                  priceMinor: null,
                  availability: 'unknown',
                },
              ])
            }
          >
            <Plus size={15} />
            Add offering
          </Button>
        }
      >
        {!items.length && (
          <p className="muted">
            Add your menu, products or services. Each item will appear in the exact publication
            preview.
          </p>
        )}
        {items.map((o, i) => (
          <div className="offering" key={o.id}>
            <div className="form-grid">
              <Field label="Name">
                <input value={o.name} onChange={(e) => edit(i, 'name', e.target.value)} />
              </Field>
              <Field label="Category">
                <input
                  value={o.category ?? ''}
                  onChange={(e) => edit(i, 'category', e.target.value || null)}
                />
              </Field>
              <Field label="Price type">
                <select
                  value={o.priceQualifier}
                  onChange={(e) => edit(i, 'priceQualifier', e.target.value)}
                >
                  {['unknown', 'fixed', 'from', 'range', 'on_request'].map((s) => (
                    <option key={s} value={s}>
                      {s.replaceAll('_', ' ')}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Price (₹)" hint="Stored precisely in paise.">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={o.priceMinor == null ? '' : o.priceMinor / 100}
                  onChange={(e) =>
                    edit(
                      i,
                      'priceMinor',
                      e.target.value === '' ? null : Math.round(Number(e.target.value) * 100),
                    )
                  }
                />
              </Field>
              {o.priceQualifier === 'range' && (
                <Field label="Maximum price (₹)">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={o.priceMaxMinor == null ? '' : o.priceMaxMinor / 100}
                    onChange={(e) =>
                      edit(
                        i,
                        'priceMaxMinor',
                        e.target.value === '' ? null : Math.round(Number(e.target.value) * 100),
                      )
                    }
                  />
                </Field>
              )}
              <Field label="Unit">
                <input
                  value={o.priceUnit ?? ''}
                  onChange={(e) => edit(i, 'priceUnit', e.target.value || null)}
                  placeholder="per person, per visit…"
                />
              </Field>
              <Field label="Availability">
                <select
                  value={o.availability}
                  onChange={(e) => edit(i, 'availability', e.target.value)}
                >
                  {['unknown', 'available', 'unavailable', 'seasonal'].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Description & inclusions">
              <textarea
                rows={2}
                value={o.description ?? ''}
                onChange={(e) => edit(i, 'description', e.target.value || null)}
              />
            </Field>
            <Button
              variant="ghost"
              type="button"
              onClick={() => set(items.filter((_, j) => j !== i))}
            >
              <Trash2 size={14} />
              Remove offering
            </Button>
          </div>
        ))}
      </Panel>
    </fieldset>
  );
}
export function Hours({
  profile: p,
  onChange,
  readOnly = false,
}: {
  profile: Profile;
  onChange: (p: Profile) => void;
  readOnly?: boolean;
}) {
  const h = p.hours ?? { timezone: 'Asia/Kolkata', weekly: [], exceptions: [] },
    set = (v: any) => onChange({ ...p, hours: v }),
    days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const day = (i: number) =>
    h.weekly.find((d: any) => d.day === i + 1) ?? { day: i + 1, state: 'unknown', periods: [] };
  const change = (i: number, d: any) =>
    set({
      ...h,
      weekly: [...h.weekly.filter((x: any) => x.day !== i + 1), d].sort((a, b) => a.day - b.day),
    });
  return (
    <fieldset disabled={readOnly}>
      <Panel
        title="Opening hours"
        subtitle="India Standard Time · split shifts, overnight hours and exceptions."
      >
        {days.map((name, i) => {
          const d = day(i);
          return (
            <div className="day-row" key={name}>
              <strong>{name}</strong>
              <select
                aria-label={`${name} status`}
                value={d.state}
                onChange={(e) =>
                  change(i, {
                    ...d,
                    state: e.target.value,
                    periods:
                      e.target.value === 'open'
                        ? [
                            {
                              opens: '09:00',
                              closes: '18:00',
                              endsNextDay: false,
                              appointmentOnly: false,
                            },
                          ]
                        : [],
                  })
                }
              >
                {['unknown', 'open', 'closed', 'appointment_only'].map((s) => (
                  <option key={s} value={s}>
                    {s.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
              <div className="periods">
                {d.periods.map((t: any, j: number) => (
                  <div className="period" key={j}>
                    <input
                      aria-label={`${name} opening ${j + 1}`}
                      type="time"
                      value={t.opens}
                      onChange={(e) =>
                        change(i, {
                          ...d,
                          periods: d.periods.map((v: any, k: number) =>
                            j === k ? { ...v, opens: e.target.value } : v,
                          ),
                        })
                      }
                    />
                    <span>—</span>
                    <input
                      aria-label={`${name} closing ${j + 1}`}
                      type="time"
                      value={t.closes}
                      onChange={(e) =>
                        change(i, {
                          ...d,
                          periods: d.periods.map((v: any, k: number) =>
                            j === k ? { ...v, closes: e.target.value } : v,
                          ),
                        })
                      }
                    />
                    <CheckLine
                      checked={t.endsNextDay}
                      onChange={(v) =>
                        change(i, {
                          ...d,
                          periods: d.periods.map((x: any, k: number) =>
                            j === k ? { ...x, endsNextDay: v } : x,
                          ),
                        })
                      }
                    >
                      Next day
                    </CheckLine>
                    {j > 0 && (
                      <Button
                        variant="ghost"
                        type="button"
                        aria-label="Remove period"
                        onClick={() =>
                          change(i, {
                            ...d,
                            periods: d.periods.filter((_: any, k: number) => k !== j),
                          })
                        }
                      >
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </div>
                ))}
                {d.state === 'open' && d.periods.length < 6 && (
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() =>
                      change(i, {
                        ...d,
                        periods: [
                          ...d.periods,
                          {
                            opens: '19:00',
                            closes: '22:00',
                            endsNextDay: false,
                            appointmentOnly: false,
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={13} />
                    Split shift
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </Panel>
      <Panel
        title="Dated exceptions"
        subtitle="Festival closures and special opening days override the weekly schedule."
        action={
          <Button
            variant="secondary"
            type="button"
            onClick={() =>
              set({
                ...h,
                exceptions: [...h.exceptions, { date: '', state: 'closed', periods: [], note: '' }],
              })
            }
          >
            <Plus size={14} />
            Add exception
          </Button>
        }
      >
        {h.exceptions.map((d: any, i: number) => (
          <div className="inline-fields" key={i}>
            <Field label="Date">
              <input
                type="date"
                value={d.date}
                onChange={(e) =>
                  set({
                    ...h,
                    exceptions: h.exceptions.map((x: any, j: number) =>
                      j === i ? { ...x, date: e.target.value } : x,
                    ),
                  })
                }
              />
            </Field>
            <Field label="Status">
              <select
                value={d.state}
                onChange={(e) =>
                  set({
                    ...h,
                    exceptions: h.exceptions.map((x: any, j: number) =>
                      j === i
                        ? {
                            ...x,
                            state: e.target.value,
                            periods:
                              e.target.value === 'open'
                                ? [
                                    {
                                      opens: '09:00',
                                      closes: '18:00',
                                      endsNextDay: false,
                                      appointmentOnly: false,
                                    },
                                  ]
                                : [],
                          }
                        : x,
                    ),
                  })
                }
              >
                {['closed', 'open', 'appointment_only', 'unknown'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            {d.state === 'open' &&
              d.periods.map((t: any, j: number) => (
                <div className="period" key={j}>
                  <input
                    type="time"
                    aria-label="Exception opening"
                    value={t.opens}
                    onChange={(e) =>
                      set({
                        ...h,
                        exceptions: h.exceptions.map((x: any, k: number) =>
                          k === i ? { ...x, periods: [{ ...t, opens: e.target.value }] } : x,
                        ),
                      })
                    }
                  />
                  <input
                    type="time"
                    aria-label="Exception closing"
                    value={t.closes}
                    onChange={(e) =>
                      set({
                        ...h,
                        exceptions: h.exceptions.map((x: any, k: number) =>
                          k === i ? { ...x, periods: [{ ...t, closes: e.target.value }] } : x,
                        ),
                      })
                    }
                  />
                </div>
              ))}
            <Field label="Note">
              <input
                value={d.note ?? ''}
                onChange={(e) =>
                  set({
                    ...h,
                    exceptions: h.exceptions.map((x: any, j: number) =>
                      j === i ? { ...x, note: e.target.value } : x,
                    ),
                  })
                }
              />
            </Field>
            <Button
              variant="ghost"
              type="button"
              aria-label="Remove exception"
              onClick={() =>
                set({ ...h, exceptions: h.exceptions.filter((_: any, j: number) => j !== i) })
              }
            >
              <Trash2 size={15} />
            </Button>
          </div>
        ))}
      </Panel>
    </fieldset>
  );
}
