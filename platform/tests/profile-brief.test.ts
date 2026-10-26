import { test } from 'node:test';
import assert from 'node:assert/strict';

// Domain-only tests: no real server credentials or database are configured.
// Importing the shared auth module may log its unreachable test-URL probe.
process.env.PUBLIC_URL ??= 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET ??= 'test-only-auth-secret-never-use-in-production';
process.env.OPS_TOKEN ??= 'test-only-ops-token-never-use-in-production';
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.AUTH_DATABASE_URL ??= process.env.DATABASE_URL;
const { profileSchema, normalizeProfile, mergeOmittedOutingBriefs, prepareProfileUpdate } = await import('../src/modules/consumer.js');
const { planningSchema } = await import('../src/modules/ai-planning.js');

const id = 'e5aab24c-865a-4139-b629-38ce6aa87784';
const otherID = 'ee49f321-cb5c-4d08-94aa-83b7d740499f';
const brief = {
  stages: [{ id: 'coffee', categoryID: 'cafes', scope: 'kokapet' }, { id: 'activity', categoryID: 'games' }],
  company: 'friends', budgetPerPersonINR: 800, durationMinutes: 120, note: 'No bars',
};
const outing = { id, title: 'An afternoon', placeIDs: ['cafe', 'game'], createdAt: 1791580800000 };
const profile = (outings: unknown[]) => profileSchema.parse({
  savedIDs: ['cafe'], taste: { interests: ['cafes'], pace: 'Unhurried', avoidBars: true }, outings,
});
const validIDs = new Set(['cafe', 'game']);

test('old profiles still parse; new briefs normalize the shared constraints and defaults', () => {
  assert.equal(Object.hasOwn(profile([outing]).outings[0], 'brief'), false);
  const parsed = profile([{ ...outing, brief: { stages: brief.stages, note: '  Keep it relaxed  ' } }]);
  assert.equal(parsed.outings[0].brief?.company, 'any');
  assert.equal(parsed.outings[0].brief?.selectionMode, 'nearby');
  assert.equal(parsed.outings[0].brief?.note, 'Keep it relaxed');
  assert.equal(profile([{ ...outing, brief: null }]).outings[0].brief, null);
});

test('brief normalization rejects unsupported service stages and malformed constraints', () => {
  for (const invalid of [
    { ...brief, stages: [{ id: 'only', categoryID: 'cafes' }] },
    { ...brief, stages: [{ id: 'same', categoryID: 'cafes' }, { id: 'same', categoryID: 'games' }] },
    { ...brief, stages: [{ id: 'care', categoryID: 'hospitals' }, brief.stages[1]] },
    { ...brief, budgetPerPersonINR: -1 }, { ...brief, budgetPerPersonINR: 1.5 },
    { ...brief, durationMinutes: 14 }, { ...brief, durationMinutes: 1441 },
    { ...brief, note: 'x'.repeat(501) }, { ...brief, optimized: true },
  ]) {
    assert.throws(() => profile([{ ...outing, brief: invalid }]));
    // The normalizer is also the final transaction boundary, including data
    // merged from storage rather than accepted through the HTTP parser.
    assert.throws(() => normalizeProfile({ ...profile([outing]), outings: [{ ...outing, brief: invalid }] } as any, validIDs));
  }
});

test('legacy omission preserves a brief by outing ID while reordered stops and unrelated account data follow the incoming edit', () => {
  const stored = profile([{ ...outing, brief }, { ...outing, id: otherID, title: 'Second', brief: { ...brief, company: 'solo' } }]);
  const incoming = profile([{ ...outing, id: otherID, title: 'Changed second', placeIDs: ['game', 'cafe'] }, { ...outing, title: 'Changed first' }]);
  incoming.savedIDs = ['game'];
  incoming.taste.avoidBars = false;
  const before = JSON.stringify(stored);
  const updated = prepareProfileUpdate(incoming, { revision: 9, body: stored }, 9, validIDs);
  assert.equal(updated.outings[0].brief?.company, 'solo');
  assert.deepEqual(updated.outings[0].placeIDs, ['game', 'cafe']);
  assert.equal(updated.outings[0].title, 'Changed second');
  assert.deepEqual(updated.outings[1].brief, planningSchema.parse(brief));
  assert.deepEqual(updated.savedIDs, ['game']);
  assert.equal(updated.taste.avoidBars, false);
  assert.equal(JSON.stringify(stored), before);
  assert.equal(Object.hasOwn(incoming.outings[0], 'brief'), false);
});

test('explicit null clears, an explicit replacement wins, and deletion never resurrects an outing', () => {
  const stored = profile([{ ...outing, brief }, { ...outing, id: otherID, brief }]);
  const clearing = prepareProfileUpdate(profile([{ ...outing, brief: null }]), { revision: 1, body: stored }, 1, validIDs);
  assert.equal(clearing.outings.length, 1);
  assert.equal(clearing.outings[0].brief, null);
  const laterLegacyWrite = prepareProfileUpdate(profile([outing]), { revision: 2, body: clearing }, 2, validIDs);
  assert.equal(laterLegacyWrite.outings[0].brief, null);
  const replacement = profile([{ ...outing, brief: { ...brief, durationMinutes: 240 } }]);
  assert.equal(mergeOmittedOutingBriefs(replacement, stored).outings[0].brief?.durationMinutes, 240);
  assert.deepEqual(mergeOmittedOutingBriefs(profile([]), stored).outings, []);
  assert.equal(mergeOmittedOutingBriefs(profile([{ ...outing, id: 'brand-new' }]), stored).outings[0].brief, undefined);
});

