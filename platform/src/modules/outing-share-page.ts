import type { CatalogPlace } from './consumer.js';

/** Only a public snapshot and current public place facts cross this boundary. */
export type SharedOutingPageSnapshot = {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  stops: { placeID: string; place: CatalogPlace | null }[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const e = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );
const text = (value: unknown, maximum: number): string =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, maximum)
    : '';

// The API emits UTC ISO timestamps. Round-trip validation also rejects rollover
// dates such as February 31, which Date.parse alone silently normalizes.
function date(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return null;
  const normalized = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  const result = new Date(normalized);
  return Number.isFinite(result.getTime()) && result.toISOString() === normalized ? result : null;
}

/** Links are user initiated; nothing in a source URL is fetched by this page. */
function sourceURL(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value))
    return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !url.hostname.includes('.') ||
      url.hostname.endsWith('.local') ||
      url.hostname.endsWith('.localhost') ||
      /^[\d.]+$/.test(url.hostname) ||
      url.hostname.includes(':')
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

const categoryTitles: Record<string, string> = {
  cafes: 'Cafés',
  food: 'Food',
  nightlife: 'Nightlife',
  nature: 'Nature',
  parks: 'Parks',
  heritage: 'Heritage',
  art: 'Art',
  shopping: 'Shopping',
  sports: 'Sports',
  games: 'Games',
  community: 'Community',
  stationery: 'Stationery',
  culture: 'Culture',
};

function stopCard(stop: SharedOutingPageSnapshot['stops'][number], index: number): string {
  const position = String(index + 1).padStart(2, '0');
  // A mismatched current record must never silently replace a shared stop.
  const place = stop.place?.id === stop.placeID ? stop.place : null;
  if (!place || !text(place.name, 200))
    return `<li class="stop unavailable">
    <div class="stop-number" aria-hidden="true">${position}</div>
    <article aria-labelledby="stop-${index}"><p class="eyebrow">Stop ${index + 1} · Unavailable</p>
      <h3 id="stop-${index}">This stop is no longer available</h3>
      <p class="muted">Its current public listing could not be found. The original position is kept so the order stays clear.</p>
    </article></li>`;
  const category = text(place.category, 100);
  const label = Object.hasOwn(categoryTitles, category)
    ? categoryTitles[category]
    : category.replace(/[_-]+/g, ' ');
  const neighborhood = text(place.neighborhood, 160);
  const address = text(place.address, 500);
  const seen = new Set<string>();
  const sources = (Array.isArray(place.sourceURLs) ? place.sourceURLs : [])
    .slice(0, 16)
    .flatMap((value) => {
      const url = sourceURL(value);
      if (!url || seen.has(url.href)) return [];
      seen.add(url.href);
      return [url];
    })
    .slice(0, 3);
  return `<li class="stop">
    <div class="stop-number" aria-hidden="true">${position}</div>
    <article aria-labelledby="stop-${index}"><p class="eyebrow">Stop ${index + 1}${label ? ` · ${e(label)}` : ''}</p>
      <h3 id="stop-${index}">${e(text(place.name, 200))}</h3>
      ${neighborhood ? `<p class="locality">${e(neighborhood)}</p>` : ''}
      ${address ? `<p class="address">${e(address)}</p>` : '<p class="address muted">Address not published. Check the source before travelling.</p>'}
      ${
        sources.length
          ? `<ul class="sources" aria-label="Sources for ${e(text(place.name, 200))}">${sources
              .map(
                (url) =>
                  `<li><a href="${e(url.href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${e(url.hostname.replace(/^www\./, ''))}<span aria-hidden="true"> ↗</span><span class="sr-only"> — source, opens a new tab</span></a></li>`,
              )
              .join('')}</ul>`
          : '<p class="source-note">No source link is available on this page.</p>'
      }
    </article></li>`;
}

