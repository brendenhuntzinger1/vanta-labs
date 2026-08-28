import { supabaseAdmin } from "@/lib/supabase-server";
import { getWelcomeOffer } from "@/lib/admin-control";
import { normalizeCouponCode } from "@/lib/coupon-code";

// Re-exported so every existing importer keeps working; the implementation
// lives in a module with no Supabase dependency (see coupon-code.ts).
export { normalizeCouponCode };

export interface CouponValidationResult {
  code: string;
  discountType: "percent" | "fixed";
  discountValue: number;
  discountAmount: number;
}


function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

export function calculateCouponDiscount(subtotal: number, discountType: string, discountValue: number) {
  if (subtotal <= 0 || discountValue <= 0) {
    return 0;
  }

  const amount = discountType === "fixed"
    ? discountValue
    : subtotal * (discountValue / 100);

  return roundMoney(Math.min(Math.max(amount, 0), subtotal));
}

// Mirrors validateReferralCode's contract: null for "no code supplied",
// throws a user-facing Error for an invalid/expired/exhausted code so the
// checkout API can surface a clear message instead of silently ignoring it.
// customerEmail is required to redeem a coupon assigned to a single
// recipient (e.g. an abandoned-cart-recovery code - see
// mintCartRecoveryCoupon in src/lib/cart-recovery.ts); store-wide coupons
// ignore it.
export interface CouponValidationContext {
  /** The shopper holds an active paid membership (server-verified). */
  isActiveMember?: boolean;
}

// Thrown when the welcome offer's first-order checks could not be RUN. It is a
// distinct message rather than a reuse of "first orders only" because the two
// say different things to the shopper — one is a rule, the other is a retry —
// and the catch below has to be able to tell them apart from the generic
// fall-through it also handles.
const WELCOME_ELIGIBILITY_UNVERIFIED =
  "We couldn't verify this welcome offer right now. Please try again in a moment.";

