import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  merchantProfileSchema,
  hoursSchema,
  discoveryCategoryFor,
} from '../src/modules/business-profile.js';
import { classifyEssentialCorrection } from '../src/modules/entitlements.js';
const profile = {
  name: 'A useful business',
  category: 'cafes',
  neighborhood: 'Jubilee Hills',
  address: 'Road 45, Jubilee Hills, Hyderabad',
  summary: 'Locally prepared coffee with a published menu.',
  tags: ['coffee'],
  phone: '+919876543210',
};

test('broad business types retain India identity without contaminating consumer discovery categories', () => {
  assert.equal(merchantProfileSchema.safeParse(profile).success, true);
  assert.equal(
    merchantProfileSchema.safeParse({
      ...profile,
      businessType: 'healthcare',
      category: 'business',
    }).success,
    true,
  );
  assert.equal(
    merchantProfileSchema.safeParse({
      ...profile,
      businessType: 'healthcare',
      category: 'wellness',
    }).success,
    false,
  );
  assert.equal(discoveryCategoryFor('healthcare'), null);
  assert.equal(discoveryCategoryFor('cafe'), 'cafes');
  assert.equal(
    merchantProfileSchema.safeParse({
      ...profile,
      name: 'మన ఊరి కాఫీ',
      localizedNames: [{ language: 'te', name: 'మన ఊరి కాఫీ' }],
    }).success,
    true,
  );
});
test('structured schedules require explicit overnight boundaries and unique exception dates', () => {
  const hours = {
    timezone: 'Asia/Kolkata',
    weekly: [
      { day: 5, state: 'open', periods: [{ opens: '20:00', closes: '02:00', endsNextDay: true }] },
    ],
    exceptions: [{ date: '2026-10-02', state: 'closed', periods: [] }],
  };
  assert.equal(hoursSchema.safeParse(hours).success, true);
  assert.equal(
    hoursSchema.safeParse({
      ...hours,
      weekly: [{ day: 5, state: 'open', periods: [{ opens: '20:00', closes: '02:00' }] }],
    }).success,
    false,
  );
  assert.equal(
    hoursSchema.safeParse({ ...hours, exceptions: [...hours.exceptions, ...hours.exceptions] })
      .success,
    false,
  );
});
test('expired service permits factual corrections and removal but no promotional rewrite, new location or extra offering', () => {
  const existing = {
    ...profile,
    offerings: [{ id: 'coffee', name: 'Coffee', priceMinor: 20000 }],
    conditions: ['Reservation required'],
  };
  assert.equal(
    classifyEssentialCorrection(existing, {
      ...existing,
      address: 'Corrected shop 2, Road 45, Hyderabad',
    }).essential,
    true,
  );
  assert.equal(
    classifyEssentialCorrection(existing, { ...existing, status: 'temporarily_closed' }).essential,
    true,
  );
  assert.equal(
    classifyEssentialCorrection(existing, { ...existing, offerings: [] }).essential,
    true,
  );
  assert.equal(
    classifyEssentialCorrection(existing, {
      ...existing,
      offerings: [...existing.offerings, { id: 'tea', name: 'Tea' }],
    }).essential,
    false,
  );
  assert.equal(
    classifyEssentialCorrection(existing, {
      ...existing,
      summary: 'New promotional campaign with new claims.',
    }).essential,
    false,
  );
  assert.equal(classifyEssentialCorrection({}, existing).essential, false);
});

test('public contacts and declared prices cannot contradict structured facts', () => {
  assert.equal(
    merchantProfileSchema.safeParse({ ...profile, phone: '+91 98765 43210' }).success,
    false,
  );
  assert.equal(
    merchantProfileSchema.safeParse({ ...profile, phone: '+919876543210' }).success,
    true,
  );
  assert.equal(
    merchantProfileSchema.safeParse({
      ...profile,
      offerings: [{ id: 'coffee', name: 'Coffee', priceQualifier: 'fixed', priceMinor: null }],
    }).success,
    false,
  );
  assert.equal(
    merchantProfileSchema.safeParse({
      ...profile,
      offerings: [{ id: 'coffee', name: 'Coffee', priceQualifier: 'range', priceMinor: 10000 }],
    }).success,
    false,
  );
  assert.equal(
    hoursSchema.safeParse({
      timezone: 'Asia/Kolkata',
      weekly: [],
      exceptions: [{ date: '2026-10-02', state: 'open', periods: [] }],
    }).success,
    false,
  );
  assert.equal(
    hoursSchema.safeParse({
      timezone: 'Asia/Kolkata',
      weekly: [],
      exceptions: [
        { date: '2026-10-02', state: 'closed', periods: [{ opens: '09:00', closes: '18:00' }] },
      ],
    }).success,
    false,
  );
});
