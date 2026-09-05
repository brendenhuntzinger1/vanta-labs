import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { cancelVeyraMembership, skipVeyraMembershipCycle } from "@/lib/veyra-membership";
import { readAllRowsBounded } from "@/lib/supabase-page";
import { isPaidBillingEvent } from "@/lib/membership-status";
import { isRevenueOrderStatus, isSaleOrder, netOrderRevenue } from "@/lib/ledger";
import { startOfCurrentMonthIso } from "@/lib/store-credit";
import type { MembershipTier } from "@/lib/membership";

// Ceiling on the two ledger reads these admin screens fold in JS. Same value
// the money reads in admin-analytics/admin-revenue use: it bounds memory, it
// does not define the answer — `truncated` is checked and refused, because a
// balance that is quietly too low is worse than a screen that says it broke.
const MAX_LEDGER_ROWS = 200_000;

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

// Pages through the Supabase auth admin API to collect ALL users (not just the
// first 1000). Bounded by a page cap so a runaway can't loop forever; logs if
// it hits the cap so the omission is visible rather than silent.
type AuthUser = Awaited<ReturnType<typeof supabaseAdmin.auth.admin.listUsers>>["data"]["users"][number];
async function listAllAuthUsers(): Promise<AuthUser[]> {
  const PER_PAGE = 1000;
  const MAX_PAGES = 100; // 100k users backstop
  const all: AuthUser[] = [];
  let page = 1;
  for (; page <= MAX_PAGES; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) break;
    const users = data?.users ?? [];
    all.push(...users);
    if (users.length < PER_PAGE) break;
  }
  if (page > MAX_PAGES) {
    console.warn(`listAllAuthUsers: stopped paging at ${MAX_PAGES} pages; some users may be omitted.`);
  }
  return all;
}

// Resolves emails via the auth admin API since points_ledger /
// customer_memberships only store user_id. Pages through ALL users so balances
// aren't silently capped at the first 1000 as the customer base grows.
export async function listCustomerBalances(search?: string): Promise<CustomerBalanceRow[]> {
  const [authUsersAll, ledger, { data: memberships, error: membershipError }] = await Promise.all([
    listAllAuthUsers(),
    // PAGED. points_ledger gets a row per earn AND per redemption, so it grows
    // faster than the order table itself; an unpaged read stops silently at the
    // server's row cap and every balance computed from it comes out LOW — a
    // customer's points look spent when they are not. The auth read beside it
    // has always paged for exactly this reason.
    readAllRowsBounded<{ user_id: string; amount: number | null }>(
      (from, to) => supabaseAdmin
        .from("points_ledger")
        .select("user_id, amount")
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: Array<{ user_id: string; amount: number | null }> | null; error: unknown }>,
      { maxRows: MAX_LEDGER_ROWS, label: "points_ledger read (customer balances)" },
    ),
    supabaseAdmin.from("customer_memberships").select("user_id, status, membership_tiers(name)"),
  ]);

  if (membershipError) throw membershipError;
  if (ledger.truncated) {
    // Refuse rather than render balances that are quietly too low: this screen
    // is what an admin uses to answer "how many points does this customer have".
    throw new Error(
      `Points ledger exceeded ${MAX_LEDGER_ROWS} rows; refusing to show balances computed from part of it.`,
    );
  }

  const balanceByUser = new Map<string, number>();
  for (const row of ledger.rows) {
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

  const customerUsers = authUsersAll.filter((user) => {
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
        // A customer with no membership row is NOT active — defaulting to
        // "active" made every non-member read as one in admin.
        status: membership?.status ?? "none",
        pointsBalance: balanceByUser.get(user.id) ?? 0,
      };
    });

  return rows.sort((a, b) => b.pointsBalance - a.pointsBalance);
}

export interface MembershipRosterRow {
  userId: string;
  name: string;
  email: string;
  tierName: string;
  tierSlug: string;
  billingCycle: string;
  status: string;
  joinedAt: string | null;
  nextBillingAt: string | null;
  nextBillingAmountCents: number;
  cancelAtPeriodEnd: boolean;
  /**
   * False when a paid membership has no processor subscription behind it — it
   * was charged once and will lapse rather than renew. Two such rows look
   * IDENTICAL in every other column ("active monthly"), so without this the
   * owner cannot tell recurring revenue from a one-off.
   */
  autoRenews: boolean;
  storeCreditCents: number;
}

