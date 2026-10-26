import { useCallback, useEffect, useRef, useState } from 'react';
import { api, APIError, type Profile } from './api';
import { merchantProfileSchema } from '../../platform/src/modules/business-profile';
import { loadMapRecovery, saveMapRecovery } from './maps/draft-cache';
export type FactDraft = {
  id: string;
  version: number;
  state: string;
  profile: Profile;
  rightsConfirmed: boolean;
  [key: string]: unknown;
};
export type FactSnapshot = {
  profile: Profile;
  rights: boolean;
  draft: FactDraft | null;
  placeRevision: number;
};
export type FactConflictField = { key: string; label: string; local: unknown; remote: unknown };
export type FactConflict = { fields: FactConflictField[]; merged: Record<string, unknown> };
export type FactState = {
  baseline: FactSnapshot;
  profile: Profile;
  rights: boolean;
  conflict: FactConflict | null;
};
export type FactRecovery = {
  version: 1;
  savedAt: string;
  baseline: FactSnapshot;
  profile: Profile;
  rights: boolean;
};
export type FactValidationIssue = { path: string; message: string };
export function validateFactProfile(profile: Profile): FactValidationIssue[] {
  const parsed = merchantProfileSchema.safeParse(profile);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || 'profile',
        message: issue.message,
      }));
}
export class FactValidationError extends Error {
  constructor(public issues: FactValidationIssue[]) {
    super(
      'Complete the draft fields: ' +
        issues
          .slice(0, 4)
          .map((i) => i.path + ': ' + i.message)
          .join('; '),
    );
  }
}
export type FactRequest = (path: string, options?: Parameters<typeof api>[1]) => Promise<any>;
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
        .join(',') +
      '}'
    );
  return JSON.stringify(v) ?? 'undefined';
}
export const sameFact = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export const factDirty = (s: FactState) =>
  !sameFact(s.profile, s.baseline.profile) || s.rights !== s.baseline.rights;
