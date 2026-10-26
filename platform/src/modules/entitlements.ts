import type { PoolClient } from 'pg';
import { canonical, HttpError } from '../db.js';
export type LocationCapability =
  | 'publish'
  | 'adapter_sync'
  | 'map_publish'
  | 'essential_correction'
  | 'export';
export type Entitlement = {
  allowed: boolean;
  source: 'paid' | 'pilot' | 'grace' | 'none';
  validUntil: string | null;
  reason: string;
};
export async function locationEntitlement(
  db: PoolClient,
  {
    tenantID,
    placeID,
    capability,
    at = new Date(),
  }: { tenantID: string; placeID: string; capability: LocationCapability; at?: Date },
): Promise<Entitlement> {
  if (['essential_correction', 'export'].includes(capability))
    return {
      allowed: true,
      source: 'none',
      validUntil: null,
      reason:
        'Essential corrections and export remain available; ownership and permissions still apply',
    };
  const paid = (
    await db.query(
      `SELECT max(l.paid_until) AS until FROM payment_ledger l JOIN subscriptions s ON s.id=l.subscription_id WHERE s.tenant_id=$1 AND s.place_id=$2 AND l.refunded_at IS NULL AND l.disputed_at IS NULL AND l.period_start<=$3 AND l.paid_until>$3`,
      [tenantID, placeID, at],
    )
  ).rows[0];
  if (paid?.until)
    return {
      allowed: true,
      source: 'paid',
      validUntil: new Date(paid.until).toISOString(),
      reason: 'Captured payment covers this period',
    };
  const pilot = (
    await db.query(
      `SELECT max(ends_at) AS until FROM service_grants WHERE tenant_id=$1 AND place_id=$2 AND starts_at<=$3 AND ends_at>$3 AND revoked_at IS NULL`,
      [tenantID, placeID, at],
    )
  ).rows[0];
  if (pilot?.until)
    return {
      allowed: true,
      source: 'pilot',
      validUntil: new Date(pilot.until).toISOString(),
      reason: 'Time-limited pilot access',
    };
  const grace = (
    await db.query(
      `SELECT max(l.paid_until+interval '7 days') AS until FROM subscriptions s JOIN payment_ledger l ON l.subscription_id=s.id WHERE s.tenant_id=$1 AND s.place_id=$2 AND s.status IN('pending','halted','payment_failed') AND NOT s.cancel_at_period_end AND s.renewal_failed_at IS NOT NULL AND s.renewal_failed_at>=l.paid_until-interval '1 day' AND s.renewal_failed_at<=l.paid_until+interval '7 days' AND l.refunded_at IS NULL AND l.disputed_at IS NULL AND l.period_start IS NOT NULL AND l.paid_until<=$3 AND l.paid_until+interval '7 days'>$3`,
      [tenantID, placeID, at],
    )
  ).rows[0];
  if (grace?.until)
    return {
      allowed: true,
      source: 'grace',
      validUntil: new Date(grace.until).toISOString(),
      reason: 'Seven-day grace following a failed paid renewal',
    };
  return {
    allowed: false,
    source: 'none',
    validUntil: null,
    reason: 'An active location plan or explicit pilot grant is required',
  };
}
export async function requireLocationCapability(
  db: PoolClient,
  tenantID: string,
  placeID: string,
  capability: LocationCapability,
) {
  const result = await locationEntitlement(db, { tenantID, placeID, capability });
  if (!result.allowed) throw new HttpError(402, 'location_plan_required', result.reason);
  return result;
}

/** Diff classification, never a client-supplied correction flag. Rich content cannot expand here. */
export function classifyEssentialCorrection(
  before: unknown,
  after: unknown,
): { essential: boolean; changedFields: string[]; reason: string } {
  const a = (
    before && typeof before === 'object' && !Array.isArray(before) ? before : {}
  ) as Record<string, unknown>;
  const b = (after && typeof after === 'object' && !Array.isArray(after) ? after : {}) as Record<
    string,
    unknown
  >;
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (k) => canonical(a[k] ?? null) !== canonical(b[k] ?? null),
  );
  const correctionFields = new Set([
    'phone',
    'publicEmail',
    'address',
    'locality',
    'hours',
    'hoursText',
    'entranceNote',
    'status',
  ]);
  const removals = new Set(['offerings', 'conditions', 'tags', 'provenance']);
  const ok =
    Object.keys(a).length > 0 &&
    changed.every((k) => {
      if (correctionFields.has(k)) return true;
      if (removals.has(k)) {
        const old = Array.isArray(a[k]) ? (a[k] as unknown[]) : [],
          next = Array.isArray(b[k]) ? (b[k] as unknown[]) : [];
        return next.every((x) => old.some((y) => canonical(x) === canonical(y)));
      }
      return b[k] === null || b[k] === undefined || b[k] === '';
    });
  return {
    essential: ok,
    changedFields: changed,
    reason: ok
      ? 'Existing factual or safety correction without promotional expansion'
      : 'This change adds or rewrites ordinary promotional content',
  };
}
export async function requirePublicationCapability(
  db: PoolClient,
  tenantID: string,
  placeID: string,
  before: unknown,
  after: unknown,
) {
  const result = await locationEntitlement(db, { tenantID, placeID, capability: 'publish' });
  if (result.allowed) return result;
  if (classifyEssentialCorrection(before, after).essential)
    return locationEntitlement(db, { tenantID, placeID, capability: 'essential_correction' });
  throw new HttpError(402, 'location_plan_required', result.reason);
}
