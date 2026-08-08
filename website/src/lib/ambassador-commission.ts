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

async function getQualifyingMonthlySalesCount(ambassadorId: string): Promise<number> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const { data, error } = await supabaseAdmin
    .from("referral_orders")
    .select("created_at, payment_status, ineligible_reason, commission_amount, fraud_flag")
    .eq("ambassador_id", ambassadorId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).filter((row) => {
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
  }).length;
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
  const { data: ambassador } = await supabaseAdmin
    .from("ambassadors")
    .select("commission_percent, commission_percent_locked")
    .eq("id", input.ambassadorId)
    .maybeSingle();

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

  // A TIER MUST BE EARNED.
  //
  // `matched` used to be seeded with tiers[0] BEFORE this loop, so an
  // ambassador who qualified for nothing was still paid the lowest tier. With
  // any active tier present, the rate the owner typed in the admin was
  // therefore never used -- a tier whose threshold is 5 monthly sales applied
  // to someone with zero, silently replacing an agreed rate.
  //
  // Starting from null and only assigning on a genuine qualification keeps the
  // tier design intact (a tier with a threshold of 0 still applies to
  // everyone, which is the owner's choice) while making the configured rate
  // the floor rather than something a tier can quietly undercut.
  let matched: (typeof tiers)[number] | null = null;
  for (const tier of tiers) {
    if (monthlySales >= tier.minMonthlySales) {
      matched = tier;
    }
  }

  if (!matched) {
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