export function factSnapshot(detail: any): FactSnapshot {
  if (!detail?.place?.id) throw new Error('A current location response is required.');
  const draft = detail.draft ?? null;
  let profile: Profile;
  if (draft?.profile) profile = structuredClone(draft.profile);
  else if (detail.place.publishedFacts) profile = structuredClone(detail.place.publishedFacts);
  else {
    const keys = [
      'name',
      'category',
      'neighborhood',
      'address',
      'summary',
      'tags',
      'phone',
      'website',
      'hoursText',
      'entranceNote',
      'businessType',
      'businessTypeLabel',
      'locality',
      'hours',
      'offerings',
      'localizedNames',
      'conditions',
      'status',
      'publicEmail',
      'provenance',
    ];
    profile = Object.fromEntries(
      keys
        .filter((k) => detail.place[k] !== undefined)
        .map((k) => [k, structuredClone(detail.place[k])]),
    ) as Profile;
    profile.tags ??= [];
    profile.summary ??= '';
    profile.category ??= 'business';
    profile.neighborhood ??= '';
    profile.address ??= '';
  }
  return {
    profile,
    rights: draft?.rightsConfirmed ?? false,
    draft,
    placeRevision: detail.place.revision,
  };
}
export const initialFactState = (s: FactSnapshot): FactState => ({
  baseline: s,
  profile: structuredClone(s.profile),
  rights: s.rights,
  conflict: null,
});
function flatten(profile: Profile, rights: boolean): Record<string, unknown> {
  return Object.fromEntries([
    ...Object.entries(profile).map(([k, v]) => ['profile.' + k, v]),
    ['rightsConfirmed', rights],
  ]);
}
function unflatten(fields: Record<string, unknown>) {
  return {
    profile: Object.fromEntries(
      Object.entries(fields)
        .filter(([k, v]) => k.startsWith('profile.') && v !== undefined)
        .map(([k, v]) => [k.slice(8), v]),
    ) as Profile,
    rights: fields.rightsConfirmed === true,
  };
}
export function mergeFactState(state: FactState, remote: FactSnapshot): FactState {
  if (!factDirty(state)) return initialFactState(remote);
  const before = flatten(state.baseline.profile, state.baseline.rights),
    mine = flatten(state.profile, state.rights),
    theirs = flatten(remote.profile, remote.rights),
    merged = { ...theirs },
    fields: FactConflictField[] = [];
  for (const key of new Set([
    ...Object.keys(before),
    ...Object.keys(mine),
    ...Object.keys(theirs),
  ])) {
    if (sameFact(mine[key], before[key])) merged[key] = theirs[key];
    else if (sameFact(theirs[key], before[key]) || sameFact(mine[key], theirs[key]))
      merged[key] = mine[key];
    else
      fields.push({
        key,
        label: key === 'rightsConfirmed' ? 'Publication permission' : key.slice(8),
        local: mine[key],
        remote: theirs[key],
      });
  }
  return fields.length
    ? { ...state, baseline: remote, conflict: { fields, merged } }
    : { baseline: remote, ...unflatten(merged), conflict: null };
}
export function chooseFactConflict(state: FactState, key: string, useLocal: boolean): FactState {
  const c = state.conflict,
    f = c?.fields.find((x) => x.key === key);
  return !c || !f
    ? state
    : {
        ...state,
        conflict: {
          fields: c.fields.filter((x) => x.key !== key),
          merged: { ...c.merged, [key]: useLocal ? f.local : f.remote },
        },
      };
}
export function finishFactConflict(state: FactState): FactState {
  if (!state.conflict) return state;
  if (state.conflict.fields.length) throw new Error('Choose every conflicting field.');
  return { ...state, ...unflatten(state.conflict.merged), conflict: null };
}
/** Never marks edits typed during an in-flight request as saved. */
export function acknowledgeFactSave(
  current: FactState,
  submitted: FactState,
  draft: FactDraft,
): FactState {
  if (current.baseline.draft?.id === draft.id && current.baseline.draft.version > draft.version)
    return current;
  return {
    ...current,
    baseline: {
      ...submitted.baseline,
      profile: structuredClone(draft.profile ?? submitted.profile),
      rights: draft.rightsConfirmed ?? submitted.rights,
      draft,
    },
  };
}
export async function saveFactSnapshot(
  base: string,
  s: FactState,
  request: FactRequest = api,
  signal?: AbortSignal,
  key = crypto.randomUUID(),
): Promise<FactDraft> {
  if (s.conflict) throw new Error('Resolve concurrent changes before saving.');
  const issues = validateFactProfile(s.profile);
  if (issues.length) throw new FactValidationError(issues);
  const d = s.baseline.draft,
    edit = d?.state === 'draft';
  const value = await request(
    edit ? base + '/drafts/' + encodeURIComponent(d.id) : base + '/drafts',
    {
      method: edit ? 'PATCH' : 'POST',
      ...(edit ? { version: d.version } : {}),
      body: {
        profile: s.profile,
        rightsConfirmed: s.rights,
        ...(!edit ? { basePlaceRevision: s.baseline.placeRevision } : {}),
      },
      key,
      signal,
    },
  );
  return value.draft ?? value;
}
export interface UseFactDraftOptions {
  scope: string | null;
  detail: any | null;
  base: string;
  enabled: boolean;
  onError?: (e: Error) => void;
  onSaved?: (draft: FactDraft) => void;
  debounceMs?: number;
}
const matches = (detail: any, base: string) =>
  !!detail?.place?.id && decodeURIComponent(base.split('/').at(-1) ?? '') === detail.place.id;
