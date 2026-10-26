-- Merchant-authored coupon codes. A coupon becomes public only with the same
-- approved claim and a currently published page for that tenant and place.
CREATE TABLE merchant_coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  place_id text NOT NULL REFERENCES places(id),
  claim_id uuid NOT NULL,
  code text NOT NULL CHECK(code ~ '^[A-Z0-9][A-Z0-9-]{3,23}$'),
  title text NOT NULL CHECK(length(title) BETWEEN 3 AND 100),
  description text NOT NULL DEFAULT '' CHECK(length(description) <= 500),
  terms text NOT NULL DEFAULT '' CHECK(length(terms) <= 600),
  discount_kind text NOT NULL CHECK(discount_kind IN ('percent','amount')),
  discount_value integer NOT NULL CHECK(discount_value BETWEEN 1 AND 10000000),
  scope text NOT NULL CHECK(scope IN ('selected','all_products','all_services','all_offerings')),
  offering_ids text[] NOT NULL DEFAULT '{}',
  starts_on date,
  ends_on date,
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY(tenant_id,place_id,claim_id) REFERENCES merchant_claims(tenant_id,place_id,id),
  UNIQUE(tenant_id,place_id,code),
  CHECK(discount_kind <> 'percent' OR discount_value <= 100),
  CHECK(ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  CHECK((scope = 'selected' AND cardinality(offering_ids) BETWEEN 1 AND 100)
     OR (scope <> 'selected' AND cardinality(offering_ids) = 0)),
  CHECK(archived_at IS NULL OR enabled = false)
);
CREATE INDEX merchant_coupons_place ON merchant_coupons(tenant_id,place_id,created_at DESC);
CREATE INDEX merchant_coupons_public ON merchant_coupons(place_id) WHERE enabled AND archived_at IS NULL;
ALTER TABLE merchant_coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_coupons FORCE ROW LEVEL SECURITY;
CREATE POLICY merchant_coupon_read ON merchant_coupons FOR SELECT
  USING(can_access_place(tenant_id,place_id));
CREATE POLICY merchant_coupon_create ON merchant_coupons FOR INSERT
  WITH CHECK(can_access_place(tenant_id,place_id,true)
    AND created_by=current_setting('app.actor_id',true));
CREATE POLICY merchant_coupon_update ON merchant_coupons FOR UPDATE
  USING(can_access_place(tenant_id,place_id,true))
  WITH CHECK(can_access_place(tenant_id,place_id,true));

-- Return only public fields from an approved owner and current public page.
CREATE FUNCTION public_active_coupons(requested_place text)
RETURNS TABLE(
  id uuid, code text, title text, description text, terms text,
  discount_kind text, discount_value integer, scope text, offering_ids text[],
  starts_on date, ends_on date, snapshot jsonb, canonical_path text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT coupon.id,coupon.code,coupon.title,coupon.description,coupon.terms,
         coupon.discount_kind,coupon.discount_value,coupon.scope,coupon.offering_ids,
         coupon.starts_on,coupon.ends_on,page.snapshot,page.canonical_path
  FROM merchant_coupons coupon
  JOIN merchant_claims claim ON claim.id=coupon.claim_id AND claim.state='approved'
  JOIN public_pages page ON page.place_id=coupon.place_id AND page.withdrawn_at IS NULL
  JOIN publications publication ON publication.id=page.publication_id
    AND publication.tenant_id=coupon.tenant_id AND publication.place_id=coupon.place_id
  WHERE coupon.place_id=requested_place AND coupon.enabled AND coupon.archived_at IS NULL
    AND (coupon.starts_on IS NULL OR coupon.starts_on <= (now() AT TIME ZONE 'Asia/Kolkata')::date)
    AND (coupon.ends_on IS NULL OR coupon.ends_on >= (now() AT TIME ZONE 'Asia/Kolkata')::date)
  ORDER BY coupon.created_at DESC
$$;
REVOKE ALL ON FUNCTION public_active_coupons(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_active_coupons(text) TO kulture_app;
