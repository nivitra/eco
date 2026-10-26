import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import https from 'node:https';
import { HttpError } from '../../db.js';
const blocked = new BlockList(),
  blockedV6 = new BlockList();
for (const range of [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
]) {
  const [address, bits] = range.split('/');
  blocked.addSubnet(address, Number(bits), 'ipv4');
}
for (const range of [
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '2001::/23',
  '2001:db8::/32',
  '2002::/16',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
]) {
  const [address, bits] = range.split('/');
  blockedV6.addSubnet(address, Number(bits), 'ipv6');
}
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 6 && !/^[23][0-9a-f]{3}:/i.test(address)) return false;
  return family === 4
    ? !blocked.check(address, 'ipv4')
    : family === 6
      ? !blockedV6.check(address, 'ipv6')
      : false;
}
export function validatedPublicURL(value: string): URL {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new HttpError(422, 'unsafe_url', 'Use a valid public HTTPS URL');
  }
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    (u.port && u.port !== '443') ||
    u.hash ||
    u.hostname.endsWith('.') ||
    u.hostname === 'localhost' ||
    !u.hostname.includes('.') ||
    u.href.length > 2048
  )
    throw new HttpError(
      422,
      'unsafe_url',
      'Use public HTTPS on port 443 without credentials or fragments',
    );
  return u;
}
export interface PublicFetchResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  redirects: string[];
}
export interface AddressResolver {
  (hostname: string): Promise<
    {
      address: string;
      family: number;
    }[]
  >;
}
export async function publicAddresses(
  hostname: string,
  resolve: AddressResolver = (host) => lookup(host, { all: true, verbatim: true }),
): Promise<
  {
    address: string;
    family: number;
  }[]
> {
  const addresses = await resolve(hostname);
  if (
    !addresses.length ||
    addresses.length > 32 ||
    addresses.some((a) => !isPublicAddress(a.address))
  )
    throw new HttpError(
      422,
      'unsafe_address',
      'The website resolves to a non-public or unsupported network address',
    );
  return addresses;
}
/** DNS is validated afresh and the TLS connection is pinned to that validated address.
 * No cookies, proxy settings, redirected credentials, transparent decompression, or ambient agents.
 */
export async function safeFetch(
  value: string,
  options: {
    expectedOrigin?: string;
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
  } = {},
): Promise<PublicFetchResult> {
  const start = Date.now(),
    timeout = options.timeoutMs ?? 10000,
    redirects: string[] = [];
  let url = validatedPublicURL(value);
  for (let hop = 0; hop <= (options.maxRedirects ?? 3); hop++) {
    if (options.expectedOrigin && url.origin !== options.expectedOrigin)
      throw new HttpError(
        422,
        'origin_changed',
        'The public URL redirected outside the approved website',
      );
    const remaining = timeout - (Date.now() - start);
    if (remaining <= 0) throw new HttpError(504, 'check_timeout', 'The website check timed out');
    const addresses = await Promise.race([
      publicAddresses(url.hostname),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new HttpError(504, 'dns_timeout', 'Website DNS timed out')),
          remaining,
        );
        timer.unref();
      }),
    ]);
    const chosen = addresses[0];
    const result = await new Promise<{
      status: number;
      headers: Record<string, string>;
      body: string;
    }>((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: 'GET',
          agent: false,
          servername: url.hostname,
          rejectUnauthorized: true,
          lookup: ((_host: unknown, opts: any, cb: any) =>
            opts?.all ? cb(null, [chosen]) : cb(null, chosen.address, chosen.family)) as any,
          headers: {
            'User-Agent': 'Kulture-AccessCheck/1.0 (synthetic; not an organic crawler)',
            Accept: 'text/html,application/json,text/plain;q=0.8',
            'Accept-Encoding': 'identity',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const headers: Record<string, string> = {};
          for (const [key, val] of Object.entries(res.headers))
            headers[key] = Array.isArray(val) ? val.join(', ') : (val ?? '');
          if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
            res.destroy();
            reject(
              new HttpError(
                422,
                'encoded_response',
                'Website must honor identity encoding for a bounded verification request',
              ),
            );
            return;
          }
          res.on('data', (part: Buffer) => {
            size += part.length;
            if (size > (options.maxBytes ?? 1000000)) {
              req.destroy(
                new HttpError(
                  422,
                  'response_too_large',
                  'Website response exceeds verification limits',
                ),
              );
              return;
            }
            chunks.push(part);
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          res.on('error', reject);
        },
      );
      const timer = setTimeout(
        () => req.destroy(new HttpError(504, 'check_timeout', 'The website check timed out')),
        Math.max(1, timeout - (Date.now() - start)),
      );
      timer.unref();
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject);
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
      redirects.push(url.href);
      url = validatedPublicURL(new URL(result.headers.location, url).href);
      continue;
    }
    return { url: url.href, ...result, redirects };
  }
  throw new HttpError(422, 'redirect_limit', 'The website redirected too many times');
}
