import { canonical } from '../db.js';
import { config } from '../config.js';
import { escapeHTML, scriptJSON, type PageSnapshot } from './publishing.js';
import { businessTypes } from './business-profile.js';
import { sha256, RENDERER_VERSION, TEMPLATE_HASH } from './adapters/bundles.js';
export interface PublicAsset {
  id: string;
  url: string;
  sha256: string;
  mime: string;
  alt: string;
  width: number;
  height: number;
}
export interface SiteArtifact {
  fragment: string;
  html: string;
  metadata: Record<string, unknown>;
  artifactDigest: string;
  metadataDigest: string;
  rendererVersion: string;
  templateHash: string;
}
const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
function price(value: any): string {
  if (value.priceQualifier === 'on_request') return 'Price on request';
  if (value.priceQualifier === 'unknown' || value.priceMinor == null) return '';
  const money = (n: number) =>
    new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 2,
    }).format(n / 100);
  return (
    (value.priceQualifier === 'from' ? 'From ' : '') +
    money(value.priceMinor) +
    (value.priceQualifier === 'range' && value.priceMaxMinor != null
      ? '–' + money(value.priceMaxMinor)
      : '') +
    (value.priceUnit ? ' / ' + value.priceUnit : '')
  );
}
function hours(day: any): string {
  if (day.state === 'closed') return 'Closed';
  if (day.state === 'appointment_only') return 'By appointment';
  if (day.state !== 'open') return 'Confirm with the business';
  return list(day.periods)
    .map(
      (v) =>
        escapeHTML(v.opens) +
        '–' +
        escapeHTML(v.closes) +
        (v.endsNextDay ? ' next day' : '') +
        (v.appointmentOnly ? ' by appointment' : ''),
    )
    .join(', ');
}
/** One escaped, persisted HTML fragment is the managed artifact in both runtimes.
 * PHP places these exact reviewed bytes in a static HTML block; it does not reserialize facts.
 */
