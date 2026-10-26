import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  merchantProfileSchema,
  localitySchema,
  hoursSchema,
  businessTypes,
} from '../src/modules/business-profile.js';
import { app } from '../src/app.js';
import { pool, workerPool } from '../src/db.js';
import { authPool } from '../src/auth.js';
const directory = new URL('../docs/contracts/', import.meta.url);
try {
  await mkdir(directory, { recursive: true });
  for (const [name, schema] of Object.entries({
    'business-profile': merchantProfileSchema,
    'indian-locality': localitySchema,
    'business-hours': hoursSchema,
  }))
    await writeFile(
      new URL(name + '.schema.json', directory),
      JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n',
    );
  const seen = new Set<string>();
  const routes = app.routes
    .filter((r) => r.method !== 'ALL' && !r.path.includes('*'))
    .map((r) => ({ method: r.method, path: r.path }))
    .filter((r) => {
      const key = r.method + ' ' + r.path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  await writeFile(
    new URL('routes.json', directory),
    JSON.stringify(
      {
        schemaVersion: 1,
        authentication:
          'Signed native bearer or same-origin HttpOnly cookie; operator and machine routes use separate boundaries.',
        concurrency:
          'Mutation routes document Idempotency-Key and If-Match in their modules. This inventory does not replace per-route request contracts.',
        routes,
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(
    new URL('business-taxonomy.json', directory),
    JSON.stringify({ version: 1, country: 'IN', types: businessTypes }, null, 2) + '\n',
  );
  console.log(`Generated shared schemas, taxonomy and ${routes.length} route declarations`);
} finally {
  await Promise.all([
    pool.end(),
    authPool.end(),
    ...(workerPool !== pool ? [workerPool.end()] : []),
  ]);
}
