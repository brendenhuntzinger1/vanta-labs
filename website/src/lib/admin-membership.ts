import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import type { MembershipTier } from "@/lib/membership";

function mapTier(row: Record<string, unknown>): MembershipTier {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    monthlyPriceCents: Number(row.monthly_price_cents ?? 0),
    annualPriceCents: Number(row.annual_price_cents ?? 0),
    pointsPerDollar: Number(row.points_per_dollar ?? 1),
    freeShipping: Boolean(row.free_shipping),
    priorityShipping: Boolean(row.priority_shipping),
    earlyAccess: Boolean(row.early_access),
    exclusivePricing: Boolean(row.exclusive_pricing),
    referralBonusPoints: Number(row.referral_bonus_points ?? 0),
    benefits: Array.isArray(row.benefits) ? (row.benefits as string[]) : [],
    position: Number(row.position ?? 0),
    isActive: Boolean(row.is_active),
    introPriceCents: Number(row.intro_price_cents ?? 100),
    introDurationDays: Number(row.intro_duration_days ?? 7),
    introOfferEnabled: Boolean(row.intro_offer_enabled ?? true),
    memberDiscountPercent: Number(row.member_discount_percent ?? 0),
    monthlyStoreCreditCents: Number(row.monthly_store_credit_cents ?? 0),
    storeCreditMinOrderCents: Number(row.store_credit_min_order_cents ?? 0),
    compareMonthlyPriceCents: Number(row.compare_monthly_price_cents ?? 0),
  };
}

export async function listMembershipTiersAdmin(): Promise<MembershipTier[]> {
  const { data, error } = await supabaseAdmin
    .from("membership_tiers")
    .select("*")
    .order("position", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map(mapTier);
}

export interface MembershipTierInput {
  slug: string;
  name: string;
  monthlyPriceCents: number;
  annualPriceCents: number;
  pointsPerDollar: number;
  freeShipping: boolean;
  priorityShipping: boolean;
  earlyAccess: boolean;
  exclusivePricing: boolean;
  referralBonusPoints: number;
  benefits: string[];
  position: number;
  isActive: boolean;
  introPriceCents: number;
  introDurationDays: number;
  introOfferEnabled: boolean;
  memberDiscountPercent: number;
}

function slugifyTier(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Create a new membership tier. Only name is required; a URL-safe slug is
// derived from it (kept unique with a numeric suffix) and every other field
// falls back to a sensible default so a tier can be spun up with one field and
// refined afterward.
export async function createMembershipTier(input: { name: string } & Partial<MembershipTierInput>) {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Tier name is required.");
  }

  let slug = input.slug ? slugifyTier(input.slug) : slugifyTier(name);
  if (!slug) {
    slug = "tier";
  }

  // Ensure slug uniqueness (the column is unique) by probing and suffixing.
  const { data: existing } = await supabaseAdmin
    .from("membership_tiers")
    .select("slug")
    .like("slug", `${slug}%`);
  const taken = new Set((existing ?? []).map((row) => String(row.slug)));
  if (taken.has(slug)) {
    let n = 2;
    while (taken.has(`${slug}-${n}`)) n += 1;
    slug = `${slug}-${n}`;
  }

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("membership_tiers")
    .insert({
      slug,
      name,
      monthly_price_cents: Math.max(0, Math.round(input.monthlyPriceCents ?? 0)),
      annual_price_cents: Math.max(0, Math.round(input.annualPriceCents ?? 0)),
      points_per_dollar: Math.max(0, input.pointsPerDollar ?? 1),
      free_shipping: input.freeShipping ?? false,
      priority_shipping: input.priorityShipping ?? false,
      early_access: input.earlyAccess ?? false,
      exclusive_pricing: input.exclusivePricing ?? false,
      referral_bonus_points: Math.max(0, Math.round(input.referralBonusPoints ?? 0)),
      benefits: input.benefits ?? [],
      position: input.position ?? 0,
      is_active: input.isActive ?? true,
      intro_price_cents: Math.max(0, Math.round(input.introPriceCents ?? 100)),
      intro_duration_days: Math.max(1, Math.round(input.introDurationDays ?? 7)),
      intro_offer_enabled: input.introOfferEnabled ?? true,
      member_discount_percent: Math.max(0, Math.min(100, input.memberDiscountPercent ?? 0)),
      created_at: now,
      updated_at: now,
    })
    .select("id, slug")
    .single();

  if (error) {
    throw error;
  }

  return { id: String(data.id), slug: String(data.slug) };
}

// Delete a tier. Refuses when any customer is on it (deleting would orphan their
// membership) — the admin is told to reassign or deactivate instead, so a
// customer's benefits are never silently broken.
export async function deleteMembershipTier(id: string) {
  const { count, error: countError } = await supabaseAdmin
    .from("customer_memberships")
    .select("user_id", { count: "exact", head: true })
    .eq("tier_id", id);

  if (countError) {
    throw countError;
  }

  if ((count ?? 0) > 0) {
    throw new Error(
      `This tier has ${count} member${count === 1 ? "" : "s"}. Move them to another tier or set the tier inactive instead of deleting it.`,
    );
  }

  const { error } = await supabaseAdmin.from("membership_tiers").delete().eq("id", id);
  if (error) {
    throw error;
  }
}

export async function updateMembershipTier(id: string, input: Partial<MembershipTierInput>) {
  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) payload.name = input.name;
  if (input.monthlyPriceCents !== undefined) payload.monthly_price_cents = Math.max(0, Math.round(input.monthlyPriceCents));
  if (input.annualPriceCents !== undefined) payload.annual_price_cents = Math.max(0, Math.round(input.annualPriceCents));
  if (input.pointsPerDollar !== undefined) payload.points_per_dollar = Math.max(0, input.pointsPerDollar);
  if (input.freeShipping !== undefined) payload.free_shipping = input.freeShipping;
  if (input.priorityShipping !== undefined) payload.priority_shipping = input.priorityShipping;
  if (input.earlyAccess !== undefined) payload.early_access = input.earlyAccess;
  if (input.exclusivePricing !== undefined) payload.exclusive_pricing = input.exclusivePricing;
  if (input.referralBonusPoints !== undefined) payload.referral_bonus_points = Math.max(0, Math.round(input.referralBonusPoints));
  if (input.benefits !== undefined) payload.benefits = input.benefits;
  if (input.position !== undefined) payload.position = input.position;
  if (input.isActive !== undefined) payload.is_active = input.isActive;
  if (input.introPriceCents !== undefined) payload.intro_price_cents = Math.max(0, Math.round(input.introPriceCents));
  if (input.introDurationDays !== undefined) payload.intro_duration_days = Math.max(1, Math.round(input.introDurationDays));
  if (input.introOfferEnabled !== undefined) payload.intro_offer_enabled = input.introOfferEnabled;
  if (input.memberDiscountPercent !== undefined) payload.member_discount_percent = Math.max(0, Math.min(100, input.memberDiscountPercent));

  const { error } = await supabaseAdmin.from("membership_tiers").update(payload).eq("id", id);
  if (error) {
    throw error;
  }
}

