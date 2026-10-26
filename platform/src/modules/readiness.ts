import type { Hono } from 'hono';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { HttpError, withActor } from '../db.js';
import { requirePlacePermission } from './business-auth.js';

type Check = { id: string; label: string; weight: number; passed: boolean; action: string };
const present = (value: unknown, length = 1) => typeof value === 'string' && value.trim().length >= length;
const score = (checks: Check[]) => ({ score: checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0), checks });

export function calculateReadiness(profile: Record<string, any>, live: boolean) {
  const identity = present(profile.name, 2) && present(profile.category, 2);
  const location = present(profile.address, 5) && present(profile.neighborhood, 2);
  const summary = present(profile.summary, 80);
  const offerings = Array.isArray(profile.offerings) && profile.offerings.some((item: any) => present(item.name, 2) && present(item.category, 2));
  const hours = present(profile.hoursText, 6) || (Array.isArray(profile.hours?.weekly) && profile.hours.weekly.some((day: any) => day.state !== 'unknown'));
  const contact = present(profile.phone, 8) || present(profile.website, 8) || present(profile.publicEmail, 5);
  const check = (id: string, label: string, weight: number, passed: boolean, action: string): Check => ({ id, label, weight, passed, action });
  return {
    geo: score([
      check('identity', 'Clear business identity', 20, identity, 'Add your business name and category.'),
      check('summary', 'Useful business description', 20, summary, 'Write at least 80 characters describing what you offer.'),
      check('offerings', 'Named, categorized offerings', 20, offerings, 'Add and categorize at least one product or service.'),
      check('hours', 'Useful visiting hours', 10, hours, 'Add opening hours or an hours note.'),
      check('location', 'Specific location', 10, location, 'Complete the address and neighborhood.'),
      check('live', 'Publicly accessible source page', 20, live, 'Publish the approved business page.'),
    ]),
    seo: score([
      check('identity', 'Descriptive business name and category', 15, identity, 'Add your business name and category.'),
      check('summary', 'Description for the page', 15, summary, 'Write at least 80 characters describing the business.'),
      check('location', 'Address and neighborhood', 15, location, 'Complete the address and neighborhood.'),
      check('contact', 'Customer contact', 10, contact, 'Add a public phone, website or email.'),
      check('offerings', 'Product and service content', 10, offerings, 'Add and categorize at least one offering.'),
      check('live', 'Published canonical page', 20, live, 'Publish the approved business page.'),
      check('structured', 'Structured business data', 10, live, 'Publish the page to expose its business structured data.'),
      check('sitemap', 'Sitemap listing', 5, live, 'Publish the page to include it in the sitemap.'),
    ]),
  };
}

export function registerReadiness(app: Hono) {
  app.get('/v1/tenants/:tenantID/places/:placeID/readiness', async (c) => {
    const user = await requireUser(c);
    const tenant = z.uuid().parse(c.req.param('tenantID'));
    const place = z.string().min(1).max(160).parse(c.req.param('placeID'));
    const data = await withActor(user.id, async (db) => {
      await requirePlacePermission(db, tenant, place, 'view');
      const claim = (await db.query(
        "SELECT state FROM merchant_claims WHERE tenant_id=$1 AND place_id=$2 ORDER BY (state='approved') DESC,submitted_at DESC LIMIT 1",
        [tenant, place],
      )).rows[0];
      if (!claim) throw new HttpError(404, 'claim_not_found', 'Submit a claim for this business first.');
      const draft = (await db.query(
        'SELECT profile,updated_at FROM merchant_drafts WHERE tenant_id=$1 AND place_id=$2 ORDER BY updated_at DESC LIMIT 1',
        [tenant, place],
      )).rows[0];
      const publicPage = (await db.query(
        'SELECT page.canonical_path,page.published_at FROM public_pages page JOIN publications publication ON publication.id=page.publication_id WHERE page.place_id=$1 AND publication.tenant_id=$2 AND page.withdrawn_at IS NULL LIMIT 1',
        [place, tenant],
      )).rows[0];
      const placeRow = (await db.query('SELECT name,category,neighborhood,address,summary FROM places WHERE id=$1', [place])).rows[0];
      if (!placeRow) throw new HttpError(404, 'place_not_found', 'Business not found.');
      const profile = draft?.profile ?? placeRow;
      const live = !!publicPage;
      return {
        businessName: profile.name || placeRow.name,
        claimState: claim.state,
        profileSource: draft ? 'latest_saved_draft' : 'place_record',
        profileUpdatedAt: draft?.updated_at ?? null,
        publicURL: live ? config.publicURL + publicPage.canonical_path : null,
        sitemapURL: config.publicURL + '/sitemap.xml',
        computedAt: new Date().toISOString(),
        methodology: 'Deterministic readiness checklist from the latest saved business facts and current publication state. Saved changes can differ from the live page until republished. Scores do not measure search ranking, indexing, AI citations or recommendations.',
        ...calculateReadiness(profile, live),
      };
    });
    return c.json(data);
  });
}