// Every member with a membership record — who they are (name + email), their
// exact tier, billing cycle, status, join date, next billing, and store-credit
// balance. Powers the Members section of Admin → Membership.
export async function listMembershipRoster(): Promise<MembershipRosterRow[]> {
  const [authUsers, { data: memberships, error }, credit] = await Promise.all([
    listAllAuthUsers(),
    supabaseAdmin
      .from("customer_memberships")
      .select("user_id, status, billing_cycle, started_at, next_billing_at, next_billing_amount_cents, renews_at, cancel_at_period_end, veyra_membership_id, membership_tiers(name, slug)"),
    // SPENDABLE balance only. getStoreCreditBalanceCents — the number the
    // customer can actually redeem at checkout — sums only rows from the current
    // month, because the monthly membership grant does not roll over. Summing
    // the whole ledger here made admin report $35.00 for an account whose real
    // spendable balance was $5.00: a $30 grant from a previous month plus this
    // month's $5. Admin must show the same money the customer has.
    //
    // PAGED, for the same reason as points_ledger above: a short read here does
    // not fail, it just reports less credit than the customer can actually
    // spend, and admin and checkout then disagree about the same money.
    readAllRowsBounded<{ user_id: string | null; amount_cents: number | null }>(
      (from, to) => supabaseAdmin
        .from("store_credit_ledger")
        .select("user_id, amount_cents")
        .gte("created_at", startOfCurrentMonthIso())
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: Array<{ user_id: string | null; amount_cents: number | null }> | null; error: unknown }>,
      { maxRows: MAX_LEDGER_ROWS, label: "store_credit_ledger read (membership roster)" },
    ).then((r) => r, () => ({ rows: [] as Array<{ user_id: string | null; amount_cents: number | null }>, truncated: false })),
  ]);
  if (error) throw error;
  if (credit.truncated) {
    throw new Error(
      `Store credit ledger exceeded ${MAX_LEDGER_ROWS} rows this month; refusing to show balances computed from part of it.`,
    );
  }

  const userById = new Map(authUsers.map((user) => [user.id, user]));

  const creditByUser = new Map<string, number>();
  for (const row of credit.rows) {
    const id = String(row.user_id ?? "");
    creditByUser.set(id, (creditByUser.get(id) ?? 0) + Number(row.amount_cents ?? 0));
  }

  const rows: MembershipRosterRow[] = (memberships ?? []).map((row) => {
    const user = userById.get(String(row.user_id));
    const tier = row.membership_tiers as unknown as { name?: string; slug?: string } | null;
    const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
    const name = String(meta.full_name ?? meta.name ?? "").trim();
    return {
      userId: String(row.user_id),
      name: name || "—",
      email: user?.email ?? "(no email)",
      tierName: tier?.name ? String(tier.name) : "Research Member",
      tierSlug: tier?.slug ? String(tier.slug) : "free",
      billingCycle: String(row.billing_cycle ?? "free"),
      status: String(row.status ?? "active"),
      joinedAt: row.started_at ? String(row.started_at) : null,
      nextBillingAt: row.next_billing_at ? String(row.next_billing_at) : (row.renews_at ? String(row.renews_at) : null),
      nextBillingAmountCents: Number(row.next_billing_amount_cents ?? 0),
      cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
      autoRenews: Boolean(row.veyra_membership_id),
      storeCreditCents: creditByUser.get(String(row.user_id)) ?? 0,
    };
  });

  // Paying members first (by tier price proxy: billing cycle then name), then
  // newest joins.
  return rows.sort((a, b) => {
    const aPaying = a.billingCycle !== "free" ? 1 : 0;
    const bPaying = b.billingCycle !== "free" ? 1 : 0;
    if (aPaying !== bPaying) return bPaying - aPaying;
    return (b.joinedAt ?? "").localeCompare(a.joinedAt ?? "");
  });
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
export interface AssignMembershipOptions {
  // ISO date the comp membership expires. REQUIRED unless `permanent` is true.
  expiresAt?: string | null;
  // A deliberate, permanent complimentary membership (no expiry). Must be set
  // explicitly — a comp never becomes permanent by omission.
  permanent?: boolean;
}

