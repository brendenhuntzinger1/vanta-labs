import { supabaseAdmin } from "@/lib/supabase-server";
import { readAllRowsBounded } from "@/lib/supabase-page";

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

// Ceiling on the tier read. The tier ladder tops out in the tens of qualifying
// orders a month (Starter 0 / Growth 20-25 / Elite 50), so any count that
// reaches this number is already in the highest tier and reading further rows
// cannot change the answer. It exists so one very large month cannot pull an
// unbounded result into a request that a shopper is waiting on.
const MAX_TIER_SCAN_ROWS = 5_000;

// Ceiling on the repeat-identity fraud scan. The heuristic flags on the 3rd
// order sharing one identity, so the newest few thousand orders under a code is
// far more history than the rule can use; the bound is here to keep one very
// large ambassador from turning a per-order check into a full-history PII read.
const MAX_FRAUD_SCAN_ROWS = 2_000;

async function getQualifyingMonthlySalesCount(ambassadorId: string): Promise<number> {
  const monthStart = monthStartUtc(new Date());

  // The month window is applied in the QUERY, not only in the JS filter below.
  // This runs on the shopper's critical path (quoteOrder → getEffectiveCommissionPercent)
  // and again on every paid webhook, and without it the read grew with the
  // ambassador's entire lifetime referral history — sorted — to answer a
  // question about one calendar month. Worse, past the server's silent row cap
  // a lifetime-ordered read returns the NEWEST rows only by luck of the sort;
  // a truncated read here does not fail, it just reports a lower qualifying
  // count, which is a lower tier and a smaller commission. Filtering to the
  // month makes the read proportional to the month, and paging makes any
  // remaining truncation observable instead of silent.
  //
  // `created_at >= monthStart` is exactly the last line of
  // qualifiesForMonthlyTierCount, which still applies every other rule.
  const { rows, truncated } = await readAllRowsBounded<TierQualifyingRow>(
    (from, to) => supabaseAdmin
      .from("referral_orders")
      .select("created_at, payment_status, ineligible_reason, commission_amount, fraud_flag")
      .eq("ambassador_id", ambassadorId)
      .gte("created_at", monthStart.toISOString())
      .order("created_at", { ascending: false })
      .range(from, to) as unknown as PromiseLike<{ data: TierQualifyingRow[] | null; error: unknown }>,
    { maxRows: MAX_TIER_SCAN_ROWS, label: "referral_orders.select(monthly tier count)" },
  );

  if (truncated) {
    // Cannot change the tier — see MAX_TIER_SCAN_ROWS — but it means one
    // ambassador is doing thousands of referred orders a month, which is worth
    // knowing about on its own.
    console.warn(
      `getQualifyingMonthlySalesCount: ambassador ${ambassadorId} has more than ${MAX_TIER_SCAN_ROWS} referral orders this month; counting the first ${MAX_TIER_SCAN_ROWS}.`,
    );
  }

  return rows.filter((row) => qualifiesForMonthlyTierCount(row, monthStart)).length;
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

  // BOUNDED. This runs on every paid referred order, and the read is by
  // ambassador with no filter of its own — so without a ceiling it grows with
  // the ambassador's entire lifetime referred-order history, and pulls customer
  // PII (email + address) for all of it into memory to count three matches.
  // Newest-first, so the window is the most recent orders under this code,
  // which is where a repeat-identity pattern shows up; the threshold is 3, so
  // nothing realistic is missed by not reading further back.
  const { rows: recentOrders, truncated } = await readAllRowsBounded<{
    order_id: string;
    customer_email: string | null;
    shipping_address: string | null;
    city: string | null;
    postal_code: string | null;
  }>(
    (from, to) => supabaseAdmin
      .from("orders")
      .select("order_id, customer_email, shipping_address, city, postal_code")
      .eq("ambassador_id", input.ambassadorId)
      .order("created_at", { ascending: false })
      .range(from, to) as unknown as PromiseLike<{ data: Array<{
        order_id: string;
        customer_email: string | null;
        shipping_address: string | null;
        city: string | null;
        postal_code: string | null;
      }> | null; error: unknown }>,
    { maxRows: MAX_FRAUD_SCAN_ROWS, label: "orders.select(commission fraud signal)" },
  );

  if (truncated) {
    console.warn(
      `detectCommissionFraudSignal: ambassador ${input.ambassadorId} has more than ${MAX_FRAUD_SCAN_ROWS} referred orders; checking the most recent ${MAX_FRAUD_SCAN_ROWS}.`,
    );
  }

  const priorOrders = recentOrders.filter((row) => String(row.order_id) !== input.orderId);

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
