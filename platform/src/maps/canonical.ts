import { createHash } from 'node:crypto';
export const canonicalJSON = (value: unknown): string =>
  value === null || typeof value !== 'object'
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? '[' + value.map(canonicalJSON).join(',') + ']'
      : '{' +
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJSON(v))
          .join(',') +
        '}';
export const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJSON(value)).digest('hex');
