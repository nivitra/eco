export class APIError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestID?: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    version?: number | string;
    key?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'include',
    signal: options.signal,
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.method && options.method !== 'GET'
        ? { 'Idempotency-Key': options.key ?? crypto.randomUUID() }
        : {}),
      ...(options.version !== undefined ? { 'If-Match': String(options.version) } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error ?? {};
    throw new APIError(
      response.status,
      detail.code ?? data.code ?? 'request_failed',
      detail.fields?.length
        ? detail.fields.map((f: any) => f.path + ': ' + f.message).join('; ')
        : (detail.message ?? data.message ?? 'The request could not be completed'),
      data.requestId,
    );
  }
  return data;
}
export const displayDate = (v?: string | null) =>
  v
    ? new Date(v).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
    : 'Not recorded';
export function downloadJSON(value: unknown, name: string) {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    ),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export type Tenant = {
  id: string;
  name: string;
  role: string;
  scopeMode: string;
  placeIDs: string[];
  canPublish: boolean;
  canManageDestinations: boolean;
};
export type Profile = {
  name: string;
  category: string;
  neighborhood: string;
  address: string;
  summary: string;
  tags: string[];
  phone?: string | null;
  website?: string | null;
  hoursText?: string | null;
  entranceNote?: string | null;
  businessType?: string;
  locality?: any;
  offerings?: any[];
  hours?: any;
  [key: string]: any;
};
export const emptyProfile: Profile = {
  name: '',
  category: 'cafes',
  businessType: 'cafe',
  neighborhood: '',
  address: '',
  summary: '',
  tags: [],
  phone: null,
  website: null,
  hoursText: null,
  entranceNote: null,
  locality: {
    country: 'IN',
    state: 'Telangana',
    city: 'Hyderabad',
    citySlug: 'hyderabad',
    locality: '',
    street: '',
    postalCode: null,
  },
  offerings: [],
};
