import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { isPaidOrderStatus, isSaleOrder, netOrderRevenue } from "@/lib/ledger";
import { readAllRowsBounded } from "@/lib/supabase-page";
import { isNonMailableAddress } from "@/lib/email/non-mailable";

/**
 * F-A-19. These reads used `readAllRows`, which stops as soon as a page comes
 * back shorter than its page size — safe only while the server's row cap is
 * exactly that size, and the application cannot read that setting.
 *
 * `readAllRowsBounded` advances by the rows it actually received and probes one
 * row past its ceiling, so it reports truncation rather than inferring the end
 * of the table from a short page.
 *
 * A truncated audience read is not a soft failure here. Two of these decide who
 * gets mail and one decides who must NOT, so a short read is either a person
 * missing a campaign or a person who unsubscribed receiving one. Both are
 * refused loudly instead of being quietly delivered.
 */
const MAX_AUDIENCE_ROWS = 500_000;
const AUDIENCE_TRUNCATED =
  "Could not read the whole marketing audience, so this send was refused rather than sent to an incomplete or unfiltered list.";

/**
 * Who a campaign goes to.
 *
 * CONSENT IS THE FLOOR, AND IT IS NOT A SEGMENT. Every segment below is applied
 * as a filter ON TOP of the consented set — never as a way of reaching someone
 * who hasn't opted in. "Customers who bought category X" means *consented*
 * customers who bought category X. Having someone's address because they placed
 * an order is not permission to market to them, and keeping that rule in one
 * place is the only way it stays true as segments get added.
 *
 * Consent has two stores, for a real reason rather than an accident:
 *   * `customer_preferences.marketing_emails` — account holders, keyed by user id
 *   * `marketing_subscribers` — guests, keyed by email (a guest has no user row)
 *
 * Suppression (`email_suppressions`) is subtracted here as well as being
 * enforced per-send by sendMarketingEmail. That is deliberate duplication: the
 * per-send check is the guarantee, but subtracting up front is what makes the
 * recipient count the admin sees before pressing Send the truth rather than an
 * overestimate that quietly shrinks.
 */

export type CampaignSegment =
  | "all"
  | "purchasers"
  | "first_time"
  | "repeat"
  | "high_value"
  | "dormant_30"
  | "dormant_60"
  | "dormant_90"
  | "account_no_order"
  | "category";

/**
 * A "high-value" customer has spent at least this much, net, across paid
 * orders. About three full-price vials. Stated here rather than buried so the
 * threshold can be argued about in one place; it is a segment boundary, not a
 * fact about customers.
 */
export const HIGH_VALUE_SPEND_CENTS = 30_000;

export const CAMPAIGN_SEGMENTS: Array<{ value: CampaignSegment; label: string; needsParam?: boolean; hint: string }> = [
  { value: "all", label: "All marketing subscribers", hint: "Everyone who opted in and hasn't unsubscribed." },
  { value: "purchasers", label: "Customers who purchased before", hint: "At least one paid order." },
  { value: "first_time", label: "First-time customers", hint: "Exactly one paid order. Good for a second-order nudge; skip the discount for these." },
  { value: "repeat", label: "Repeat customers", hint: "Two or more paid orders. Announcements and new products land best here." },
  { value: "high_value", label: "High-value customers", hint: `Net spend of $${(HIGH_VALUE_SPEND_CENTS / 100).toFixed(0)} or more. Early access and gifts, not percentage discounts.` },
  { value: "dormant_30", label: "No order in 30+ days", hint: "Bought before, but not recently." },
  { value: "dormant_60", label: "No order in 60+ days", hint: "Bought before, but not recently." },
  { value: "dormant_90", label: "No order in 90+ days", hint: "Bought before, but not recently." },
  { value: "account_no_order", label: "Signed up, never ordered", hint: "Has an account, no paid order yet." },
  { value: "category", label: "Bought a specific category", hint: "Ordered any product in the chosen category.", needsParam: true },
];