export function renderSiteArtifact(
  snapshot: PageSnapshot,
  target: {
    id: string;
    canonicalURL: string;
    sequence: number;
  },
  assets: PublicAsset[] = [],
): SiteArtifact {
  const p = snapshot.profile as any,
    e = escapeHTML;
  const offerings = list(p.offerings)
    .map(
      (o) =>
        `<li><h3>${e(String(o.name ?? o.title ?? ''))}</h3>${o.availability === 'unavailable' ? '<p>Currently unavailable</p>' : o.description ? `<p>${e(String(o.description))}</p>` : ''}${price(o) ? `<p>${e(price(o))}</p>` : ''}${o.conditions ? `<p>${e(String(o.conditions))}</p>` : ''}</li>`,
    )
    .join('');
  const structuredHours = p.hours
    ? `<p>Timezone: Asia/Kolkata</p><ul>${list(p.hours.weekly)
        .map(
          (day: any) =>
            `<li>${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][day.day - 1]}: ${hours(day)}</li>`,
        )
        .join('')}</ul>${list(p.hours.exceptions)
        .map((v: any) => `<p>${e(v.date)}: ${hours(v)}${v.note ? ' · ' + e(v.note) : ''}</p>`)
        .join('')}`
    : '';
  const contact = [
    p.phone ? `<a href="tel:${e(p.phone.replace(/[^+0-9]/g, ''))}">Call ${e(p.phone)}</a>` : '',
    p.publicEmail ? `<a href="mailto:${e(p.publicEmail)}">Email the business</a>` : '',
    p.website
      ? `<a href="${e(p.website)}" rel="noopener noreferrer">Business website / booking</a>`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const status =
    p.status === 'temporarily_closed'
      ? '<p class="notice">Temporarily closed — information supplied by the business.</p>'
      : p.status === 'permanently_closed'
        ? '<p class="notice">This location is permanently closed, as confirmed by its authorized business representative.</p>'
        : '';
  const fragment = `<!--kulture:begin:${target.id}:${target.sequence}--><article data-kulture-destination="${target.id}" data-kulture-sequence="${target.sequence}" lang="en-IN"><header><p>${e(p.businessType ?? p.category)} · ${e(p.neighborhood)}</p><h1>${e(p.name)}</h1>${status}<p>${e(p.summary)}</p></header><section><h2>Visit & contact</h2><address>${e(p.address)}</address>${p.locality ? `<p>${e([p.locality.city, p.locality.state, p.locality.postalCode].filter(Boolean).join(', '))}</p>` : ''}<p>${contact}</p></section>${offerings ? `<section><h2>Products & services</h2><ul>${offerings}</ul></section>` : ''}<section><h2>Hours</h2>${structuredHours || `<p>${e(p.hoursText ?? 'Current hours are not confirmed. Contact the business before leaving.')}</p>`}<p class="meta">Owner supplied; this is not live availability.</p></section>${assets.length ? `<section><h2>Photos</h2>${assets.map((a) => `<figure><img src="${e(a.url)}" alt="${e(a.alt)}" width="${a.width}" height="${a.height}" loading="lazy" decoding="async"></figure>`).join('')}</section>` : ''}<section><h2>Directions to the door</h2><p>${e(p.entranceNote ?? 'Exact entrance details have not been independently verified.')}</p><a href="${e(config.publicURL + '/places/' + encodeURIComponent(snapshot.placeID) + '/arrival')}">Open the arrival guide</a><p class="meta">Arrival capabilities depend on the currently published and reviewed guide.</p></section>${
    list(p.conditions).length
      ? `<section><h2>Before you visit</h2><ul>${list(p.conditions)
          .map((c) => `<li>${e(typeof c === 'string' ? c : String(c.text ?? c.label ?? ''))}</li>`)
          .join('')}</ul></section>`
      : ''
  }<footer><p>Business confirmed ${e(snapshot.ownerConfirmedAt.slice(0, 10))}. Ownership review does not independently verify every fact.</p><a href="${e(config.publicURL + '/places/' + encodeURIComponent(snapshot.placeID))}">Kulture business listing</a></footer></article><!--kulture:end-->`;
  const schema = {
    '@context': 'https://schema.org',
    '@type':
      businessTypes.find((t) => t.id === p.businessType)?.schemaType ??
      (p.category === 'cafes'
        ? 'CafeOrCoffeeShop'
        : p.category === 'food'
          ? 'Restaurant'
          : 'LocalBusiness'),
    '@id': target.canonicalURL + '#business',
    name: p.name,
    url: target.canonicalURL,
    description: p.summary,
    address: {
      '@type': 'PostalAddress',
      streetAddress: p.address,
      addressLocality: p.locality?.city ?? snapshot.city,
      addressRegion: p.locality?.state ?? undefined,
      postalCode: p.locality?.postalCode ?? undefined,
      addressCountry: 'IN',
    },
    ...(p.phone ? { telephone: p.phone } : {}),
  };
  const metadata = {
    canonical: target.canonicalURL,
    title: p.name,
    description: p.summary.slice(0, 160),
    language: 'en-IN',
    schema,
  };
  return {
    fragment,
    metadata,
    artifactDigest: sha256(fragment),
    metadataDigest: sha256(canonical(metadata)),
    rendererVersion: RENDERER_VERSION,
    templateHash: TEMPLATE_HASH,
    html: `<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(p.name)}</title><meta name="description" content="${e(p.summary.slice(0, 160))}"><link rel="canonical" href="${e(target.canonicalURL)}"><script type="application/ld+json">${scriptJSON(schema)}</script><style>body{margin:0;background:#081511;color:#f4f2e7;font:17px/1.6 system-ui}main{max-width:880px;margin:auto;padding:40px 24px}h1{font:600 clamp(34px,6vw,56px)/1.1 system-ui;letter-spacing:-1.2px}h2{font-size:25px;margin-top:38px}a{color:#ffa56a}address{font-style:normal}.meta,footer{color:#a6b9ab;font-size:14px}.notice{border-left:3px solid #ffa56a;padding:12px}img{max-width:100%;height:auto;border-radius:14px}figure{margin:18px 0}li{margin-bottom:14px}</style></head><body><main>${fragment}</main></body></html>`,
  };
}
export function extractManagedFragment(
  html: string,
  destinationID: string,
  sequence: number,
): string | null {
  const marker = `<!--kulture:begin:${destinationID}:${sequence}-->`,
    start = html.indexOf(marker);
  if (start < 0 || html.indexOf(marker, start + marker.length) >= 0) return null;
  const end = html.indexOf('<!--kulture:end-->', start);
  return end < 0 ? null : html.slice(start, end + '<!--kulture:end-->'.length);
}
