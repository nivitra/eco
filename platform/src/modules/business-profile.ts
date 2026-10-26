import { z } from 'zod';

export const discoveryCategories = [
  'cafes',
  'food',
  'art',
  'heritage',
  'nature',
  'nightlife',
  'shopping',
  'wellness',
] as const;
export const businessTypes = [
  { id: 'cafe', label: 'Café', schemaType: 'CafeOrCoffeeShop', discoveryCategory: 'cafes' },
  { id: 'restaurant', label: 'Restaurant', schemaType: 'Restaurant', discoveryCategory: 'food' },
  { id: 'bar', label: 'Bar & nightlife', schemaType: 'BarOrPub', discoveryCategory: 'nightlife' },
  { id: 'gallery', label: 'Art & gallery', schemaType: 'ArtGallery', discoveryCategory: 'art' },
  {
    id: 'heritage',
    label: 'Heritage & culture',
    schemaType: 'LandmarksOrHistoricalBuildings',
    discoveryCategory: 'heritage',
  },
  { id: 'park', label: 'Park & nature', schemaType: 'Park', discoveryCategory: 'nature' },
  { id: 'retail', label: 'Shopping & retail', schemaType: 'Store', discoveryCategory: 'shopping' },
  {
    id: 'wellness',
    label: 'Fitness & wellness',
    schemaType: 'HealthAndBeautyBusiness',
    discoveryCategory: 'wellness',
  },
  {
    id: 'hotel',
    label: 'Hotel & accommodation',
    schemaType: 'LodgingBusiness',
    discoveryCategory: null,
  },
  { id: 'salon', label: 'Salon & grooming', schemaType: 'BeautySalon', discoveryCategory: null },
  { id: 'healthcare', label: 'Healthcare', schemaType: 'MedicalBusiness', discoveryCategory: null },
  {
    id: 'education',
    label: 'Education',
    schemaType: 'EducationalOrganization',
    discoveryCategory: null,
  },
  {
    id: 'professional_services',
    label: 'Professional services',
    schemaType: 'ProfessionalService',
    discoveryCategory: null,
  },
  {
    id: 'automotive',
    label: 'Automotive',
    schemaType: 'AutomotiveBusiness',
    discoveryCategory: null,
  },
  {
    id: 'repair',
    label: 'Repair & maintenance',
    schemaType: 'HomeAndConstructionBusiness',
    discoveryCategory: null,
  },
  {
    id: 'manufacturing',
    label: 'Manufacturing',
    schemaType: 'Organization',
    discoveryCategory: null,
  },
  { id: 'other', label: 'Other business', schemaType: 'LocalBusiness', discoveryCategory: null },
] as const;
export const businessTypeSchema = z.enum(businessTypes.map((t) => t.id));
export const safePublicURL = z
  .string()
  .trim()
  .max(1000)
  .url()
  .refine((value) => {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password;
  }, 'Use an HTTP(S) URL without embedded credentials');
const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).nullable().optional();
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
const date = z.iso.date();
const period = z
  .object({
    opens: clock,
    closes: clock,
    endsNextDay: z.boolean().default(false),
    appointmentOnly: z.boolean().default(false),
  })
  .strict()
  .refine(
    (p) => p.endsNextDay || p.closes > p.opens,
    'Closing time must follow opening time; mark overnight if appropriate',
  );
const day = z
  .object({
    day: z.number().int().min(1).max(7),
    state: z.enum(['open', 'closed', 'unknown', 'appointment_only']),
    periods: z.array(period).max(6),
  })
  .strict()
  .refine(
    (d) => (d.state === 'open' ? d.periods.length > 0 : d.periods.length === 0),
    'Open days need periods; other states have no periods',
  );
export const hoursSchema = z
  .object({
    timezone: z.literal('Asia/Kolkata'),
    weekly: z
      .array(day)
      .max(7)
      .refine(
        (ds) => new Set(ds.map((d) => d.day)).size === ds.length,
        'Each weekday appears once',
      ),
    exceptions: z
      .array(
        z
          .object({
            date,
            state: z.enum(['open', 'closed', 'unknown', 'appointment_only']),
            periods: z.array(period).max(6),
            note: optionalText(180),
          })
          .strict()
          .refine(
            (d) => (d.state === 'open' ? d.periods.length > 0 : d.periods.length === 0),
            'Open dates need periods; other states have no periods',
          ),
      )
      .max(100)
      .refine(
        (ds) => new Set(ds.map((d) => d.date)).size === ds.length,
        'Each exception date appears once',
      ),
  })
  .strict();