export interface PromotionalPointEvent {
  id: string;
  name: string;
  multiplier: number;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
}

export async function listPromotionalEvents(): Promise<PromotionalPointEvent[]> {
  const { data, error } = await supabaseAdmin
    .from("promotional_point_events")
    .select("id, name, multiplier, starts_at, ends_at, is_active")
    .order("starts_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    multiplier: Number(row.multiplier ?? 1),
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    isActive: Boolean(row.is_active),
  }));
}

export async function createPromotionalEvent(input: { name: string; multiplier: number; startsAt: string; endsAt: string }) {
  const { error } = await supabaseAdmin.from("promotional_point_events").insert({
    name: input.name.trim(),
    multiplier: input.multiplier,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    is_active: true,
    created_at: new Date().toISOString(),
  });

  if (error) {
    throw error;
  }
}

export async function setPromotionalEventActive(id: string, isActive: boolean) {
  const { error } = await supabaseAdmin.from("promotional_point_events").update({ is_active: isActive }).eq("id", id);
  if (error) {
    throw error;
  }
}

export interface CustomerBalanceRow {
  userId: string;
  email: string;
  tierName: string;
  status: string;
  pointsBalance: number;
}

// Uses the Supabase auth admin API to resolve emails since points_ledger /
// customer_memberships only store user_id. listUsers() is paginated (up to
// 1000/page here) - fine for an early-stage store, but this will need a
// proper email index if the customer base grows well beyond that.
export async function listCustomerBalances(search?: string): Promise<CustomerBalanceRow[]> {
  const [{ data: authUsers }, { data: ledgerRows, error: ledgerError }, { data: memberships, error: membershipError }] = await Promise.all([
    supabaseAdmin.auth.admin.listUsers({ perPage: 1000 }),
    supabaseAdmin.from("points_ledger").select("user_id, amount"),
    supabaseAdmin.from("customer_memberships").select("user_id, status, membership_tiers(name)"),
  ]);

  if (ledgerError) throw ledgerError;
  if (membershipError) throw membershipError;

  const balanceByUser = new Map<string, number>();
  for (const row of ledgerRows ?? []) {
    const userId = String(row.user_id);
    balanceByUser.set(userId, (balanceByUser.get(userId) ?? 0) + Number(row.amount ?? 0));
  }

  const membershipByUser = new Map<string, { status: string; tierName: string }>();
  for (const row of memberships ?? []) {
    const tier = row.membership_tiers as unknown as { name?: string } | null;
    membershipByUser.set(String(row.user_id), {
      status: String(row.status ?? "active"),
      tierName: tier?.name ? String(tier.name) : "Research Member",
    });
  }

  const customerUsers = (authUsers?.users ?? []).filter((user) => {
    const role = String(user.app_metadata?.role ?? user.user_metadata?.role ?? "").toLowerCase();
    return role === "customer";
  });

  const normalizedSearch = search?.trim().toLowerCase();

  const rows: CustomerBalanceRow[] = customerUsers
    .filter((user) => !normalizedSearch || user.email?.toLowerCase().includes(normalizedSearch))
    .map((user) => {
      const membership = membershipByUser.get(user.id);
      return {
        userId: user.id,
        email: user.email ?? "(no email)",
        tierName: membership?.tierName ?? "Research Member",
        status: membership?.status ?? "active",
        pointsBalance: balanceByUser.get(user.id) ?? 0,
      };
    });

  return rows.sort((a, b) => b.pointsBalance - a.pointsBalance);
}