export function isCampaignSegment(value: unknown): value is CampaignSegment {
  return CAMPAIGN_SEGMENTS.some((segment) => segment.value === value);
}

const DORMANT_DAYS: Partial<Record<CampaignSegment, number>> = {
  dormant_30: 30,
  dormant_60: 60,
  dormant_90: 90,
};

function normalize(email: unknown): string {
  return String(email ?? "").trim().toLowerCase();
}

export type ConsentedAudience = {
  /** Opted in via an account preference. */
  accounts: Set<string>;
  /** Opted in by email (guest checkout, footer, anywhere without an account). */
  subscribers: Set<string>;
  /** The union, already minus suppressions. */
  all: Set<string>;
};

/**
 * Load everyone who may receive marketing, split by how they consented.
 *
 * The split matters for exactly one segment — "signed up, never ordered" is
 * about account holders specifically — but resolving it here keeps every caller
 * from having to know that two consent stores exist.
 */
export async function loadConsentedAudience(): Promise<ConsentedAudience> {
  const accounts = new Set<string>();
  const subscribers = new Set<string>();

  // Paged for the same reason as the lists below: past the server's row cap an
  // unpaged read returns a short list with no error, silently dropping
  // account-holders from every audience.
  const { rows: prefs, truncated: prefsTruncated } = await readAllRowsBounded<{ user_id: string }>(
    (from, to) => supabaseAdmin
      .from("customer_preferences")
      .select("user_id")
      .eq("marketing_emails", true)
      .order("user_id", { ascending: true })
      .range(from, to),
    { maxRows: MAX_AUDIENCE_ROWS, label: "marketing opt-in read" },
  );
  if (prefsTruncated) throw new Error(AUDIENCE_TRUNCATED);

  const optedInUserIds = new Set(prefs.map((row) => row.user_id).filter(Boolean));

  // Resolve opted-in user ids to addresses by paging the auth admin list once,
  // rather than one lookup per customer against a rate-limited API.
  if (optedInUserIds.size > 0) {
    const PER_PAGE = 1000;
    const MAX_PAGES = 100;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data: pageData, error: pageError } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PER_PAGE });
      if (pageError) throw pageError;
      const users = pageData?.users ?? [];
      for (const user of users) {
        if (optedInUserIds.has(user.id)) {
          const email = normalize(user.email);
          if (email) accounts.add(email);
        }
      }
      if (users.length < PER_PAGE) break;
    }
  }

  // Paged: an unpaged read stops at the server's row cap without saying so,
  // which would silently drop subscribers from every audience past that point.
  const { rows: subs, truncated: subsTruncated } = await readAllRowsBounded<{ email: string }>(
    (from, to) => supabaseAdmin
      .from("marketing_subscribers")
      .select("email")
      .is("unsubscribed_at", null)
      .order("email", { ascending: true })
      .range(from, to),
    { maxRows: MAX_AUDIENCE_ROWS, label: "marketing subscriber read" },
  );
  if (subsTruncated) throw new Error(AUDIENCE_TRUNCATED);
  for (const row of subs) {
    const email = normalize(row.email);
    if (email) subscribers.add(email);
  }

  // Subtract unsubscribes last, so an address can never survive by being
  // present in the other consent store.
  // Paged, and this is the one that matters most: a truncated suppression list
  // does not fail, it just stops mentioning some of the people who
  // unsubscribed — and the next campaign mails them.
  const { rows: suppressed, truncated: suppressionTruncated } = await readAllRowsBounded<{ email: string }>(
    (from, to) => supabaseAdmin
      .from("email_suppressions")
      .select("email")
      // Any stable key will do; paging without one can repeat or skip rows, and
      // a SKIPPED row here is a person who unsubscribed getting mail.
      .order("email", { ascending: true })
      .range(from, to),
    { maxRows: MAX_AUDIENCE_ROWS, label: "suppression list read" },
  );
  // FATAL, not best-effort. Every other read in this function failing short
  // means someone does not get an email they wanted. This one failing short
  // means someone gets an email they asked to stop receiving, which is the one
  // outcome that is not ours to absorb.
  if (suppressionTruncated) throw new Error(AUDIENCE_TRUNCATED);
  const blocked = new Set(suppressed.map((row) => normalize(row.email)));

  for (const email of blocked) {
    accounts.delete(email);
    subscribers.delete(email);
  }

  // A TEST ADDRESS ON A REAL CAMPAIGN IS A SELF-INFLICTED BOUNCE.
  //
  // marketing_subscribers is written by the checkout opt-in, so testing
  // checkout with a provider sink address puts it straight onto this list. A
  // send to bounced@resend.dev is a bounce recorded against this domain and a
  // send to complained@resend.dev is a spam complaint recorded against it —
  // both on purpose, both every time. The audit found all three sink addresses
  // already used from this account.
  for (const email of [...accounts, ...subscribers]) {
    if (!isNonMailableAddress(email)) continue;
    accounts.delete(email);
    subscribers.delete(email);
  }

  const all = new Set<string>([...accounts, ...subscribers]);
  return { accounts, subscribers, all };
}

