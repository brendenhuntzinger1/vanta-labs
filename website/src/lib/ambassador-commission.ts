import { supabaseAdmin } from "@/lib/supabase-server";

export interface CommissionTierRule {
  id: string;
  name: string;
  minMonthlySales: number;
  commissionPercent: number;
  position: number;
  isActive: boolean;
}

function mapTierRule(row: Record<string, unknown>): CommissionTierRule {
  return {
    id: String(row.id),
    name: String(row.name),
    minMonthlySales: Number(row.min_monthly_sales ?? 0),
    commissionPercent: Number(row.commission_percent ?? 0),
    position: Number(row.position ?? 0),
    isActive: Boolean(row.is_active),
  };
}

export async function listCommissionTierRules(): Promise<CommissionTierRule[]> {
  const { data, error } = await supabaseAdmin
    .from("commission_tier_rules")
    .select("id, name, min_monthly_sales, commission_percent, position, is_active")
    .order("min_monthly_sales", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map(mapTierRule);
}

export async function createCommissionTierRule(input: {
  name: string;
  minMonthlySales: number;
  commissionPercent: number;
  position: number;
}) {
  const { error } = await supabaseAdmin.from("commission_tier_rules").insert({
    name: input.name.trim(),
    min_monthly_sales: Math.max(0, Math.round(input.minMonthlySales)),
    commission_percent: Math.max(0, input.commissionPercent),
    position: input.position,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (error) {
    throw error;
  }
}

export async function updateCommissionTierRule(id: string, input: Partial<{
  name: string;
  minMonthlySales: number;
  commissionPercent: number;
  position: number;
  isActive: boolean;
}>) {
  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) payload.name = input.name.trim();
  if (input.minMonthlySales !== undefined) payload.min_monthly_sales = Math.max(0, Math.round(input.minMonthlySales));
  if (input.commissionPercent !== undefined) payload.commission_percent = Math.max(0, input.commissionPercent);
  if (input.position !== undefined) payload.position = input.position;
  if (input.isActive !== undefined) payload.is_active = input.isActive;

  const { error } = await supabaseAdmin.from("commission_tier_rules").update(payload).eq("id", id);
  if (error) {
    throw error;
  }
}

export async function deleteCommissionTierRule(id: string) {
  const { error } = await supabaseAdmin.from("commission_tier_rules").delete().eq("id", id);
  if (error) {
    throw error;
  }
}

export interface TierQualifyingRow {
  created_at?: unknown;
  payment_status?: unknown;
  ineligible_reason?: unknown;
  commission_amount?: unknown;
  fraud_flag?: unknown;
}

// Exported so the exclusions can be tested directly. This predicate decides
// how fast an ambassador escalates through the commission tiers, so every
// row it wrongly admits raises the percent paid on every later order that
// month. It is pure: month boundary is passed in rather than read from the
// clock.
export function qualifiesForMonthlyTierCount(row: TierQualifyingRow, monthStart: Date): boolean {
  const status = String(row.payment_status ?? "").toLowerCase();
  if (status === "reversed" || status === "voided" || status === "manual_review") {
    return false;
  }

  // Only GENUINELY qualifying orders advance the performance tier. Orders that
  // earned $0 — below the minimum qualifying subtotal, program paused, etc.
  // (ineligible_reason set / commission_amount 0) — or that are FRAUD-FLAGGED
  // (self-dealing) must not inflate the count and push the ambassador into a
  // higher commission-percent tier.
  if (row.ineligible_reason || Number(row.commission_amount ?? 0) <= 0 || row.fraud_flag === true) {
    return false;
  }

  const createdAt = new Date(String(row.created_at));
  return Number.isFinite(createdAt.getTime()) && createdAt >= monthStart;
}

export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function getQualifyingMonthlySalesCount(ambassadorId: string): Promise<number> {
  const monthStart = monthStartUtc(new Date());

  const { data, error } = await supabaseAdmin
    .from("referral_orders")
    .select("created_at, payment_status, ineligible_reason, commission_amount, fraud_flag")
    .eq("ambassador_id", ambassadorId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).filter((row) => qualifiesForMonthlyTierCount(row, monthStart)).length;
}

export interface EffectiveCommission {
  percent: number;
  tierName: string | null;
}

// Automatically computes the commission percent for a new order: tier-based
// (escalating with the ambassador's qualifying orders so far this calendar
// month) by default, or the ambassador's flat manual override if an admin
// has explicitly locked it via commission_percent_locked. Recomputed fresh
// at commission-creation time (order confirmed paid) rather than trusting
// whatever percent was baked into checkout-time metadata, since that value
// can go stale between checkout and payment confirmation.
export async function getEffectiveCommissionPercent(input: {
  ambassadorId: string;
  fallbackPercent: number;
}): Promise<EffectiveCommission> {
  // A LOCKED RATE THAT COULD NOT BE READ IS NOT AN ABSENT ONE.
  //
  // The error here was discarded, four lines from the `if (ambassadorRow.error)
  // throw` that ensureCommissionRecord performs against THE SAME TABLE AND THE
  // SAME ROW (payment-webhook.ts). One transient read failure made `ambassador`
  // undefined, so `commission_percent_locked` read false and the ambassador's
  // negotiated, admin-locked rate was silently replaced by the fallback plus
  // whatever tier the loop below happened to match. The commission row was then
  // written, referral_orders existed, and the accrual sweep — which selects on
  // the ABSENCE of that row — never revisited it. Permanently wrong money,
  // silently, from a blip.
  //
  // Throwing is the recoverable direction: ensureCommissionRecord's caller
  // leaves the accrual undone, the absence stays, and the sweep re-derives it on
  // the next tick from a read that worked. The other two reads in this function
  // (listCommissionTierRules, getQualifyingMonthlySalesCount) already throw, so
  // this was also the one inconsistent path.
  //
  // A genuinely MISSING ambassador row is still not an error: `data` is null
  // with no error, and the fallback percent applies exactly as before.
  const { data: ambassador, error: ambassadorError } = await supabaseAdmin
    .from("ambassadors")
    .select("commission_percent, commission_percent_locked")
    .eq("id", input.ambassadorId)
    .maybeSingle();
  if (ambassadorError) throw ambassadorError;

  const ambassadorPercent = ambassador ? Number(ambassador.commission_percent ?? input.fallbackPercent) : input.fallbackPercent;

  if (ambassador?.commission_percent_locked) {
    return { percent: ambassadorPercent, tierName: null };
  }

  const tiers = (await listCommissionTierRules())
    .filter((tier) => tier.isActive)
    .sort((a, b) => a.minMonthlySales - b.minMonthlySales);

  if (tiers.length === 0) {
    return { percent: ambassadorPercent, tierName: null };
  }

  const monthlySales = await getQualifyingMonthlySalesCount(input.ambassadorId);

  // A TIER MUST BE EARNED, AND EARNING ONE CAN NEVER COST THE AMBASSADOR MONEY.
  //
  // Two rules, one loop.
  //
  // 1. A tier must be EARNED. `matched` used to be seeded with tiers[0] BEFORE
  //    this loop, so an ambassador who qualified for nothing was still paid the
  //    lowest tier and the rate the owner typed in the admin was never used.
  //
  // 2. A tier may only ever RAISE the rate. The loop below used to take the
  //    highest THRESHOLD reached and pay whatever that rung said, so the rate
  //    tracked the ladder even where the ladder descends. Production on
  //    2026-08-27 was exactly that shape: the programme default is 15% (the
  //    owner's recorded decision, and what /ambassador and /partner promise)
  //    while the rungs are Starter 10 sales -> 10%, Growth 25 -> 12.5%, Elite
  //    50 -> 15%. So the tenth qualifying sale of the month CUT the rate from
  //    15% to 10%, and it stayed cut until the fiftieth. Selling more paid
  //    less, silently, on every order for the rest of the month.
  //
  // The rule that fixes it is the one an ambassador would state: the rate never
  // goes DOWN as monthly sales go UP. So the resolved rate is the best of every
  // rate this ambassador has passed through -- each rung they have earned, plus
  // the base rate itself while no rung had yet applied. A rung below what they
  // were already being paid is simply inert; a rung above it still promotes
  // them the moment it is reached.
  //
  // The base rate counts as one of those candidates only when the ladder leaves
  // a gap at the bottom (its lowest active rung needs sales the ambassador did
  // not always have). A ladder whose lowest rung is 0 applies from the very
  // first order, so the base rate is never the rate anyone was on -- a
  // zero-threshold rung replacing it outright stays the owner's choice.
  const laddersFromZero = tiers.some((tier) => tier.minMonthlySales <= 0);

  let matched: (typeof tiers)[number] | null = null;
  for (const tier of tiers) {
    if (monthlySales < tier.minMonthlySales) continue;
    // Ties keep the FIRST rung reached: with two rungs paying the same, the one
    // already earned is the one the ambassador is on.
    if (!matched || tier.commissionPercent > matched.commissionPercent) {
      matched = tier;
    }
  }

  if (!matched) {
    return { percent: ambassadorPercent, tierName: null };
  }

  // The rate they were on before any rung applied still stands if no rung has
  // beaten it. Reported with no tier name, because no tier is paying it.
  if (!laddersFromZero && ambassadorPercent > matched.commissionPercent) {
    return { percent: ambassadorPercent, tierName: null };
  }

  return { percent: matched.commissionPercent, tierName: matched.name };
}

export interface FraudCheckResult {
  flagged: boolean;
  reason: string | null;
}

function normalizeAddressKey(address?: string | null, city?: string | null, postalCode?: string | null) {
  return [address, city, postalCode].map((part) => (part ?? "").trim().toLowerCase()).join("|");
}

// Heuristic-only fraud signal, not a real fraud engine: flags (never
// blocks) an order for admin review when the same customer email or the
// same shipping address has been used repeatedly under one ambassador's
// referral code - a pattern consistent with an ambassador buying from
// themselves, or funneling orders through duplicate customer accounts, to
// farm commissions. False positives are expected for genuine repeat
// customers; that's why this only flags for review instead of blocking
// the sale or the commission outright.
export async function detectCommissionFraudSignal(input: {
  ambassadorId: string;
  orderId: string;
  customerEmail?: string | null;
  shippingAddress?: string | null;
  city?: string | null;
  postalCode?: string | null;
}): Promise<FraudCheckResult> {
  // Flag on the 3rd+ order sharing one identity (email or address) under a
  // single ambassador. A genuinely loyal customer occasionally reorders twice
  // with a creator's code, so 2 would strand real commissions; 3+ from one
  // identity via a single code is the self-dealing / duplicate-account pattern
  // worth a human look. A flag only HOLDS the commission for review
  // (auto-approve skips fraud_flag rows) and never blocks the customer's sale —
  // an admin releases it via the audited "Approve Anyway" action.
  // NOTE: distinct-email/distinct-address sock puppets can't be caught here
  // without device / IP / payment-instrument fingerprinting — a post-launch
  // enhancement. This heuristic covers the common repeat-identity case.
  const REPEAT_THRESHOLD = 3;

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("order_id, customer_email, shipping_address, city, postal_code")
    .eq("ambassador_id", input.ambassadorId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  const priorOrders = (data ?? []).filter((row) => String(row.order_id) !== input.orderId);

  if (input.customerEmail) {
    const normalizedEmail = input.customerEmail.trim().toLowerCase();
    const emailMatches = priorOrders.filter((row) => String(row.customer_email ?? "").trim().toLowerCase() === normalizedEmail).length;

    if (emailMatches + 1 >= REPEAT_THRESHOLD) {
      return {
        flagged: true,
        reason: `Customer email has placed ${emailMatches + 1} orders through this ambassador's referral code this period - review for self-dealing.`,
      };
    }
  }

  const normalizedAddress = normalizeAddressKey(input.shippingAddress, input.city, input.postalCode);
  if (normalizedAddress.replaceAll("|", "").length > 0) {
    const addressMatches = priorOrders.filter((row) => normalizeAddressKey(
      row.shipping_address as string | null,
      row.city as string | null,
      row.postal_code as string | null,
    ) === normalizedAddress).length;

    if (addressMatches + 1 >= REPEAT_THRESHOLD) {
      return {
        flagged: true,
        reason: `Same shipping address has been used ${addressMatches + 1} times under this ambassador's referral code - review for duplicate accounts.`,
      };
    }
  }

  return { flagged: false, reason: null };
}