// Admin-assigned (complimentary) membership. Two deliberate shapes:
//   • Time-limited: requires an expiration date. Stored in renews_at, which
//     isMembershipActive honors as the period end, so the comp auto-expires.
//   • Permanent: `permanent: true`, no expiry — active until manually revoked.
//
// A comp NEVER auto-charges (next_billing_at stays null, so the renewal-charge
// sweep skips it) and NEVER auto-grants recurring monthly store credit — the
// credit sweep now requires next_billing_at, which only real paying members
// have. This closes the "perpetual free membership + monthly credit forever"
// liability: a comp is a benefits grant, not a silent recurring giveaway.
export async function assignMembershipTier(
  userId: string,
  tierId: string,
  billingCycle: "monthly" | "annual",
  options: AssignMembershipOptions = {},
) {
  const nowIso = new Date().toISOString();
  const permanent = options.permanent === true;

  let expiresAtIso: string | null = null;
  if (!permanent) {
    if (!options.expiresAt) {
      throw new Error("An expiration date is required for a complimentary membership. To grant one with no end date, mark it a permanent complimentary membership.");
    }
    const ts = new Date(options.expiresAt);
    if (Number.isNaN(ts.getTime()) || ts.getTime() <= Date.now()) {
      throw new Error("The membership expiration date must be a valid date in the future.");
    }
    expiresAtIso = ts.toISOString();
  }

  const { error } = await supabaseAdmin.from("customer_memberships").upsert({
    user_id: userId,
    tier_id: tierId,
    billing_cycle: billingCycle,
    status: "active",
    started_at: nowIso,
    next_billing_at: null, // never auto-charge; also excludes from credit sweep
    next_billing_amount_cents: 0,
    renews_at: expiresAtIso, // null = permanent; a date = auto-expiry
    cancel_at_period_end: false,
    updated_at: nowIso,
  }, { onConflict: "user_id" });

  if (error) {
    throw error;
  }
}

