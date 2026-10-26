import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'parse5';
import type { CatalogPlace } from '../src/modules/consumer.js';
import {
  renderSharedOuting,
  renderUnavailableSharedOuting,
  type SharedOutingPageSnapshot,
} from '../src/modules/outing-share-page.js';

const id = '349b267c-3ff9-49e1-9e11-7c3dcb7b3741';
const publicURL = `https://kulture.mitwpu.work/outings/${id}`;
const place = (placeID: string, overrides: Partial<CatalogPlace> = {}): CatalogPlace => ({
  id: placeID,
  name: `Place ${placeID}`,
  category: 'cafes',
  neighborhood: 'Jubilee Hills',
  address: 'Road 45, Jubilee Hills, Hyderabad',
  summary: 'Public research record',
  tags: [],
  sourceURLs: ['https://example.org/places/' + placeID],
  researchedAt: '2026-10-10',
  searchQuery: 'Place ' + placeID,
  revision: 1,
  status: 'research',
  ...overrides,
});
const snapshot = (overrides: Partial<SharedOutingPageSnapshot> = {}): SharedOutingPageSnapshot => ({
  version: 1,
  id,
  title: 'Coffee, then a little green',
  createdAt: '2026-10-10T07:00:00.000Z',
  expiresAt: '2099-10-11T07:00:00.000Z',
  stops: [
    { placeID: 'coffee', place: place('coffee') },
    { placeID: 'park', place: place('park', { category: 'parks' }) },
  ],
  ...overrides,
});
type Node = {
  tagName?: string;
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
};
const nodes = (html: string): Node[] => {
  const result: Node[] = [];
  const walk = (node: Node) => {
    result.push(node);
    node.childNodes?.forEach(walk);
  };
  walk(parse(html) as Node);
  return result;
};
const attr = (node: Node, name: string): string | undefined =>
  node.attrs?.find((attribute) => attribute.name === name)?.value;
const content = (node: Node): string =>
  (node.value ?? '') + (node.childNodes ?? []).map(content).join('');

test('shared outing is an ordered semantic page with exact app link and honest expiry', () => {
  const html = renderSharedOuting(snapshot(), publicURL),
    parsed = nodes(html);
  assert.equal(parsed.filter((node) => node.tagName === 'h1').length, 1);
  assert.equal(content(parsed.find((node) => node.tagName === 'h1')!), snapshot().title);
  assert.deepEqual(
    parsed
      .filter((node) => node.tagName === 'h3' && attr(node, 'id')?.startsWith('stop-'))
      .map(content),
    ['Place coffee', 'Place park'],
  );
  assert.equal(
    parsed
      .find((node) => node.tagName === 'ol' && attr(node, 'class') === 'stops')
      ?.childNodes?.filter((node) => node.tagName === 'li').length,
    2,
  );
  const appLinks = parsed.filter(
    (node) => node.tagName === 'a' && attr(node, 'href')?.startsWith('kulture-edit:'),
  );
  assert.equal(appLinks.length, 2); // Desktop and mobile; CSS shows only one at a time.
  assert(appLinks.every((node) => attr(node, 'href') === `kulture-edit://outing/${id}`));
  const expiry = parsed.find((node) => node.tagName === 'time')!;
  assert.equal(attr(expiry, 'datetime'), snapshot().expiresAt);
  assert.match(content(expiry), /2099.*12:30.*IST/);
  assert.match(html, /not a booking or a checked schedule/);
  assert.match(html, /Routes, travel times and entrances have not been verified/);
  assert.match(html, /Later edits to the original plan are not reflected/);
  assert.match(html, /Requires Kulture Edit on your iPhone/);
});