export async function validateCoupon(code: string | undefined, subtotal: number, customerEmail?: string, context?: CouponValidationContext): Promise<CouponValidationResult | null> {
  const normalizedCode = normalizeCouponCode(code ?? "");

  if (!normalizedCode) {
    return null;
  }

  // Welcome offer acts as a virtual coupon (no DB row) when enabled, so the
  // owner can promote a first-order code without managing a coupon record.
  // Enforced as first-order-only: once the customer's email has a paid order,
  // the code stops working (checked server-side where the email is known).
  try {
    const welcome = await getWelcomeOffer();
    if (welcome.enabled && welcome.percent > 0 && normalizeCouponCode(welcome.code) === normalizedCode) {
      const email = (customerEmail ?? "").trim().toLowerCase();
      if (email) {
        // Once-per-customer: block if this email already has ANY paid order
        // (first-order-only), OR any earlier order that already used this
        // welcome code and isn't cancelled — this also closes the loophole of
        // stacking the code across several simultaneous unpaid orders.
        //
        // BOTH READS FAIL CLOSED. supabase-js RESOLVES on a database error, it
        // does not reject, so dropping `error` on the floor turned a statement
        // timeout or an RLS refusal into `data: null` — read as "no prior
        // order", which GRANTS the first-order-only discount to a returning
        // customer. A check that could not run is not a check that passed.
        const { data: priorPaid, error: priorPaidError } = await supabaseAdmin
          .from("orders")
          .select("id")
          .eq("customer_email", email)
          .eq("payment_status", "paid")
          .limit(1)
          .maybeSingle();
        if (priorPaidError) {
          throw new Error(WELCOME_ELIGIBILITY_UNVERIFIED);
        }
        if (priorPaid) {
          throw new Error("This welcome offer is for first orders only.");
        }

        const { data: priorWelcomeUse, error: priorWelcomeUseError } = await supabaseAdmin
          .from("orders")
          .select("id")
          // Exclude BOTH cancel spellings the codebase writes ("canceled" is
          // the one payment-service uses on reservation failure) plus failed
          // payments — otherwise a canceled first attempt that still carries the
          // welcome code would permanently block the customer's real first order.
          .not("payment_status", "in", "(canceled,cancelled,payment_failed)")
          .eq("customer_email", email)
          // `=`, not ILIKE. normalizeCouponCode has already uppercased this and
          // stripped everything outside [A-Z0-9-], so there is no wildcard and
          // no case to fold — but ILIKE is not indexable, so the planner could
          // only apply it as a filter over every coupon-bearing order. Every
          // lane that writes orders.coupon_code stores the normalized form
          // (see the migration alongside this change), so the match is the same
          // one and it can now use idx_orders_coupon_code.
          .eq("coupon_code", normalizedCode)
          .limit(1)
          .maybeSingle();
        if (priorWelcomeUseError) {
          throw new Error(WELCOME_ELIGIBILITY_UNVERIFIED);
        }
        if (priorWelcomeUse) {
          throw new Error("This welcome offer is for first orders only.");
        }
      }
      return {
        code: normalizedCode,
        discountType: "percent",
        discountValue: welcome.percent,
        discountAmount: calculateCouponDiscount(subtotal, "percent", welcome.percent),
      };
    }
  } catch (e) {
    // Re-throw the user-facing first-order error AND the could-not-check one;
    // otherwise fall through to the normal coupon lookup. Letting the second
    // one fall through is what would undo the fail-closed reads above: the
    // welcome code has no coupons row, so the lookup below would answer
    // "Invalid coupon code" — or, worse, apply a same-named real row.
    if (e instanceof Error
      && (e.message.includes("first orders only") || e.message === WELCOME_ELIGIBILITY_UNVERIFIED)) {
      throw e;
    }
  }

  // Case-insensitive lookup: the code is matched regardless of how it was
  // stored (a code seeded or created lower/mixed case would otherwise fail
  // here even though it shows on the storefront). normalizeCouponCode strips
  // everything except [A-Z0-9-], so there are no ILIKE wildcards to escape.
  // member_scope is a newer column (discount-rules migration): retry without
  // it if the migration hasn't been applied yet — pre-migration behavior
  // (every coupon open to everyone) unchanged.
  let { data, error } = await supabaseAdmin
    .from("coupons")
    .select("code, discount_type, discount_value, starts_at, ends_at, max_redemptions, redemptions_count, active, assigned_email, member_scope")
    .ilike("code", normalizedCode)
    .maybeSingle();

  if (error) {
    const fallback = await supabaseAdmin
      .from("coupons")
      .select("code, discount_type, discount_value, starts_at, ends_at, max_redemptions, redemptions_count, active, assigned_email")
      .ilike("code", normalizedCode)
      .maybeSingle();
    data = fallback.data as typeof data;
    error = fallback.error;
  }

  if (error) {
    console.error("Coupon lookup failed:", error);
    throw new Error("Unable to verify coupon code");
  }

  if (!data || !data.active) {
    throw new Error("Invalid coupon code");
  }

  // Audience restriction: a code can be limited to active members only, or to
  // non-members only (e.g. an acquisition code members shouldn't consume).
  const memberScope = String((data as { member_scope?: string }).member_scope ?? "all");
  if (memberScope === "members" && !context?.isActiveMember) {
    throw new Error("This coupon is exclusive to active members. Join a membership to use it.");
  }
  if (memberScope === "non_members" && context?.isActiveMember) {
    throw new Error("This coupon is for non-members — your membership pricing already beats it on most orders.");
  }

  if (data.assigned_email && data.assigned_email.toLowerCase() !== (customerEmail ?? "").trim().toLowerCase()) {
    throw new Error("This coupon code is tied to a different email address");
  }

  const now = Date.now();
  if (data.starts_at && new Date(data.starts_at).getTime() > now) {
    throw new Error("This coupon is not active yet");
  }

  if (data.ends_at && new Date(data.ends_at).getTime() < now) {
    throw new Error("This coupon has expired");
  }

  if (typeof data.max_redemptions === "number") {
    // Enforce the limit against ORDERS that already hold this code — not just the
    // paid-time redemptions_count, which lags because it only increments after an
    // order settles. Counting in-flight (pending/awaiting) + paid orders stops a
    // limited or one-time code from being applied to many simultaneous unpaid
    // orders before any of them pays (the classic "open N tabs" abuse, and worse
    // for manual methods where orders stay unpaid for days). Mirrors the
    // welcome-offer in-flight guard above. Terminal orders (canceled/failed/
    // refunded — both cancel spellings) don't consume a slot. Degrades to the
    // counter check if the count query fails (count → null → 0).
    //
    // `=`, not ILIKE, for the reason given on the welcome-offer read above.
    // This one matters more: it runs on the create-session path for every
    // checkout carrying a limited coupon, and again on every /api/coupons/validate
    // call, which is exactly when a promo is live and order volume is highest.
    // An unindexable predicate here means a scan of every coupon-bearing order
    // per request, at the busiest moment the store has.
    const { count: liveUses } = await supabaseAdmin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("coupon_code", normalizedCode)
      .not("payment_status", "in", "(canceled,cancelled,payment_failed,refunded)");
    const used = Math.max(Number(data.redemptions_count ?? 0), Number(liveUses ?? 0));
    if (used >= data.max_redemptions) {
      throw new Error("This coupon has reached its redemption limit");
    }
  }

  const discountType = data.discount_type === "fixed" ? "fixed" : "percent";
  const discountValue = Number(data.discount_value ?? 0);

  return {
    code: data.code.toUpperCase(),
    discountType,
    discountValue,
    discountAmount: calculateCouponDiscount(subtotal, discountType, discountValue),
  };
}