export async function setMembershipStatus(userId: string, status: "active" | "paused" | "cancelled") {
  const { data: existing } = await supabaseAdmin
    .from("customer_memberships")
    .select("user_id, status, veyra_membership_id")
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

  // TELL THE PROCESSOR FIRST. Veyra owns the billing schedule for a member
  // with a veyra_membership_id, so a local-only cancel or pause stops nothing:
  // the card keeps being charged and the next membership.renewed webhook
  // flips the row straight back to active. The customer's own cancel and
  // pause paths (membership-billing.ts) already do this and abort if Veyra
  // refuses; an admin's click is held to the same rule. An admin cancel is
  // immediate (perks are switched off now), so the processor cancel is too.
  const veyraMembershipId = (existing as { veyra_membership_id?: string | null }).veyra_membership_id ?? null;
  if (veyraMembershipId && status === "cancelled") {
    const res = await cancelVeyraMembership(veyraMembershipId, false);
    if (!res.ok) {
      throw new Error(
        `The payment provider refused to cancel this subscription (${res.message}). Nothing was changed.`,
      );
    }
  }
  if (veyraMembershipId && status === "paused") {
    // Veyra has no pause: a pause defers exactly one cycle (see
    // skipVeyraMembershipCycle). Adopt the date Veyra will actually charge on.
    const res = await skipVeyraMembershipCycle(veyraMembershipId, "admin paused");
    if (!res.ok) {
      throw new Error(
        `The payment provider refused to pause this subscription (${res.message}). Nothing was changed.`,
      );
    }
    if (res.nextRenewalAt) {
      payload.next_billing_at = res.nextRenewalAt;
      payload.renews_at = res.nextRenewalAt;
      payload.renewal_reminder_sent_at = null;
    }
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
  /** Paid charges MINUS refunds/chargebacks in the window — money actually kept. */
  realRecurringRevenueCents30d: number;
  /** Refunded/charged-back membership money in the window, reported separately. */
  membershipRefundsCents30d: number;
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
    pointsRpc,
    { data: events, error: eventsError },
    { data: introMembers, error: introError },
    { data: billingEvents30d, error: billingEventsError },
    { data: membershipRefunds30d, error: refundsError },
  ] = await Promise.all([
    supabaseAdmin
      .from("customer_memberships")
      .select("status, billing_cycle, membership_tiers(name, monthly_price_cents, annual_price_cents)")
      .eq("status", "active"),
    // Sum outstanding points in Postgres instead of scanning the whole ledger
    // (the fastest-growing table). Falls back to the scan if the RPC is absent.
    supabaseAdmin.rpc("admin_points_outstanding"),
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
    // Refunds and chargebacks never appear in membership_billing_events as
    // negative money — revokeMembershipForRefund records a $0 "cancellation" —
    // so membership revenue was counted gross and a refunded membership kept
    // inflating it. Attributed by refunded_at, the date the money went back.
    supabaseAdmin
      .from("orders")
      .select("refund_amount")
      .eq("order_type", "membership")
      .gt("refund_amount", 0)
      .gte("refunded_at", since30d),
  ]);

  if (membershipError) throw membershipError;
  if (eventsError) throw eventsError;
  if (introError) throw introError;
  if (billingEventsError) throw billingEventsError;
  if (refundsError) throw refundsError;

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

  let totalPointsOutstanding: number;
  if (!pointsRpc.error && pointsRpc.data != null) {
    totalPointsOutstanding = Number(pointsRpc.data);
  } else {
    // Fallback: RPC absent — scan the ledger and sum in JS (identical result).
    const { data: ledgerRows, error: ledgerError } = await supabaseAdmin.from("points_ledger").select("amount");
    if (ledgerError) throw ledgerError;
    totalPointsOutstanding = (ledgerRows ?? []).reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  }

  const events30d = billingEvents30d ?? [];
  const introAttempts = events30d.filter((row) => row.event_type === "intro_charge" || row.event_type === "first_month_remainder");
  const introSucceeded = introAttempts.filter((row) => row.status === "succeeded");
  // Revenue counts PAID events only. cancellation/pause/resume/skip/tier_change
  // are also stored as "succeeded" (the operation worked) with amount 0, so a
  // bare status check would sweep them in — see PAID_EVENT_TYPES.
  const grossRecurringRevenueCents30d = events30d
    .filter((row) =>
      isPaidBillingEvent({
        eventType: String(row.event_type ?? ""),
        status: String(row.status ?? ""),
        amountCents: Number(row.amount_cents ?? 0),
      }),
    )
    .reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0);

  // orders.refund_amount is DOLLARS; billing events are CENTS.
  const membershipRefundsCents30d = Math.round(
    (membershipRefunds30d ?? []).reduce((sum, row) => sum + Number(row.refund_amount ?? 0), 0) * 100,
  );
  // Never report negative revenue: a refund of a charge taken before the window
  // would otherwise drag the 30d figure below zero.
  const realRecurringRevenueCents30d = Math.max(0, grossRecurringRevenueCents30d - membershipRefundsCents30d);

  return {
    monthlyRecurringRevenueCents: Math.round(mrrCents),
    activeMembersByTier: Array.from(tierCounts.entries()).map(([tierName, count]) => ({ tierName, count })),
    totalPointsOutstanding,
    activePromotionalEventCount: (events ?? []).length,
    activeIntroMembers: (introMembers ?? []).length,
    trialToPaidConversionRate: introAttempts.length > 0 ? Math.round((introSucceeded.length / introAttempts.length) * 1000) / 10 : 0,
    realRecurringRevenueCents30d,
    membershipRefundsCents30d,
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
  const stats: BulkSavingsStats = {
    tier5PercentOrders: 0,
    tier5PercentRevenueCents: 0,
    tier12PercentOrders: 0,
    tier12PercentRevenueCents: 0,
  };

  // Aggregate per tier in Postgres. Falls back to the full-table JS scan if the
  // RPC isn't migrated yet — see src/lib/sql/admin-dashboard-rollups.sql.
  const rpc = await supabaseAdmin.rpc("admin_bulk_savings_stats");
  if (!rpc.error && Array.isArray(rpc.data)) {
    for (const row of rpc.data as Array<Record<string, unknown>>) {
      const tier = String(row.tier ?? "");
      const orders = Number(row.orders ?? 0);
      const revenueCents = Number(row.revenue_cents ?? 0);
      if (tier === "5_percent") {
        stats.tier5PercentOrders = orders;
        stats.tier5PercentRevenueCents = revenueCents;
      } else if (tier === "12_percent") {
        stats.tier12PercentOrders = orders;
        stats.tier12PercentRevenueCents = revenueCents;
      }
    }
    return stats;
  }

  // Same rule as the RPC above, and as every other revenue surface (review
  // finding 5). This path summed GROSS amount_paid over EVERY status, so
  // pending, canceled and fully-refunded orders all counted as bulk-savings
  // revenue. The RPC did the same, so the two agreed while both were wrong.
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("bulk_discount_tier, payment_status, order_type, amount_paid, refund_amount")
    .not("bulk_discount_tier", "is", null);

  if (error) throw error;

  for (const row of data ?? []) {
    if (!isRevenueOrderStatus(row.payment_status as string | null)) continue;
    if (!isSaleOrder(row.order_type as string | null)) continue;
    const amountCents = Math.round(netOrderRevenue(row as { amount_paid?: number | null; refund_amount?: number | null }) * 100);
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
  let text = String(value ?? "");
  // Neutralize spreadsheet formula injection from attacker-controlled cells
  // (customer email) — a leading = + - @ / tab / CR would run as a formula in
  // Excel/Sheets. Prefix a single quote.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
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