test('stale or missing profile revision is rejected before inspecting or merging stored briefs', () => {
  const stored = { outings: [{ ...outing, brief: { neverValid: true } }] };
  const isConflict = (error: unknown) => (error as { status?: number; code?: string }).status === 412 && (error as { code?: string }).code === 'version_conflict';
  assert.throws(() => prepareProfileUpdate(profile([outing]), { revision: 3, body: stored }, 2, validIDs), isConflict);
  assert.throws(() => prepareProfileUpdate(profile([outing]), undefined, 2, validIDs), isConflict);
  // On a matching revision an invalid stored brief must fail, never vanish.
  assert.throws(() => prepareProfileUpdate(profile([outing]), { revision: 3, body: stored }, 3, validIDs));
});

test('JSON persistence round trips preserve a brief through a legacy title edit without accepting unknown place IDs', () => {
  const initial = prepareProfileUpdate(profile([{ ...outing, brief }]), { revision: 1, body: profile([]) }, 1, validIDs);
  const databaseBody = JSON.parse(JSON.stringify(initial));
  const legacy = JSON.parse(JSON.stringify(databaseBody));
  delete legacy.outings[0].brief;
  legacy.outings[0].title = 'Renamed on an older device';
  const next = prepareProfileUpdate(profileSchema.parse(legacy), { revision: 2, body: databaseBody }, 2, validIDs);
  assert.deepEqual(next.outings[0].brief, initial.outings[0].brief);
  assert.equal(next.outings[0].title, 'Renamed on an older device');
  assert.throws(() => prepareProfileUpdate(profile([{ ...outing, placeIDs: ['invented'], brief }]), { revision: 2, body: databaseBody }, 2, validIDs));
});

test('an older client echoing a brief preserves the same outing start while its other edits still apply',()=>{
  const startAtEpochMs=Date.UTC(2026,9,11,13,0);
  const stored=profile([{...outing,brief:{...brief,startAtEpochMs}},{...outing,id:otherID,brief:{...brief,startAtEpochMs:0}}]);
  const incoming=profile([{...outing,id:otherID,title:'Other edited',brief:{...brief,durationMinutes:90}},
    {...outing,title:'Later title edit',brief:{...brief,note:'Changed note',durationMinutes:240}}]);
  const originalStored=JSON.stringify(stored),originalIncoming=JSON.stringify(incoming);
  const updated=prepareProfileUpdate(incoming,{revision:4,body:JSON.parse(originalStored)},4,validIDs);
  assert.equal(updated.outings[0].brief?.startAtEpochMs,0,'epoch zero must not be treated as missing');
  assert.equal(updated.outings[1].brief?.startAtEpochMs,startAtEpochMs);
  assert.equal(updated.outings[1].brief?.durationMinutes,240);
  assert.equal(updated.outings[1].brief?.note,'Changed note');
  assert.equal(JSON.stringify(stored),originalStored);assert.equal(JSON.stringify(incoming),originalIncoming);
});

test('explicit flexible null or a new target wins and legacy echoes cannot restore a cleared start',()=>{
  const startAtEpochMs=Date.UTC(2026,9,11,13,0);
  const stored=profile([{...outing,brief:{...brief,startAtEpochMs}}]);
  const clear=prepareProfileUpdate(profile([{...outing,brief:{...brief,startAtEpochMs:null}}]),{revision:1,body:stored},1,validIDs);
  assert.equal(clear.outings[0].brief?.startAtEpochMs,null);
  const legacy=prepareProfileUpdate(profile([{...outing,brief}]),{revision:2,body:JSON.parse(JSON.stringify(clear))},2,validIDs);
  assert.equal(legacy.outings[0].brief?.startAtEpochMs,null);
  const replacement=prepareProfileUpdate(profile([{...outing,brief:{...brief,startAtEpochMs:startAtEpochMs+60000}}]),{revision:2,body:clear},2,validIDs);
  assert.equal(replacement.outings[0].brief?.startAtEpochMs,startAtEpochMs+60000);
  assert.equal(prepareProfileUpdate(profile([{...outing,brief:null}]),{revision:1,body:stored},1,validIDs).outings[0].brief,null);
});

test('visit-time legacy merging validates prior data and does not cross identity or revision boundaries',()=>{
  const stored=profile([{...outing,brief:{...brief,startAtEpochMs:0}}]);
  assert.deepEqual(prepareProfileUpdate(profile([]),{revision:1,body:stored},1,validIDs).outings,[]);
  const fresh=prepareProfileUpdate(profile([{...outing,id:otherID,brief}]),{revision:1,body:stored},1,validIDs);
  assert.equal(fresh.outings[0].brief?.startAtEpochMs,undefined);
  const corrupt={outings:[{...outing,brief:{...brief,startAtEpochMs:'tomorrow'}}]};
  assert.throws(()=>prepareProfileUpdate(profile([{...outing,brief}]),{revision:1,body:corrupt},1,validIDs));
  assert.throws(()=>prepareProfileUpdate(profile([{...outing,brief}]),{revision:2,body:corrupt},1,validIDs),
    (error:unknown)=>(error as {code?:string}).code==='version_conflict');
});
