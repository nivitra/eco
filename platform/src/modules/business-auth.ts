import type { PoolClient } from 'pg';
import { HttpError } from '../db.js';
export type PlacePermission = 'view' | 'edit' | 'publish' | 'manage_destinations';
export async function requirePlacePermission(
  db: PoolClient,
  tenantID: string,
  placeID: string,
  permission: PlacePermission,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT m.role,m.scope_mode,m.can_publish,m.can_manage_destinations,
  EXISTS(SELECT 1 FROM membership_places s WHERE s.tenant_id=m.tenant_id AND s.user_id=m.user_id AND s.place_id=$2) AS in_scope
  FROM memberships m WHERE m.tenant_id=$1 AND m.user_id=current_setting('app.actor_id',true) AND m.state='active'`,
    [tenantID, placeID],
  );
  const m = rows[0];
  if (!m) throw new HttpError(404, 'workspace_not_found', 'Workspace not found');
  if (m.role === 'owner') return;
  if (m.scope_mode === 'selected' && !m.in_scope)
    throw new HttpError(
      404,
      'place_not_found',
      'Location is not available in your workspace scope',
    );
  const allowed =
    permission === 'view' ||
    (permission === 'edit' && ['editor', 'manager'].includes(m.role)) ||
    (permission === 'publish' && m.role === 'manager' && m.can_publish) ||
    (permission === 'manage_destinations' && m.role === 'manager' && m.can_manage_destinations);
  if (!allowed)
    throw new HttpError(
      403,
      'permission_required',
      'Your role does not permit this action for this location',
    );
}