type PurchaseHistory = {
  /** email → most recent paid order time (ms). */
  lastPaidAt: Map<string, number>;
  /** email → number of paid orders. */
  orderCount: Map<string, number>;
  /** email → net spend in cents across paid orders (amount paid less refunds). */
  spendCents: Map<string, number>;
};

/**
 * Every paid order's email and date, paged.
 *
 * Only PAID orders count. A pending or failed checkout is not a purchase, and
 * treating it as one would put a genuine never-ordered customer into the
 * "bought before" segment and out of the win-back they should have received.
 */
async function loadPurchaseHistory(): Promise<PurchaseHistory> {
  const lastPaidAt = new Map<string, number>();
  const orderCount = new Map<string, number>();
  const spendCents = new Map<string, number>();
  const PAGE = 1000;

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("customer_email, payment_status, created_at, order_type, amount_paid, refund_amount")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      if (!isPaidOrderStatus(row.payment_status as string | null)) continue;
      // Replacement reships and membership charges are not purchases of
      // product; they must not make someone a "repeat customer".
      if (!isSaleOrder((row as { order_type?: string | null }).order_type)) continue;
      const email = normalize(row.customer_email);
      if (!email) continue;
      const at = new Date(String(row.created_at)).getTime();
      if (!Number.isFinite(at)) continue;
      const existing = lastPaidAt.get(email);
      if (existing === undefined || at > existing) lastPaidAt.set(email, at);
      orderCount.set(email, (orderCount.get(email) ?? 0) + 1);
      spendCents.set(
        email,
        (spendCents.get(email) ?? 0) + Math.round(netOrderRevenue(row as { amount_paid?: number | null; refund_amount?: number | null }) * 100),
      );
    }
    if (rows.length < PAGE) break;
  }

  return { lastPaidAt, orderCount, spendCents };
}

/** Emails that have a paid order containing any product in `category`. */
async function loadCategoryBuyers(category: string): Promise<Set<string>> {
  const wanted = category.trim();
  const buyers = new Set<string>();
  if (!wanted) return buyers;

  const { data: products, error: productsError } = await supabaseAdmin
    .from("products")
    .select("slug")
    .eq("category", wanted);
  if (productsError) throw productsError;
  const slugs = new Set((products ?? []).map((row) => String(row.slug ?? "")).filter(Boolean));
  if (slugs.size === 0) return buyers;

  // order_items.product_id holds the product SLUG (verified against live rows),
  // and order_id is the human order key, not a uuid — so the join back to
  // orders is on that text column.
  const paidOrderIds = new Set<string>();
  const orderEmail = new Map<string, string>();
  const PAGE = 1000;

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("order_id, customer_email, payment_status")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      if (!isPaidOrderStatus(row.payment_status as string | null)) continue;
      const id = String(row.order_id ?? "");
      const email = normalize(row.customer_email);
      if (!id || !email) continue;
      paidOrderIds.add(id);
      orderEmail.set(id, email);
    }
    if (rows.length < PAGE) break;
  }

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("order_items")
      .select("order_id, product_id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      const orderId = String(row.order_id ?? "");
      if (!paidOrderIds.has(orderId)) continue;
      if (!slugs.has(String(row.product_id ?? ""))) continue;
      const email = orderEmail.get(orderId);
      if (email) buyers.add(email);
    }
    if (rows.length < PAGE) break;
  }

  return buyers;
}