/** Whether the redemption was recorded, or why it could not be. */
export interface CouponRedemptionResult {
  ok: boolean;
  error?: string;
}

// Called once a coupon's order is confirmed paid (see payment-webhook.ts) so
// abandoned/failed checkouts never consume redemption slots.
//
// THE FAILURE IS THE RETURN VALUE, NOT AN EXCEPTION. Every branch below used to
// end in `console.error(...); return;`, and supabase-js resolves rather than
// rejects, so the callers' catch blocks — and the
// unsafe_effect_failed_coupon_redemption alert inside them — could never run.
// A coupon that quietly failed to record its redemption keeps being redeemable
// past its limit, and nobody was told.
export async function redeemCoupon(code: string): Promise<CouponRedemptionResult> {
  const normalizedCode = normalizeCouponCode(code);
  if (!normalizedCode) {
    return { ok: true };
  }

  // Atomic increment (single SQL statement) so simultaneous redemptions of a
  // coupon at its exact limit can't over-count - see coupon-redeem-rpc.sql.
  const { data: rpcResult, error } = await supabaseAdmin.rpc("redeem_coupon", { input_code: normalizedCode });

  if (!error) {
    // AND THE RPC'S FAILURE IS ALSO A RETURN VALUE. coupon-redeem-rpc.sql
    // updates `where code = upper(trim(input_code)) and active = true and
    // (max_redemptions is null or redemptions_count < max_redemptions)` and
    // answers `{"redeemed": false}` when nothing matched — it does not raise.
    // Destructuring only `error` therefore reported all three of those
    // outcomes as a recorded redemption, which is the exact silent failure the
    // header above says must be reported.
    if ((rpcResult as { redeemed?: boolean } | null)?.redeemed === false) {
      // One benign case has to be separated out first, or this alerts on every
      // new customer: the welcome offer is a VIRTUAL coupon with no coupons
      // row (see validateCoupon above), so every welcome-offer order reaches
      // here with a code the RPC cannot match and legitimately gets
      // redeemed:false. Same reasoning as the missing-RPC fallback below —
      // no row means there is nothing to record, and retrying cannot help.
      const { data: row, error: lookupError } = await supabaseAdmin
        .from("coupons")
        .select("id")
        .ilike("code", normalizedCode)
        .maybeSingle();
      if (lookupError) {
        // The disambiguation itself failed, so "there is no row" is a guess, not
        // a fact — and this function's whole contract is not to report a
        // redemption it cannot confirm. Both callers only alert; none blocks the
        // order.
        return { ok: false, error: `Coupon ${normalizedCode} redemption could not be confirmed` };
      }
      if (!row) {
        return { ok: true };
      }
      // A row exists and was not incremented: inactive, or already at its
      // limit — a code that keeps being redeemable past its cap if nobody is
      // told. The ilike is also what surfaces a lower/mixed-case stored code,
      // which the RPC's `code = upper(trim(...))` can never match.
      return {
        ok: false,
        error: `Coupon ${normalizedCode} was not recorded as redeemed (inactive, or at its redemption limit)`,
      };
    }
    return { ok: true };
  }

  const message = String(error.message ?? "").toLowerCase();
  const isMissingRpc = error.code === "PGRST202" || message.includes("could not find the function") || message.includes("does not exist");

  if (!isMissingRpc) {
    console.error("Unable to record coupon redemption:", error);
    return { ok: false, error: String(error.message ?? "coupon redemption failed") };
  }

  // Fallback: the RPC migration hasn't been run yet. Best-effort
  // read-modify-write so redemption still records on a partially-migrated
  // database (has a benign over-count race the RPC eliminates).
  const { data, error: loadError } = await supabaseAdmin
    .from("coupons")
    .select("id, redemptions_count")
    .ilike("code", normalizedCode)
    .maybeSingle();

  if (loadError) {
    console.error("Unable to load coupon for redemption:", loadError);
    return { ok: false, error: String(loadError.message ?? "coupon lookup failed") };
  }

  // No such coupon: there is nothing to record, and no amount of retrying
  // changes that. Not a failure to alert on.
  if (!data) {
    return { ok: true };
  }

  const { error: updateError } = await supabaseAdmin
    .from("coupons")
    .update({ redemptions_count: Number(data.redemptions_count ?? 0) + 1 })
    .eq("id", data.id);

  if (updateError) {
    console.error("Unable to record coupon redemption:", updateError);
    return { ok: false, error: String(updateError.message ?? "coupon redemption update failed") };
  }

  return { ok: true };
}