/** scope = origin + authenticated user ID + tenant ID + place ID; null until current authorization is known. */
export function useFactDraft(options: UseFactDraftOptions) {
  const { scope, detail, base, enabled, debounceMs = 1200 } = options;
  const [state, setState] = useState<FactState | null>(null),
    [status, setStatus] = useState('Loading saved facts…'),
    [saving, setSaving] = useState(false),
    [recovery, setRecovery] = useState<FactRecovery | null>(null),
    [ready, setReady] = useState(false),
    [accessLost, setAccessLost] = useState(false),
    [retryBlocked, setRetryBlocked] = useState(false);
  const active = useRef({ scope: null as string | null, generation: 0 }),
    current = useRef(state),
    pending = useRef<Promise<FactDraft> | null>(null),
    abort = useRef<AbortController | null>(null),
    writes = useRef(Promise.resolve()),
    opts = useRef(options),
    loaded = useRef<string | null>(null),
    wasEnabled = useRef(enabled);
  current.current = state;
  opts.current = options;
  const apply = useCallback((next: FactState | null) => {
    current.current = next;
    setState(next);
  }, []);
  const persist = useCallback((scope: string, value: FactRecovery | null) => {
    writes.current = writes.current
      .catch(() => {})
      .then(() => saveMapRecovery('facts|' + scope, value));
    return writes.current;
  }, []);
  useEffect(() => {
    if (active.current.scope !== scope) {
      active.current = { scope, generation: active.current.generation + 1 };
      abort.current?.abort();
      pending.current = null;
      loaded.current = null;
      apply(null);
      setRecovery(null);
      setReady(false);
      setSaving(false);
      setAccessLost(false);
      setRetryBlocked(false);
    }
    if (wasEnabled.current !== enabled) {
      wasEnabled.current = enabled;
      if (!enabled) {
        active.current.generation++;
        abort.current?.abort();
        pending.current = null;
        loaded.current = null;
        setSaving(false);
        setReady(false);
        setRecovery(null);
      }
    }
    if (!scope || !matches(detail, base)) {
      setReady(false);
      return;
    }
    const generation = active.current.generation,
      remote = factSnapshot(detail),
      old = current.current;
    if (old?.conflict) return;
    if (
      old?.baseline.draft &&
      remote.draft &&
      old.baseline.draft.id === remote.draft.id &&
      remote.draft.version < old.baseline.draft.version
    )
      return;
    const next = old ? mergeFactState(old, remote) : initialFactState(remote);
    apply(next);
    setAccessLost(false);
    setStatus(
      next.conflict
        ? 'Another editor changed these facts. Choose which values to keep.'
        : factDirty(next)
          ? 'Changes waiting to save'
          : 'Saved on server · not published',
    );
    if (!enabled) {
      setReady(false);
      setRecovery(null);
      return;
    }
    if (loaded.current === scope) {
      setReady(true);
      return;
    }
    loaded.current = scope;
    setReady(false);
    void loadMapRecovery<FactRecovery>('facts|' + scope)
      .then((saved) => {
        if (
          active.current.generation !== generation ||
          !opts.current.enabled ||
          opts.current.scope !== scope
        )
          return;
        if (
          saved?.version === 1 &&
          saved.profile &&
          saved.baseline &&
          (!sameFact(saved.profile, remote.profile) || saved.rights !== remote.rights)
        ) {
          setRecovery(saved);
          setStatus('Encrypted recovery is available for this account and location.');
        }
        setReady(true);
      })
      .catch(() => {
        if (active.current.generation === generation) {
          setReady(true);
          setStatus('Local recovery unavailable; keep this tab open until saved.');
        }
      });
  }, [scope, detail, base, enabled, apply]);
  useEffect(
    () => () => {
      abort.current?.abort();
      active.current.generation++;
    },
    [],
  );
  const save = useCallback(async (): Promise<FactDraft> => {
    if (pending.current) return pending.current;
    const snapshot = current.current,
      o = opts.current,
      generation = active.current.generation;
    if (
      !snapshot ||
      !o.scope ||
      active.current.scope !== o.scope ||
      !o.enabled ||
      !ready ||
      recovery ||
      snapshot.conflict ||
      accessLost
    )
      throw new Error('Current authorization and reconciled facts are required before saving.');
    const controller = new AbortController();
    abort.current = controller;
    setSaving(true);
    setRetryBlocked(false);
    setStatus('Saving to server…');
    const promise = (async () => {
      try {
        const draft = await saveFactSnapshot(
          o.base,
          structuredClone(snapshot),
          api,
          controller.signal,
        );
        if (generation !== active.current.generation)
          throw new DOMException('Location changed', 'AbortError');
        const next = acknowledgeFactSave(current.current ?? snapshot, snapshot, draft);
        apply(next);
        if (!factDirty(next)) await persist(o.scope!, null).catch(() => {});
        if (generation !== active.current.generation)
          throw new DOMException('Location changed', 'AbortError');
        setStatus(
          factDirty(next) ? 'New changes waiting to save' : 'Saved on server · not published',
        );
        o.onSaved?.(draft);
        return draft;
      } catch (error) {
        if (generation !== active.current.generation) throw error;
        setRetryBlocked(true);
        if (error instanceof APIError && [409, 412].includes(error.status)) {
          let fresh: any;
          try {
            fresh = await api(o.base, { signal: controller.signal });
          } catch (refreshError) {
            setStatus(
              'The server changed this draft, but the new version could not be loaded. Your edits remain here.',
            );
            o.onError?.(refreshError as Error);
            throw refreshError;
          }
          if (generation !== active.current.generation)
            throw new DOMException('Location changed', 'AbortError');
          const next = mergeFactState(current.current ?? snapshot, factSnapshot(fresh));
          apply(next);
          setStatus(
            next.conflict
              ? 'Another editor changed these facts. Resolve the marked fields.'
              : 'Separate edits merged. Review and save again.',
          );
        } else if (error instanceof APIError && [401, 403].includes(error.status)) {
          setAccessLost(true);
          setReady(false);
          setRecovery(null);
          setStatus('Access changed. Refresh workspace authorization.');
        } else if (error instanceof FactValidationError)
          setStatus(
            'Complete the highlighted fields before saving. Your partial draft stays in recovery.',
          );
        else if ((error as Error).name !== 'AbortError')
          setStatus('Not synced — edits remain here and in recovery when available.');
        if ((error as Error).name !== 'AbortError') o.onError?.(error as Error);
        throw error;
      } finally {
        if (generation === active.current.generation) {
          setSaving(false);
          pending.current = null;
        }
      }
    })();
    pending.current = promise;
    return promise;
  }, [ready, recovery, accessLost, apply, persist]);
  const dirty = !!state && factDirty(state);
  useEffect(() => {
    if (
      !scope ||
      !enabled ||
      !ready ||
      !state ||
      !dirty ||
      state.conflict ||
      recovery ||
      accessLost
    )
      return;
    const generation = active.current.generation;
    void persist(scope, {
      version: 1,
      savedAt: new Date().toISOString(),
      baseline: state.baseline,
      profile: state.profile,
      rights: state.rights,
    }).catch(() => {
      if (generation === active.current.generation)
        setStatus('Local recovery unavailable; keep this tab open.');
    });
    const issues = validateFactProfile(state.profile);
    if (issues.length) {
      setStatus(
        'Draft incomplete: ' +
          [...new Set(issues.map((i) => i.path))].slice(0, 3).join(', ') +
          '. Complete these fields to sync.',
      );
      return;
    }
    if (saving || retryBlocked) return;
    const timer = setTimeout(() => {
      void save().catch(() => {});
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [
    scope,
    enabled,
    ready,
    state,
    dirty,
    recovery,
    accessLost,
    saving,
    retryBlocked,
    debounceMs,
    save,
    persist,
  ]);
  const setProfile = useCallback(
    (profile: Profile) => {
      const s = current.current;
      if (!opts.current.enabled || !ready || recovery || s?.conflict || accessLost || !s) return;
      apply({ ...s, profile: structuredClone(profile) });
      setRetryBlocked(false);
      setStatus('Changes waiting to save');
    },
    [ready, recovery, accessLost, apply],
  );
  const setRights = useCallback(
    (rights: boolean) => {
      const s = current.current;
      if (!opts.current.enabled || !ready || recovery || s?.conflict || accessLost || !s) return;
      apply({ ...s, rights });
      setRetryBlocked(false);
      setStatus('Changes waiting to save');
    },
    [ready, recovery, accessLost, apply],
  );
  const reload = useCallback(async () => {
    const o = opts.current;
    if (!o.scope) return;
    const generation = ++active.current.generation;
    abort.current?.abort();
    pending.current = null;
    setSaving(false);
    const fresh = await api(o.base);
    if (generation !== active.current.generation) return;
    apply(initialFactState(factSnapshot(fresh)));
    setRecovery(null);
    setAccessLost(false);
    setRetryBlocked(false);
    setReady(o.enabled);
    await persist(o.scope, null).catch(() => {});
    setStatus('Reloaded saved version; local edits discarded.');
  }, [apply, persist]);
  const restoreRecovery = useCallback(() => {
    if (!recovery || !current.current || !enabled) return;
    const next = mergeFactState(
      {
        baseline: recovery.baseline,
        profile: recovery.profile,
        rights: recovery.rights,
        conflict: null,
      },
      current.current.baseline,
    );
    apply(next);
    setRecovery(null);
    setRetryBlocked(true);
    setStatus(
      next.conflict
        ? 'Recovered changes need reconciliation.'
        : 'Recovered changes ready. Review and save.',
    );
  }, [recovery, enabled, apply]);
  const discardRecovery = useCallback(() => {
    setRecovery(null);
    if (scope) void persist(scope, null).catch(() => {});
    setStatus('Local recovery discarded; server facts retained.');
  }, [scope, persist]);
  const chooseConflict = useCallback(
    (key: string, useLocal: boolean) => {
      if (current.current) apply(chooseFactConflict(current.current, key, useLocal));
    },
    [apply],
  );
  const finishConflict = useCallback(() => {
    if (current.current) {
      apply(finishFactConflict(current.current));
      setRetryBlocked(true);
      setStatus('Reconciled facts ready. Review and save.');
    }
  }, [apply]);
  const visible = active.current.scope === scope && !accessLost ? state : null;
  return {
    validationIssues: visible ? validateFactProfile(visible.profile) : [],
    profile: visible?.profile ?? null,
    rights: visible?.rights ?? false,
    setProfile,
    setRights,
    dirty: !!visible && factDirty(visible),
    saving,
    status,
    draft: visible?.baseline.draft ?? null,
    save,
    reload,
    recovery: visible ? recovery : null,
    restoreRecovery,
    discardRecovery,
    conflict: visible?.conflict ?? null,
    chooseConflict,
    finishConflict,
    blocked: !enabled || !ready || !!recovery || !!visible?.conflict || accessLost,
  };
}