test('untrusted title and every displayed place fact are text, never markup or attributes', () => {
  const payload = '"><img src=x onerror=alert(1)><script>alert("title")</script>&\'';
  const html = renderSharedOuting(
    snapshot({
      title: payload,
      stops: [
        {
          placeID: 'coffee',
          place: place('coffee', {
            name: payload,
            category: payload,
            neighborhood: payload,
            address: payload,
            sourceURLs: ["https://example.org/?x=%22%3E%3Cscript%3E&y='quoted'"],
          }),
        },
      ],
    }),
    publicURL,
  );
  const parsed = nodes(html);
  assert.equal(content(parsed.find((node) => node.tagName === 'h1')!), payload);
  assert.equal(content(parsed.find((node) => attr(node, 'id') === 'stop-0')!), payload);
  assert.equal(
    parsed.filter((node) =>
      ['script', 'img', 'iframe', 'object', 'embed', 'form'].includes(node.tagName ?? ''),
    ).length,
    0,
  );
  assert(parsed.every((node) => !node.attrs?.some((attribute) => /^on/i.test(attribute.name))));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('source links allow only valid public HTTPS, deduplicate and never auto-load', () => {
  const candidates = [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://example.org/',
    '//example.org/path',
    'https://user:secret@example.org/',
    'https://example.org:8443/',
    'https://127.0.0.1/',
    'https://192.168.1.1/',
    'https://[::1]/',
    'https://office.local/',
    'https://localhost/',
    'https://example.org/\nmalice',
    "https://example.org/?x=\"&y='safe'",
    "https://example.org/?x=\"&y='safe'",
    'https://second.example.org/place',
    'https://third.example.org/place',
  ];
  const html = renderSharedOuting(
    snapshot({
      stops: [{ placeID: 'coffee', place: place('coffee', { sourceURLs: candidates }) }],
    }),
    publicURL,
  );
  const parsed = nodes(html);
  const external = parsed.filter(
    (node) => node.tagName === 'a' && attr(node, 'target') === '_blank',
  );
  assert.equal(external.length, 3);
  assert.deepEqual(
    external.map((node) => attr(node, 'href')),
    [new URL(candidates[12]).href, candidates[14], candidates[15]],
  );
  for (const link of external) {
    assert.equal(attr(link, 'rel'), 'noopener noreferrer');
    assert.equal(attr(link, 'referrerpolicy'), 'no-referrer');
  }
  assert.equal(
    parsed.filter((node) =>
      node.attrs?.some((attribute) => ['src', 'srcset', 'poster'].includes(attribute.name)),
    ).length,
    0,
  );
});

test('withdrawn or mismatched place retains its exact ordered slot without leaking old details', () => {
  const html = renderSharedOuting(
    snapshot({
      stops: [
        { placeID: 'coffee', place: place('coffee') },
        { placeID: 'missing', place: null },
        {
          placeID: 'park',
          place: place('replacement', { name: 'WRONG REPLACEMENT MUST NOT APPEAR' }),
        },
        { placeID: 'last', place: place('last') },
      ],
    }),
    publicURL,
  );
  const headings = nodes(html)
    .filter((node) => node.tagName === 'h3' && attr(node, 'id')?.startsWith('stop-'))
    .map(content);
  assert.deepEqual(headings, [
    'Place coffee',
    'This stop is no longer available',
    'This stop is no longer available',
    'Place last',
  ]);
  assert.doesNotMatch(html, /WRONG REPLACEMENT/);
  assert.match(html, /Stop 2 · Unavailable/);
  assert.match(html, /Stop 3 · Unavailable/);
  assert.match(html, /4 stops · In shared order/);
});

test('expired, malformed dates, invalid identities and unsafe public links use one unavailable page', () => {
  const unavailable = renderUnavailableSharedOuting();
  const invalid: Partial<SharedOutingPageSnapshot>[] = [
    { id: '../not-a-uuid' },
    { id: `${id}\"><script>bad</script>` },
    { version: 2 as 1 },
    { title: '' },
    { createdAt: 'yesterday' },
    { expiresAt: 'tomorrow' },
    { createdAt: '2026-02-31T00:00:00.000Z' },
    { expiresAt: '2099-10-11T25:00:00.000Z' },
    { expiresAt: '2020-01-01T00:00:00.000Z' },
    { createdAt: '2100-01-01T00:00:00.000Z' },
    { stops: [] },
    { stops: Array.from({ length: 9 }, (_, index) => ({ placeID: String(index), place: null })) },
    {
      stops: [
        { placeID: 'same', place: null },
        { placeID: 'same', place: null },
      ],
    },
  ];
  for (const invalidSnapshot of invalid)
    assert.equal(renderSharedOuting(snapshot(invalidSnapshot), publicURL), unavailable);
  for (const url of [
    'javascript:alert(1)',
    'https://user:password@example.org/',
    `${publicURL}?private=true`,
    `${publicURL}#note`,
    publicURL.replace(id, '349b267c-3ff9-49e1-9e11-7c3dcb7b3742'),
    `${publicURL}\"><script>bad</script>`,
  ]) {
    assert.equal(renderSharedOuting(snapshot(), url), unavailable);
  }
  assert.doesNotMatch(unavailable, /kulture-edit:\/\//);
  assert.match(unavailable, /Ask the person who shared it for a fresh link/);
});

test('UTC ISO dates without milliseconds remain valid and the unavailable response never exposes an identifier', () => {
  const html = renderSharedOuting(
    snapshot({ createdAt: '2026-10-10T07:00:00Z', expiresAt: '2099-10-11T07:00:00.5Z' }),
    publicURL,
  );
  assert.match(html, /2099-10-11T07:00:00.500Z/);
  assert.doesNotMatch(renderUnavailableSharedOuting(), new RegExp(id));
});

test('page is a strict fact allowlist: no private metadata, images, coordinates, remote fonts or tracking', () => {
  const privateSnapshot = {
    ...snapshot(),
    ownerEmail: 'never-public@example.org',
    author: 'PRIVATE AUTHOR',
    brief: { note: 'PRIVATE NOTE', budgetPerPersonINR: 9731 },
    stops: [
      {
        placeID: 'coffee',
        place: place('coffee', {
          imageURL: 'https://tracker.example.org/pixel',
          imageSourceURL: 'https://image.example.org/private',
          imageCredit: 'PRIVATE IMAGE CREDIT',
          imageRights: 'unverified',
          summary: 'PRIVATE OR UNREVIEWED SUMMARY',
          latitude: 17.41379834,
          longitude: 78.3952981,
        }),
      },
    ],
  };
  const html = renderSharedOuting(privateSnapshot, publicURL),
    parsed = nodes(html);
  for (const secret of [
    'never-public@example.org',
    'PRIVATE AUTHOR',
    'PRIVATE NOTE',
    '9731',
    'tracker.example.org',
    'image.example.org',
    'PRIVATE IMAGE CREDIT',
    'PRIVATE OR UNREVIEWED SUMMARY',
    '17.41379834',
    '78.3952981',
  ]) {
    assert(!html.includes(secret), secret);
  }
  assert.equal(
    parsed.filter((node) =>
      ['script', 'img', 'iframe', 'video', 'audio', 'object', 'embed'].includes(node.tagName ?? ''),
    ).length,
    0,
  );
  assert.equal(
    parsed.filter((node) => node.tagName === 'link' && attr(node, 'rel') !== 'canonical').length,
    0,
  );
  const style = content(parsed.find((node) => node.tagName === 'style')!);
  assert.doesNotMatch(style, /@import|url\s*\(|https?:/i);
  assert.equal(
    attr(
      parsed.find((node) => node.tagName === 'meta' && attr(node, 'name') === 'robots')!,
      'content',
    ),
    'noindex,nofollow,nosnippet',
  );
  assert.equal(
    attr(
      parsed.find((node) => node.tagName === 'meta' && attr(node, 'name') === 'referrer')!,
      'content',
    ),
    'no-referrer',
  );
  assert.match(style, /safe-area-inset-bottom/);
  assert.match(style, /focus-visible/);
});