/**
 * Pure segment filter, exported so the rules can be tested without a database.
 *
 * `now` is injected rather than read from the clock so the dormancy boundaries
 * are assertable — an off-by-one in a 30-day window is invisible in production
 * and obvious in a test.
 */
export function applySegment(input: {
  segment: CampaignSegment;
  audience: ConsentedAudience;
  lastPaidAt: Map<string, number>;
  orderCount?: Map<string, number>;
  spendCents?: Map<string, number>;
  categoryBuyers?: Set<string>;
  now: number;
}): string[] {
  const { segment, audience, lastPaidAt, now } = input;
  const candidates = Array.from(audience.all);
  const orderCount = input.orderCount ?? new Map<string, number>();
  const spendCents = input.spendCents ?? new Map<string, number>();

  switch (segment) {
    case "all":
      return candidates;

    case "purchasers":
      return candidates.filter((email) => lastPaidAt.has(email));

    case "first_time":
      return candidates.filter((email) => (orderCount.get(email) ?? 0) === 1);

    case "repeat":
      return candidates.filter((email) => (orderCount.get(email) ?? 0) >= 2);

    case "high_value":
      return candidates.filter((email) => (spendCents.get(email) ?? 0) >= HIGH_VALUE_SPEND_CENTS);

    case "dormant_30":
    case "dormant_60":
    case "dormant_90": {
      const days = DORMANT_DAYS[segment] ?? 30;
      const cutoff = now - days * 24 * 60 * 60 * 1000;
      // Must have bought at some point: someone who never ordered is a
      // different campaign (and a different message) than someone lapsing.
      return candidates.filter((email) => {
        const at = lastPaidAt.get(email);
        return at !== undefined && at <= cutoff;
      });
    }

    case "account_no_order":
      // Account holders specifically — a guest who opted in at checkout but
      // whose payment failed is not someone who "signed up".
      return candidates.filter((email) => audience.accounts.has(email) && !lastPaidAt.has(email));

    case "category": {
      const buyers = input.categoryBuyers ?? new Set<string>();
      return candidates.filter((email) => buyers.has(email));
    }

    default:
      return [];
  }
}

/** Resolve a segment to the addresses that should receive the campaign. */
export async function resolveAudience(input: {
  segment: CampaignSegment;
  segmentParam?: string | null;
  now?: number;
}): Promise<string[]> {
  const audience = await loadConsentedAudience();
  if (audience.all.size === 0) return [];

  // Skip the work each segment doesn't need — "all" is the common case and
  // shouldn't page the entire orders table to answer.
  const needsHistory = input.segment !== "all" && input.segment !== "category";
  const history = needsHistory
    ? await loadPurchaseHistory()
    : { lastPaidAt: new Map<string, number>(), orderCount: new Map<string, number>(), spendCents: new Map<string, number>() };
  const categoryBuyers = input.segment === "category"
    ? await loadCategoryBuyers(String(input.segmentParam ?? ""))
    : undefined;

  return applySegment({
    segment: input.segment,
    audience,
    lastPaidAt: history.lastPaidAt,
    orderCount: history.orderCount,
    spendCents: history.spendCents,
    categoryBuyers,
    now: input.now ?? Date.now(),
  });
}
