import type { Hono, Context } from 'hono';
import { createHash } from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import { escapeHTML, type PageSnapshot } from './publishing.js';
function serveHTML(c: Context, html: string, digest?: string) {
  const etag = '"' + (digest ?? createHash('sha256').update(html).digest('hex')) + '"';
  c.header('ETag', etag);
  c.header('Cache-Control', 'public, max-age=0, must-revalidate');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  c.header('Content-Type', 'text/html; charset=utf-8');
  if (
    c.req
      .header('If-None-Match')
      ?.split(',')
      .map((v) => v.trim())
      .includes(etag)
  )
    return c.body(null, 304);
  return c.body(html, 200);
}
function shell(title: string, body: string) {
  return `<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#081511"><title>${escapeHTML(title)} | Kulture</title><style>*{box-sizing:border-box}body{background:#081511;color:#f4f2e7;font:16px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0}main{max-width:880px;margin:auto;padding:clamp(28px,6vw,64px) 24px 80px}nav{margin-bottom:clamp(40px,8vw,72px)}.brand{color:#f4f2e7;font-size:21px;font-weight:650;letter-spacing:-.7px;text-decoration:none}.brand span{color:#ffa56a}a{color:#ffa56a;text-underline-offset:4px}a:hover{text-decoration-thickness:2px}a:focus-visible{outline:2px solid #ffa56a;outline-offset:5px;border-radius:3px}h1{font-size:clamp(32px,6vw,48px);line-height:1.12;letter-spacing:-1.6px;font-weight:600;margin:0 0 24px;text-wrap:balance}h2{font-size:24px;line-height:1.3;font-weight:550;letter-spacing:-.5px;margin-top:36px}p{max-width:680px;color:#a6b9ab}article{padding:24px 0;border-bottom:1px solid #29483a}small{color:#a6b9ab;font-size:13px}.home-action{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin:30px 0 42px}.home-action>span{font-size:13px;color:#a6b9ab;max-width:230px}.primary-link{display:inline-flex;align-items:center;justify-content:center;gap:18px;min-height:48px;padding:12px 18px;background:#f58d4d;color:#14251a;border:1px solid #f58d4d;border-radius:8px;text-decoration:none;font-size:14px;font-weight:650}.primary-link:hover{background:#ffa56a;border-color:#ffa56a}@media(max-width:480px){main{padding-inline:20px}.home-action{align-items:flex-start;flex-direction:column;gap:12px}}</style></head><body><main><nav aria-label="Main"><a class="brand" href="/">kulture<span aria-hidden="true">.</span></a></nav><h1>${escapeHTML(title)}</h1>${body}</main></body></html>`;
}
/** Exact Host dispatch. X-Forwarded-Host is never treated as authority. */
export function registerHostedHostRouting(app: Hono) {
  app.use('*', async (c, next) => {
    if (process.env.DOMAIN_AUTHORITY_ONLY === 'true') {
      if (
        c.req.path === '/internal/caddy/ask' ||
        c.req.path === '/health/live' ||
        c.req.path === '/health/ready'
      )
        return next();
      return c.notFound();
    }
    const raw = c.req.header('Host') ?? new URL(c.req.url).host,
      expected = new URL(config.publicURL).host;
    if (raw.toLowerCase() === expected.toLowerCase()) return next();
    const host = raw.toLowerCase();
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(host)) return c.text('Unknown host', 421);
    const state = (await query('SELECT * FROM public_domain_status($1)', [host])).rows[0];
    if (!state) return c.text('Unknown host', 421);
    const age = state.paused_at ? (Date.now() - new Date(state.paused_at).getTime()) / 86400000 : 0;
    if (age >= 120) return c.text('Website binding expired', 410);
    if (age >= 90)
      return serveHTML(
        c,
        shell(
          'This website has moved',
          `<p>This business website is in its migration window. Its basic listing remains available.</p><a href="${escapeHTML(config.publicURL + '/places/' + encodeURIComponent(state.place_id))}">Open the Kulture listing</a>`,
        ),
      );
    const site = (await query('SELECT * FROM published_host($1)', [host])).rows[0];
    if (!site)
      return c.req.path === '/'
        ? serveHTML(
            c,
            shell(
              'Domain connected',
              '<p>HTTPS is ready. The business owner must approve the website and canonical migration before this site goes live.</p>',
            ),
          )
        : c.notFound();
    if (c.req.path === '/robots.txt')
      return c.text(`User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`);
    if (c.req.path === '/sitemap.xml') {
      const projection = (
        await query(
          'SELECT published_at FROM hosted_sites WHERE destination_id=$1 AND withdrawn_at IS NULL',
          [site.destination_id],
        )
      ).rows[0];
      c.header('Content-Type', 'application/xml');
      return c.body(
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escapeHTML(site.canonical_url)}</loc>${projection ? `<lastmod>${new Date(projection.published_at).toISOString()}</lastmod>` : ''}</url></urlset>`,
      );
    }
    if (c.req.path !== '/') return c.notFound();
    const delivery = (
      await query('SELECT delivery_id FROM hosted_sites WHERE destination_id=$1', [
        site.destination_id,
      ])
    ).rows[0];
    if (delivery) c.header('X-Kulture-Delivery-ID', delivery.delivery_id);
    return serveHTML(c, site.html, site.digest);
  });
}
export function registerPublic(app: Hono) {
  app.get('/sites/:placeID', async (c) => {
    const row = (await query('SELECT * FROM public_hosted_site($1)', [c.req.param('placeID')]))
      .rows[0];
    if (!row) return c.notFound();
    const age = row.paused_at ? (Date.now() - new Date(row.paused_at).getTime()) / 86400000 : 0;
    if (age >= 90) return c.redirect(config.publicURL + row.canonical_path, 302);
    if (
      new URL(row.canonical_url).origin !== new URL(config.publicURL).origin &&
      (
        await query('SELECT state FROM public_domain_status($1)', [
          new URL(row.canonical_url).hostname,
        ])
      ).rows[0]
    )
      return c.redirect(row.canonical_url, 308);
    const delivery = (
      await query('SELECT delivery_id FROM hosted_sites WHERE place_id=$1', [
        c.req.param('placeID'),
      ])
    ).rows[0];
    if (delivery) c.header('X-Kulture-Delivery-ID', delivery.delivery_id);
    return serveHTML(c, row.html, row.digest);
  });
  app.get('/places/:placeID', async (c) => {
    const row = (
      await query(
        'SELECT canonical_path FROM public_pages WHERE place_id=$1 AND withdrawn_at IS NULL',
        [c.req.param('placeID')],
      )
    ).rows[0];
    return row ? c.redirect(row.canonical_path, 308) : c.notFound();
  });
  app.get('/', async (c) => {
    const { rows } = await query(
      "SELECT DISTINCT split_part(canonical_path,'/',2) AS city FROM public_pages WHERE withdrawn_at IS NULL ORDER BY city",
    );
    return serveHTML(
      c,
      shell(
        'The life of the city',
        `<p>Explore places maintained by the people behind them. Find useful facts, sources and practical arrival notes.</p><p class="home-action"><a class="primary-link" href="/console/">Open business console <span aria-hidden="true">↗</span></a><span>Manage your business details and publications.</span></p>${
          rows.length
            ? '<ul>' +
              rows
                .map(
                  (r) =>
                    `<li><a href="/${escapeHTML(r.city)}">${escapeHTML(
                      r.city
                        .split('-')
                        .map((v: string) => v.charAt(0).toUpperCase() + v.slice(1))
                        .join(' '),
                    )}</a></li>`,
                )
                .join('') +
              '</ul>'
            : '<p>Our first business pages are being reviewed. No owner-verified public listings are live yet.</p>'
        }<p><a href="/discovery-methodology">How we measure discovery</a></p><p><small>₹299 per physical location per month. Publishing does not guarantee a search position or an AI recommendation. Any pilot has an explicit expiry.</small></p>`,
      ),
    );
  });
  app.get('/robots.txt', (c) => {
    c.header('Cache-Control', 'public,max-age=300');
    return c.text(
      `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /v1/\nAllow: /v1/media/public/\nDisallow: /internal/\nDisallow: /health/\nSitemap: ${config.publicURL}/sitemap.xml\n`,
    );
  });
  const sitemapRows = `WITH directory AS (
        SELECT $1::text||canonical_path AS url,published_at FROM public_pages WHERE withdrawn_at IS NULL
    ), hosted AS (
        SELECT site.canonical_url AS url,h.published_at FROM hosted_sites h
        CROSS JOIN LATERAL public_hosted_site(h.place_id) site
        WHERE h.withdrawn_at IS NULL AND site.canonical_url=$1::text||'/sites/'||h.place_id
        AND (site.paused_at IS NULL OR site.paused_at>now()-interval '90 days')
    ), cities AS (
        SELECT DISTINCT $1::text||'/'||split_part(canonical_path,'/',2) AS url,NULL::timestamptz AS published_at
        FROM public_pages WHERE withdrawn_at IS NULL
    ) SELECT url,max(published_at) AS published_at FROM (
        SELECT * FROM directory UNION ALL SELECT * FROM hosted UNION ALL SELECT * FROM cities
    ) entries GROUP BY url`;
  const sitemapPageSize = 45000;
  const sitemapXML = (rows: any[]) =>
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.map((r) => `<url><loc>${escapeHTML(r.url)}</loc>${r.published_at ? `<lastmod>${new Date(r.published_at).toISOString()}</lastmod>` : ''}</url>`).join('')}</urlset>`;
  app.get('/sitemap.xml', async (c) => {
    const { rows } = await query(`${sitemapRows} ORDER BY url LIMIT $2`, [
      config.publicURL,
      sitemapPageSize + 1,
    ]);
    c.header('Content-Type', 'application/xml; charset=utf-8');
    c.header('Cache-Control', 'public,max-age=0,must-revalidate');
    if (rows.length <= sitemapPageSize) return c.body(sitemapXML(rows));
    const count = Number(
      (await query(`SELECT count(*) AS count FROM (${sitemapRows}) all_urls`, [config.publicURL]))
        .rows[0].count,
    );
    const links = Array.from(
      { length: Math.ceil(count / sitemapPageSize) },
      (_, page) =>
        `<sitemap><loc>${escapeHTML(config.publicURL + '/sitemaps/' + (page + 1) + '.xml')}</loc></sitemap>`,
    ).join('');
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${links}</sitemapindex>`,
    );
  });
  app.get('/sitemaps/:page', async (c) => {
    const match = /^([1-9][0-9]{0,5})\.xml$/.exec(c.req.param('page'));
    if (!match) return c.notFound();
    const { rows } = await query(`${sitemapRows} ORDER BY url LIMIT $2 OFFSET $3`, [
      config.publicURL,
      sitemapPageSize,
      (Number(match[1]) - 1) * sitemapPageSize,
    ]);
    if (!rows.length) return c.notFound();
    c.header('Content-Type', 'application/xml; charset=utf-8');
    c.header('Cache-Control', 'public,max-age=0,must-revalidate');
    return c.body(sitemapXML(rows));
  });
  app.get('/discovery-methodology', (c) =>
    serveHTML(
      c,
      shell(
        'Measured discovery, clearly explained',
        `<p>A published page is available on Kulture. External search and AI systems decide what to fetch, index, cite or recommend.</p><h2>What the counters mean</h2><p>Verified search-crawler HTML deliveries count status-200 page responses with a matching provider user agent and source IP in a current official range snapshot. We exclude our own synthetic checks. A request is not a person, a citation, a completed visit or a sale.</p><p>Training crawlers and user-triggered fetches are separate from search crawlers. A status-304 revalidation is not another delivered page. Bot-like requests without verified source evidence remain unverified.</p><p>The dashboard states its observation period and whether log coverage is partial or unavailable. Missing data is never displayed as a measured zero. The current pipeline does not claim complete visibility across the internet.</p><h2>Business information</h2><p>Ownership approval establishes who may maintain a listing. Business statements about hours or entrances remain owner supplied unless explicitly backed by a separate independent check. We do not promise current availability or traffic-aware routes from a listing.</p><h2>Privacy and corrections</h2><p>Crawler records contain a rotating date-scoped hash instead of raw source IPs. Infrastructure logs require separately controlled retention. Operators can withdraw inaccurate or unauthorized pages while a correction is reviewed. No private claims or ownership documents appear on public pages.</p>`,
      ),
    ),
  );
  app.get('/:city', async (c) => {
    const city = c.req.param('city');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(city)) return c.notFound();
    const pageRaw = Number(c.req.query('page') ?? '1'),
      page = Number.isInteger(pageRaw) && pageRaw > 0 && pageRaw <= 1000 ? pageRaw : 1;
    const { rows } = await query(
      'SELECT canonical_path,snapshot FROM public_pages WHERE withdrawn_at IS NULL AND canonical_path LIKE $1 ORDER BY canonical_path LIMIT 31 OFFSET $2',
      [`/${city}/places/%`, (page - 1) * 30],
    );
    if (!rows.length) return c.notFound();
    const cards = rows
      .slice(0, 30)
      .map((r) => {
        const s = r.snapshot as PageSnapshot;
        return `<article><small>${escapeHTML(s.profile.category)} · ${escapeHTML(s.profile.neighborhood)}</small><h2><a href="${escapeHTML(r.canonical_path)}">${escapeHTML(s.profile.name)}</a></h2><p>${escapeHTML(s.profile.summary)}</p></article>`;
      })
      .join('');
    return serveHTML(
      c,
      shell(
        city
          .split('-')
          .map((v) => v.charAt(0).toUpperCase() + v.slice(1))
          .join(' '),
        `<p>Published business profiles. A selected collection, not every place in the city.</p>${cards}<nav>${page > 1 ? `<a href="/${city}?page=${page - 1}">Previous</a> ` : ''}${rows.length > 30 ? `<a href="/${city}?page=${page + 1}">Next</a>` : ''}</nav>`,
      ),
    );
  });
  app.get('/:city/places/:slug', async (c) => {
    const city = c.req.param('city'),
      slug = c.req.param('slug');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(city) || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(slug))
      return c.notFound();
    const { rows } = await query(
      'SELECT html,digest,revision,published_at FROM public_pages WHERE canonical_path=$1 AND withdrawn_at IS NULL',
      [`/${city}/places/${slug}`],
    );
    if (!rows[0]) return c.notFound();
    c.header('X-Kulture-Page-Revision', String(rows[0].revision));
    c.header('Last-Modified', new Date(rows[0].published_at).toUTCString());
    return serveHTML(c, rows[0].html, rows[0].digest);
  });
}