export async function adminAdjustPoints(input: { userId: string; amount: number; note: string }) {
  if (input.amount === 0) {
    throw new Error("Adjustment amount must be non-zero");
  }

  const { error } = await supabaseAdmin.from("points_ledger").insert({
    user_id: input.userId,
    amount: Math.round(input.amount),
    reason: "admin_adjustment",
    metadata: { note: input.note },
    created_at: new Date().toISOString(),
  });

  if (error) {
    throw error;
  }
}

// Manually activates a paid tier for a customer, since there's no billing
// integration to do it automatically yet. Upserts rather than requiring an
// existing row, unlike setMembershipStatus below.
export async function assignMembershipTier(userId: string, tierId: string, billingCycle: "monthly" | "annual") {
  const { error } = await supabaseAdmin.from("customer_memberships").upsert({
    user_id: userId,
    tier_id: tierId,
    billing_cycle: billingCycle,
    status: "active",
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });

  if (error) {
    throw error;
  }
}

export async function setMembershipStatus(userId: string, status: "active" | "paused" | "cancelled") {
  const { data: existing } = await supabaseAdmin
    .from("customer_memberships")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (!existing) {
    // No row means they're still on the free tier by default (see
    // getCustomerMembership) - nothing to pause/cancel.
    throw new Error("This customer has no paid membership to update");
  }

  const payload: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (status === "cancelled") {
    payload.cancelled_at = new Date().toISOString();
  }

  const { error } = await supabaseAdmin.from("customer_memberships").update(payload).eq("user_id", userId);
  if (error) {
    throw error;
  }
}

export interface MembershipAnalytics {
  monthlyRecurringRevenueCents: number;
  activeMembersByTier: Array<{ tierName: string; count: number }>;
  totalPointsOutstanding: number;
  activePromotionalEventCount: number;
  activeIntroMembers: number;
  trialToPaidConversionRate: number;
  realRecurringRevenueCents30d: number;
  cancellationsCount30d: number;
  renewalsCount30d: number;
  failedPaymentsCount30d: number;
  recoveryAttemptsCount30d: number;
}