export const localitySchema = z
  .object({
    country: z.literal('IN'),
    state: text(100).min(2),
    district: optionalText(100),
    city: text(120).min(2),
    citySlug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(120),
    locality: text(180).min(2),
    street: text(300).min(2),
    building: optionalText(180),
    unit: optionalText(80),
    floor: optionalText(80),
    landmark: optionalText(200),
    postalCode: z
      .string()
      .regex(/^[1-9][0-9]{5}$/)
      .nullable()
      .optional(),
    serviceArea: optionalText(300),
  })
  .strict();
const offering = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    name: text(180).min(1),
    description: optionalText(1200),
    category: optionalText(100),
    priceMinor: z.number().int().min(0).max(100000000).nullable().optional(),
    currency: z.literal('INR').default('INR'),
    priceUnit: optionalText(100),
    priceQualifier: z.enum(['fixed', 'from', 'range', 'on_request', 'unknown']).default('unknown'),
    priceMaxMinor: z.number().int().min(0).max(100000000).nullable().optional(),
    availability: z.enum(['available', 'unavailable', 'seasonal', 'unknown']).default('unknown'),
    conditions: optionalText(700),
    sourceURL: safePublicURL.nullable().optional(),
  })
  .strict()
  .refine(
    (o) => o.priceMaxMinor == null || (o.priceMinor != null && o.priceMaxMinor >= o.priceMinor),
    'Maximum price must not be lower than starting price',
  )
  .refine(
    (o) => !['fixed', 'from', 'range'].includes(o.priceQualifier) || o.priceMinor != null,
    'A confirmed price type requires a starting price',
  )
  .refine(
    (o) => o.priceQualifier !== 'range' || o.priceMaxMinor != null,
    'A price range requires its maximum price',
  );
export const merchantProfileSchema = z
  .object({
    name: text(200).min(2),
    category: z.enum([...discoveryCategories, 'business']),
    neighborhood: text(180).min(2),
    address: text(600).min(5),
    summary: text(2000).min(10),
    tags: z.array(text(60).min(1)).max(15),
    phone: optionalText(30).refine(
      (v) => !v || /^\+[1-9][0-9]{7,14}$/.test(v),
      'Use E.164 format, such as +919876543210, without spaces',
    ),
    website: safePublicURL.nullable().optional(),
    hoursText: optionalText(700),
    entranceNote: optionalText(1000),
    businessType: businessTypeSchema.optional(),
    businessTypeLabel: optionalText(120),
    locality: localitySchema.optional(),
    hours: hoursSchema.optional(),
    offerings: z
      .array(offering)
      .max(250)
      .refine(
        (os) => new Set(os.map((o) => o.id)).size === os.length,
        'Offering IDs must be unique',
      )
      .optional(),
    localizedNames: z
      .array(
        z
          .object({
            language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/),
            name: text(200).min(1),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    conditions: z.array(text(500).min(1)).max(30).optional(),
    status: z.enum(['open', 'temporarily_closed', 'permanently_closed', 'unknown']).optional(),
    publicEmail: z.email().max(254).nullable().optional(),
    provenance: z
      .array(
        z
          .object({
            field: text(120).min(1),
            source: z.enum(['owner', 'document', 'official_url', 'operator']),
            sourceURL: safePublicURL.nullable().optional(),
            observedAt: z.iso.datetime({ offset: true }),
            note: optionalText(400),
          })
          .strict(),
      )
      .max(150)
      .optional(),
  })
  .strict()
  .superRefine((p, c) => {
    if (p.businessType) {
      const t = businessTypes.find((t) => t.id === p.businessType)!;
      if (p.category !== (t.discoveryCategory ?? 'business'))
        c.addIssue({
          code: 'custom',
          path: ['category'],
          message: 'Discovery category must match the business type',
        });
    }
  });
export type MerchantProfile = z.infer<typeof merchantProfileSchema>;
export function discoveryCategoryFor(type: string) {
  return businessTypes.find((t) => t.id === type)?.discoveryCategory ?? null;
}