const css = `
:root{color-scheme:light;--paper:#eeece7;--white:#fff;--ink:#17171c;--muted:#5d605e;--forest:#003c33;--line:#d7d9d0;--coral:#b84631}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;line-height:1.5}a{color:inherit;text-underline-offset:4px}a:focus-visible{outline:3px solid var(--coral);outline-offset:5px}a,button{-webkit-tap-highlight-color:transparent}.shell{max-width:1060px;margin:0 auto;padding:0 48px}.brand{display:flex;align-items:center;gap:12px;padding:32px 0;color:var(--forest);text-decoration:none}.mark{width:24px;height:24px;display:inline-block;border:2px solid currentColor;border-radius:50% 50% 2px 50%;transform:rotate(-25deg);flex:none}.wordmark{font-size:24px;font-weight:650;letter-spacing:-1px}.edition{padding-left:12px;border-left:1px solid var(--line);font:11px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:1.2px}.hero{padding:36px 0 36px;max-width:810px}.eyebrow{font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:1.1px;text-transform:uppercase;color:var(--forest);margin:0 0 12px}h1{font-size:clamp(38px,6.6vw,70px);line-height:1.06;font-weight:500;letter-spacing:-2.7px;margin:0 0 24px;overflow-wrap:anywhere}.dek{font-size:17px;line-height:1.6;color:var(--muted);max-width:590px;margin:0}.meta{display:flex;flex-wrap:wrap;gap:10px 22px;margin-top:24px;font-size:12px;color:var(--muted)}.meta strong{color:var(--forest);font-weight:600}.content{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:42px;align-items:start;padding-bottom:52px}.section-title{font-size:14px;font-weight:600;margin:0;padding:18px 0;border-top:1px solid var(--ink)}.stops{list-style:none;margin:0;padding:0}.stop{display:grid;grid-template-columns:38px minmax(0,1fr);gap:16px;padding:28px 0;border-top:1px solid var(--line)}.stop-number{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--forest);color:white;width:34px;height:34px;display:grid;place-items:center;border-radius:50%;margin-top:1px}.stop .eyebrow{margin-bottom:8px;font-size:10px}.stop h3{font-size:25px;line-height:1.18;font-weight:500;letter-spacing:-.6px;margin:0 0 10px;overflow-wrap:anywhere}.locality{font-size:14px;font-weight:500;margin:0 0 6px}.address{font-size:13px;line-height:1.6;color:var(--muted);margin:0;overflow-wrap:anywhere}.sources{display:flex;flex-wrap:wrap;gap:0 18px;list-style:none;margin:15px 0 0;padding:0}.sources a{font-size:11px;display:inline-flex;align-items:center;gap:5px;min-height:44px;overflow-wrap:anywhere}.source-note{font-size:11px;color:var(--muted);margin:15px 0 0}.unavailable .stop-number{background:transparent;border:1px solid var(--line);color:var(--muted)}.unavailable h3{font-size:21px}.muted{color:var(--muted);font-size:13px;margin:0;line-height:1.6}.aside{background:var(--white);border:1px solid var(--line);border-radius:3px;padding:24px;margin-top:0}.aside h2{font-size:24px;font-weight:500;letter-spacing:-.7px;line-height:1.14;margin:0 0 12px}.aside p{font-size:12px;line-height:1.7;color:var(--muted);margin:0 0 17px}.action{display:flex;align-items:center;justify-content:center;gap:10px;min-height:52px;padding:13px 19px;background:var(--ink);color:white;border-radius:30px;font-size:13px;font-weight:500;text-decoration:none;text-align:center;line-height:1.4}.aside .help{font-size:11px;margin:14px 0 0}.checklist{border-top:1px solid var(--line);margin-top:23px;padding-top:18px}.checklist h3{font-size:12px;margin:0 0 9px;font-weight:600}.checklist ul{padding-left:17px;margin:0;color:var(--muted);font-size:11px;line-height:1.7}.checklist li+li{margin-top:6px}.footer{border-top:1px solid var(--line);padding:22px 0 30px;display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;font-size:11px;color:var(--muted)}.footer p{margin:0;max-width:640px}.permalink{display:inline-flex;align-items:center;min-height:44px}.mobile-action{display:none}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.empty{max-width:660px;min-height:58vh;padding:65px 0 70px}.empty h1{font-size:clamp(36px,6vw,60px)}.empty p{font-size:16px;line-height:1.7;color:var(--muted);max-width:510px}.empty .hint{font-size:13px;margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}
@media(max-width:760px){.shell{padding:0 24px}.brand{padding:23px 0}.wordmark{font-size:22px}.hero{padding:24px 0 30px}h1{letter-spacing:-1.7px;margin-bottom:18px}.dek{font-size:15px}.content{grid-template-columns:minmax(0,1fr);gap:28px;padding-bottom:34px}.aside{padding:22px}.aside .action{display:none}.aside h2{font-size:25px}.meta{font-size:11px;gap:8px 17px}.stop{gap:13px;padding:24px 0;grid-template-columns:32px minmax(0,1fr)}.stop-number{width:30px;height:30px;font-size:11px}.stop h3{font-size:24px}.footer{padding-bottom:130px}.mobile-action{display:block;position:fixed;bottom:0;left:0;right:0;background:var(--paper);border-top:1px solid var(--line);padding:12px 24px max(16px,env(safe-area-inset-bottom));z-index:2}.mobile-action p{text-align:center;font-size:10px;color:var(--muted);margin:7px 0 0}.empty-page .footer{padding-bottom:30px}.empty{min-height:55vh;padding-top:36px}}
@media(prefers-reduced-motion:no-preference){.action{transition:background-color .18s}.action:hover{background:var(--forest)}}
@media print{.mobile-action,.action,.help,.permalink{display:none}.shell{max-width:none;padding:0}.content{grid-template-columns:1fr}.aside{break-inside:avoid}.stop{break-inside:avoid}.footer{padding-bottom:0}}
`;

