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
}

export async function getMembershipAnalytics(): Promise<MembershipAnalytics> {
  const [{ data: memberships, error: membershipError }, { data: ledgerRows, error: ledgerError }, { data: events, error: eventsError }] = await Promise.all([
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
  ]);

  if (membershipError) throw membershipError;
  if (ledgerError) throw ledgerError;
  if (eventsError) throw eventsError;

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

  return {
    monthlyRecurringRevenueCents: Math.round(mrrCents),
    activeMembersByTier: Array.from(tierCounts.entries()).map(([tierName, count]) => ({ tierName, count })),
    totalPointsOutstanding,
    activePromotionalEventCount: (events ?? []).length,
  };
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
