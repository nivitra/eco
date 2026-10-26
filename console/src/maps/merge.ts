export type Conflict = { path: string; local: unknown; remote: unknown };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
/** Three-way field merge. Entity arrays join by stable ID; ordered geometry/photo arrays conflict as a unit. */
export function mergeDocument(
  base: unknown,
  local: unknown,
  remote: unknown,
  choices: Record<string, 'local' | 'remote'> = {},
) {
  const conflicts: Conflict[] = [];
  function merge(b: unknown, l: unknown, r: unknown, path: string): unknown {
    if (equal(l, r)) return l;
    if (equal(l, b)) return r;
    if (equal(r, b)) return l;
    if (object(b) && object(l) && object(r)) {
      const out: Record<string, unknown> = {};
      for (const k of new Set([...Object.keys(r), ...Object.keys(l), ...Object.keys(b)])) {
        const v = merge(b[k], l[k], r[k], path + '/' + k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    const entities = (v: unknown): v is Array<{ id: string } & Record<string, unknown>> =>
      Array.isArray(v) && v.every((x) => object(x) && typeof x.id === 'string');
    if (entities(b) && entities(l) && entities(r)) {
      const ids = [
        ...new Set([...r.map((x) => x.id), ...l.map((x) => x.id), ...b.map((x) => x.id)]),
      ];
      return ids
        .map((id) =>
          merge(
            b.find((x) => x.id === id),
            l.find((x) => x.id === id),
            r.find((x) => x.id === id),
            path + '/' + id,
          ),
        )
        .filter((x) => x !== undefined);
    }
    if (choices[path]) return choices[path] === 'local' ? l : r;
    conflicts.push({ path, local: l, remote: r });
    return l;
  }
  return { value: merge(base, local, remote, ''), conflicts };
}