// monthlyRecurringRevenueCents / activeMembersByTier stay a projection from
// current tier prices x active-member counts (useful "what this could be
// worth" figure). The *30d fields below are real, computed only from
// membership_billing_events rows a charge attempt actually produced - see
// billing-provider.ts's header comment for why "failed" is expected and
// honest until a real processor is connected.
export async function getMembershipAnalytics(): Promise<MembershipAnalytics> {
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: memberships, error: membershipError },
    { data: ledgerRows, error: ledgerError },
    { data: events, error: eventsError },
    { data: introMembers, error: introError },
    { data: billingEvents30d, error: billingEventsError },
  ] = await Promise.all([
    supabaseAdmin
      .from("customer_memberships")
      .select("status, billing_cycle, membership_tiers(name, monthly_price_cents, annual_price_cents)")
      .eq("status", "active"),
    supabaseAdmin.from("points_ledger").select("amount"),
    supabaseAdmin
      .from("promotional_point_events")
      .select("id")
      .eq("is_active", true)
      .gte("ends_at", new Date().toISOString()),
    supabaseAdmin.from("customer_memberships").select("user_id").eq("intro_status", "active"),
    supabaseAdmin
      .from("membership_billing_events")
      .select("event_type, amount_cents, status")
      .gte("created_at", since30d),
  ]);

  if (membershipError) throw membershipError;
  if (ledgerError) throw ledgerError;
  if (eventsError) throw eventsError;
  if (introError) throw introError;
  if (billingEventsError) throw billingEventsError;

  let mrrCents = 0;
  const tierCounts = new Map<string, number>();

  for (const row of memberships ?? []) {
    const tier = row.membership_tiers as unknown as { name?: string; monthly_price_cents?: number; annual_price_cents?: number } | null;
    const tierName = tier?.name ?? "Unknown";
    tierCounts.set(tierName, (tierCounts.get(tierName) ?? 0) + 1);

    if (row.billing_cycle === "monthly") {
      mrrCents += Number(tier?.monthly_price_cents ?? 0);
    } else if (row.billing_cycle === "annual") {
      mrrCents += Number(tier?.annual_price_cents ?? 0) / 12;
    }
  }

  const totalPointsOutstanding = (ledgerRows ?? []).reduce((sum, row) => sum + Number(row.amount ?? 0), 0);

  const events30d = billingEvents30d ?? [];
  const introAttempts = events30d.filter((row) => row.event_type === "intro_charge" || row.event_type === "first_month_remainder");
  const introSucceeded = introAttempts.filter((row) => row.status === "succeeded");
  const realRecurringRevenueCents30d = events30d
    .filter((row) => row.status === "succeeded" && (row.event_type === "renewal" || row.event_type === "first_month_remainder" || row.event_type === "intro_charge"))
    .reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0);

  return {
    monthlyRecurringRevenueCents: Math.round(mrrCents),
    activeMembersByTier: Array.from(tierCounts.entries()).map(([tierName, count]) => ({ tierName, count })),
    totalPointsOutstanding,
    activePromotionalEventCount: (events ?? []).length,
    activeIntroMembers: (introMembers ?? []).length,
    trialToPaidConversionRate: introAttempts.length > 0 ? Math.round((introSucceeded.length / introAttempts.length) * 1000) / 10 : 0,
    realRecurringRevenueCents30d,
    cancellationsCount30d: events30d.filter((row) => row.event_type === "cancellation").length,
    renewalsCount30d: events30d.filter((row) => row.event_type === "renewal" && row.status === "succeeded").length,
    failedPaymentsCount30d: events30d.filter((row) => row.status === "failed").length,
    recoveryAttemptsCount30d: events30d.filter((row) => row.event_type === "payment_failed").length,
  };
}

export interface BulkSavingsStats {
  tier5PercentOrders: number;
  tier5PercentRevenueCents: number;
  tier12PercentOrders: number;
  tier12PercentRevenueCents: number;
}

export async function getBulkSavingsStats(): Promise<BulkSavingsStats> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("bulk_discount_tier, amount_paid")
    .not("bulk_discount_tier", "is", null);

  if (error) throw error;

  const stats: BulkSavingsStats = {
    tier5PercentOrders: 0,
    tier5PercentRevenueCents: 0,
    tier12PercentOrders: 0,
    tier12PercentRevenueCents: 0,
  };

  for (const row of data ?? []) {
    const amountCents = Math.round(Number(row.amount_paid ?? 0) * 100);
    if (row.bulk_discount_tier === "5_percent") {
      stats.tier5PercentOrders += 1;
      stats.tier5PercentRevenueCents += amountCents;
    } else if (row.bulk_discount_tier === "12_percent") {
      stats.tier12PercentOrders += 1;
      stats.tier12PercentRevenueCents += amountCents;
    }
  }

  return stats;
}

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll("\"", "\"\"")}"`;
  }
  return text;
}

export async function exportRewardsCsv(): Promise<string> {
  const balances = await listCustomerBalances();
  const header = ["email", "tier", "status", "pointsBalance"];

  return [
    header.join(","),
    ...balances.map((row) => [row.email, row.tierName, row.status, row.pointsBalance].map(csvEscape).join(",")),
  ].join("\n");
}