function document(title: string, body: string, publicURL?: string, empty = false): string {
  return `<!doctype html>
<html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,nosnippet"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#EEECE7">
<title>${e(title)} · Kulture Edit</title>${publicURL ? `<link rel="canonical" href="${e(publicURL)}">` : ''}
<style>${css}</style></head><body${empty ? ' class="empty-page"' : ''}><div class="shell">
<header class="brand" aria-label="Kulture Edit"><span class="mark" aria-hidden="true"></span><span class="wordmark">kulture</span><span class="edition">EDIT</span></header>
${body}
</div></body></html>`;
}

export function renderUnavailableSharedOuting(): string {
  return document(
    'Outing unavailable',
    `<main class="empty"><p class="eyebrow">Shared outing</p>
<h1>This link has reached<br>the end of its outing.</h1>
<p>The outing may have expired, been removed, or the link may be incorrect.</p>
<p class="hint">Ask the person who shared it for a fresh link. If you already saved the outing in Kulture Edit, look in Plans.</p></main>
<footer class="footer"><p>Kulture Edit · A little more city.</p></footer>`,
    undefined,
    true,
  );
}

export function renderSharedOuting(snapshot: SharedOutingPageSnapshot, publicURL: string): string {
  const created = date(snapshot?.createdAt),
    expires = date(snapshot?.expiresAt);
  if (
    snapshot?.version !== 1 ||
    !UUID.test(snapshot.id) ||
    !text(snapshot.title, 240) ||
    !created ||
    !expires ||
    expires <= created ||
    expires.getTime() <= Date.now() ||
    !Array.isArray(snapshot.stops) ||
    snapshot.stops.length < 1 ||
    snapshot.stops.length > 8 ||
    snapshot.stops.some(
      (stop) =>
        !stop || typeof stop.placeID !== 'string' || !stop.placeID || stop.placeID.length > 160,
    ) ||
    new Set(snapshot.stops.map((stop) => stop.placeID)).size !== snapshot.stops.length
  )
    return renderUnavailableSharedOuting();
  const canonical = sourceURL(publicURL);
  if (
    !canonical ||
    canonical.pathname !== `/outings/${snapshot.id}` ||
    canonical.search ||
    canonical.hash
  )
    return renderUnavailableSharedOuting();
  const appURL = `kulture-edit://outing/${snapshot.id}`;
  const title = text(snapshot.title, 240);
  const expiryLabel =
    new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(expires) + ' IST';
  const action = `<a class="action" href="${appURL}">Open in Kulture Edit<span aria-hidden="true"> ↗</span></a>`;
  return document(
    title,
    `<main>
<section class="hero" aria-labelledby="outing-title"><p class="eyebrow">Shared outing · Draft plan</p>
<h1 id="outing-title">${e(title)}</h1><p class="dek">A plan worth getting out for. A few places, in an order you can make your own.</p>
<div class="meta"><strong>${snapshot.stops.length} ${snapshot.stops.length === 1 ? 'stop' : 'stops'} · In shared order</strong><span>Link expires <time datetime="${e(expires.toISOString())}">${e(expiryLabel)}</time></span></div></section>
<div class="content"><section aria-labelledby="stops-title"><h2 class="section-title" id="stops-title">The places, in order</h2>
<ol class="stops">${snapshot.stops.map(stopCard).join('')}</ol></section>
<aside class="aside" aria-labelledby="take-it-title"><h2 id="take-it-title">Take the plan<br>with you.</h2>
<p>Open this link in Kulture Edit to review the stops and save your own copy.</p>${action}
<p class="help">Requires Kulture Edit on your iPhone. If it isn't installed, you can use the places and source links here. This page does not install the app.</p>
<div class="checklist"><h3>Before you go</h3><ul><li>This is a draft order, not a booking or a checked schedule.</li><li>Confirm opening hours, prices and access with each place.</li><li>Routes, travel times and entrances have not been verified by this shared page.</li></ul></div></aside></div>
</main><footer class="footer"><p>This is a copy of the shared plan, with current public listing details. Later edits to the original plan are not reflected here.</p><a class="permalink" href="${e(canonical.href)}" referrerpolicy="no-referrer">This outing's link</a></footer>
<div class="mobile-action" aria-label="Open outing in the app">${action}<p>Have Kulture Edit installed? Continue in the app.</p></div>`,
    canonical.href,
  );
}