export interface ActiveCouponSummary {
  code: string;
  discountType: "percent" | "fixed";
  discountValue: number;
  endsAt: string | null;
}

// The single headline coupon to advertise on the public storefront (the big
// product-page banner). Shows automatically whenever an admin has an active,
// in-window, store-wide coupon — no separate "publish" toggle. Personal codes
// (assigned_email, e.g. cart-recovery) and exhausted/limit-reached codes are
// never advertised. Returns the most recently created qualifying coupon so the
// last code the owner turned on is the one shoppers see.
export async function getStorefrontCoupon(): Promise<ActiveCouponSummary | null> {
  const nowIso = new Date().toISOString();

  // is_private is a newer column (coupon-private-flag.sql): private codes are
  // valid at checkout but never advertised. If the migration hasn't been
  // applied yet, retry without the column — pre-migration behavior unchanged.
  let { data, error } = await supabaseAdmin
    .from("coupons")
    .select("code, discount_type, discount_value, ends_at, active, assigned_email, max_redemptions, redemptions_count, is_private")
    .eq("active", true)
    .is("assigned_email", null)
    .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
    .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    const fallback = await supabaseAdmin
      .from("coupons")
      .select("code, discount_type, discount_value, ends_at, active, assigned_email, max_redemptions, redemptions_count")
      .eq("active", true)
      .is("assigned_email", null)
      .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
      .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
      .order("created_at", { ascending: false })
      .limit(10);
    data = fallback.data as typeof data;
    error = fallback.error;
  }

  if (error) {
    throw error;
  }

  // Skip private (unlisted) codes and any code that has already hit its
  // redemption cap.
  const usable = (data ?? []).find(
    (row) =>
      !(row as { is_private?: boolean }).is_private
      && !(typeof row.max_redemptions === "number" && Number(row.redemptions_count ?? 0) >= row.max_redemptions),
  );

  if (!usable) {
    return null;
  }

  return {
    code: String(usable.code).toUpperCase(),
    discountType: usable.discount_type === "fixed" ? "fixed" : "percent",
    discountValue: Number(usable.discount_value ?? 0),
    endsAt: usable.ends_at ? String(usable.ends_at) : null,
  };
}

// Customer-facing listing (account dashboard, checkout hints) - only the
// fields a shopper needs to decide whether to use a code, not redemption
// counts or internal limits.
export async function getActiveCouponsForDisplay(): Promise<ActiveCouponSummary[]> {
  const nowIso = new Date().toISOString();

  // Same is_private handling as getStorefrontCoupon: private codes work at
  // checkout but never appear in customer-facing lists; fall back to the
  // pre-migration select if the column doesn't exist yet.
  let { data, error } = await supabaseAdmin
    .from("coupons")
    .select("code, discount_type, discount_value, starts_at, ends_at, active, assigned_email, is_private")
    // Only store-wide coupons belong in a customer-facing list. Personal codes
    // (assigned_email — e.g. auto-minted SAVE-… cart-recovery codes) are tied to
    // one shopper and must never be advertised here.
    .eq("active", true)
    .is("assigned_email", null)
    .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
    .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    const fallback = await supabaseAdmin
      .from("coupons")
      .select("code, discount_type, discount_value, starts_at, ends_at, active, assigned_email")
      .eq("active", true)
      .is("assigned_email", null)
      .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
      .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
      .order("created_at", { ascending: false })
      .limit(10);
    data = fallback.data as typeof data;
    error = fallback.error;
  }

  if (error) {
    throw error;
  }

  return (data ?? []).filter((row) => !(row as { is_private?: boolean }).is_private).map((row) => ({
    code: String(row.code),
    discountType: row.discount_type === "fixed" ? "fixed" : "percent",
    discountValue: Number(row.discount_value ?? 0),
    endsAt: row.ends_at ? String(row.ends_at) : null,
  }));
}
