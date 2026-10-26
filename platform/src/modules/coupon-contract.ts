import { z } from 'zod';

export const couponScopeSchema = z.enum(['selected', 'all_products', 'all_services', 'all_offerings']);
export const couponInputSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{3,23}$/, 'Use 4–24 letters, numbers or hyphens.'),
  title: z.string().trim().min(3).max(100),
  description: z.string().trim().max(500),
  terms: z.string().trim().max(600),
  discountKind: z.enum(['percent', 'amount']),
  discountValue: z.number().int().min(1).max(10_000_000),
  scope: couponScopeSchema,
  offeringIDs: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(100),
  startsOn: z.iso.date().nullable(),
  endsOn: z.iso.date().nullable(),
  enabled: z.boolean(),
}).strict().superRefine((coupon, ctx) => {
  if (coupon.discountKind === 'percent' && coupon.discountValue > 100)
    ctx.addIssue({ code: 'custom', path: ['discountValue'], message: 'Percentage must be from 1 to 100.' });
  if (coupon.startsOn && coupon.endsOn && coupon.endsOn < coupon.startsOn)
    ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'End date must follow the start date.' });
  if (coupon.scope === 'selected' && coupon.offeringIDs.length === 0)
    ctx.addIssue({ code: 'custom', path: ['offeringIDs'], message: 'Select at least one offering.' });
  if (coupon.scope !== 'selected' && coupon.offeringIDs.length)
    ctx.addIssue({ code: 'custom', path: ['offeringIDs'], message: 'This scope applies automatically; remove selected items.' });
  if (new Set(coupon.offeringIDs).size !== coupon.offeringIDs.length)
    ctx.addIssue({ code: 'custom', path: ['offeringIDs'], message: 'Choose each offering once.' });
});
export type CouponInput = z.infer<typeof couponInputSchema>;
export type CouponScope = z.infer<typeof couponScopeSchema>;
export type CouponOffering = { id: string; name: string; kind?: 'product' | 'service'; availability?: string };

export function eligibleOfferings(scope: CouponScope, offeringIDs: string[], offerings: CouponOffering[]): CouponOffering[] {
  const ids = new Set(offeringIDs);
  return offerings.filter((offering) =>
    offering.availability !== 'unavailable' &&
    (scope === 'all_offerings' ||
      scope === 'all_products' && offering.kind === 'product' ||
      scope === 'all_services' && offering.kind === 'service' ||
      scope === 'selected' && ids.has(offering.id)),
  );
}

export function couponScopeIssue(input: CouponInput, offerings: CouponOffering[]): string | null {
  if (input.scope === 'selected') {
    const ids = new Set(offerings.map((offering) => offering.id));
    if (input.offeringIDs.some((id) => !ids.has(id)))
      return 'A selected offering is missing from the saved business draft. Save and review your offerings first.';
  }
  if (!eligibleOfferings(input.scope, input.offeringIDs, offerings).length)
    return input.scope === 'all_products' || input.scope === 'all_services'
      ? 'Mark at least one saved offering as a product or service before using this scope.'
      : 'Add at least one available offering before creating this coupon.';
  return null;
}
