import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getCartRecoveryControlConfig, getShippingConfig } from "@/lib/admin-control";
import {
  cartRecoveryGiftTemplate,
  cartRecoveryT30mTemplate,
  cartRecoveryT12hTemplate,
  cartRecoveryT24hTemplate,
  cartRecoveryT72hTemplate,
} from "@/lib/email/templates";
import { isMarketingSuppressed, sendMarketingEmail } from "@/lib/email/marketing";
import { claimMarketingSend } from "@/lib/email/frequency";
import { internalAddressConfig, isInternalAddress } from "@/lib/email/internal-addresses";
import {
  findLiveCouponForCart,
  loadRecoveryCatalogue,
  mintCartRecoveryCoupon,
  recoveryEmailItems,
  reconciledCartValueCents,
  type AbandonedCartItemSnapshot,
  type RecoveryCatalogueEntry,
  MIN_STAGE_GAP_MS,
  lastStageSentAtFor,
} from "@/lib/cart-recovery";
import { getSiteUrl } from "@/lib/env";
import { isFreeShippingSitewide } from "@/lib/shipping";
import { formatDisplayDate } from "@/lib/format-date";
import { isRevenueOrderStatus, isSaleOrder, netOrderRevenue } from "@/lib/ledger";
import { readAllRowsBounded } from "@/lib/supabase-page";
import { getApplicableBxgyPromotions } from "@/lib/bxgy-promotions";
import { describeOfferTerms, issueCustomerOffer, OFFER_CATALOG } from "@/lib/offers/customer-offers";
import { loadCartRecoveryOverrides, markCartRecoveryOverrideConsumed, resolveOverridePerks } from "@/lib/cart-recovery-overrides";

/**
 * Ceiling on the paged reads below. Matches the figure admin-email.ts uses for
 * the same shape of read (rates over a whole table) so the two dashboards agree
 * on when a number stops being complete.
 */
const MAX_RECOVERY_ROWS = 500_000;

/**
 * `.in(...)` values travel in the request URL, so a long list has to go out in
 * chunks or the URL is rejected. 150 is the size admin-profit.ts settled on for
 * exactly that reason; each chunk keys on a unique column, so a chunk can never
 * return more rows than it has ids and PostgREST's row cap cannot bite.
 */
const IN_CHUNK = 150;

export interface AbandonedCartRow {
  id: string;
  email: string;
  customerName: string | null;
  items: AbandonedCartItemSnapshot[];
  cartValueCents: number;
  firstSeenAt: string;
  status: string;
  recoveredOrderId: string | null;
  stagesSent: string[];
}

export async function listAbandonedCarts(limit = 100): Promise<AbandonedCartRow[]> {
  const { data, error } = await supabaseAdmin
    .from("abandoned_carts")
    .select("id, email, customer_name, items, cart_value_cents, first_seen_at, status, recovered_order_id")
    .order("first_seen_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  const carts = (data ?? []) as unknown as Array<{
    id: string;
    email: string;
    customer_name: string | null;
    items: unknown;
    cart_value_cents: number;
    first_seen_at: string;
    status: string;
    recovered_order_id: string | null;
  }>;

  const cartIds = carts.map((row) => row.id);
  const { data: emailRows } = cartIds.length
    ? await supabaseAdmin.from("abandoned_cart_emails").select("abandoned_cart_id, stage").in("abandoned_cart_id", cartIds)
    : { data: [] as Array<{ abandoned_cart_id: string; stage: string }> };

  const stagesByCart = new Map<string, string[]>();
  for (const row of emailRows ?? []) {
    const list = stagesByCart.get(row.abandoned_cart_id) ?? [];
    list.push(row.stage);
    stagesByCart.set(row.abandoned_cart_id, list);
  }

  return carts.map((row) => ({
    id: row.id,
    email: row.email,
    customerName: row.customer_name,
    items: Array.isArray(row.items) ? (row.items as AbandonedCartItemSnapshot[]) : [],
    cartValueCents: Number(row.cart_value_cents ?? 0),
    firstSeenAt: row.first_seen_at,
    status: row.status,
    recoveredOrderId: row.recovered_order_id,
    stagesSent: stagesByCart.get(row.id) ?? [],
  }));
}

export interface CartRecoveryStats {
  totalAbandoned: number;
  /**
   * Carts closed by ANY paid order from that address inside the window.
   *
   * "Did they come back" — not "did we bring them back". Keep the two apart
   * when rendering: this one reported ten recoveries on 2026-09-10 of which
   * none could be credited to a recovery email.
   */
  totalRecovered: number;
  /**
   * Carts where one of this cart's OWN recovery emails was clicked.
   *
   * The number to judge the programme by. See the derivation in
   * getCartRecoveryStats.
   */
  attributedRecovered: number;
  /** Distinct orders behind `totalRecovered` — one purchase is one recovery. */
  recoveredOrderCount: number;
  /** Carts left out of every figure here because the address is ours. */
  internalCartsExcluded: number;
  recoveryPercent: number;
  potentialLostRevenueCents: number;
  /**
   * NET revenue kept on the orders that closed a recovered cart — the canonical
   * ledger.netOrderRevenue over revenue-status sale orders, not gross
   * `amount_paid`. See the derivation in getCartRecoveryStats for why this is
   * P&L rather than attribution, and what answers the attribution question
   * instead.
   */
  revenueRecoveredCents: number;
  openRatePercent: number;
  clickRatePercent: number;
  couponRedemptionRatePercent: number;
  averageRecoveryTimeHours: number | null;
  /** Per stage: how many went out, and how many of those were opened and clicked. */
  stages: Array<{ stage: string; sent: number; opened: number; clicked: number }>;
}

export async function getCartRecoveryStats(): Promise<CartRecoveryStats> {
  // PAGED, NOT A BARE SELECT (F-A-14). PostgREST caps a single response at
  // `max-rows` — 1000 by default — and does it SILENTLY: the response is a valid
  // array that simply stops. Every figure below is a count of these rows, a sum
  // over them, or a RATIO over them, so a capped read does not fail, it reports
  // the recovery rate of whichever 1000 carts came back as though it were the
  // store's. `id` is the deterministic page key; `first_seen_at` is not unique,
  // so paging on it alone could repeat or skip a cart across a boundary.
  const { rows: allCartRows } = await readAllRowsBounded<{
    id: string;
    email: string | null;
    status: string;
    cart_value_cents: number | null;
    first_seen_at: string;
    recovered_order_id: string | null;
  }>(
    (from, to) => supabaseAdmin
      .from("abandoned_carts")
      .select("id, email, status, cart_value_cents, first_seen_at, recovered_order_id")
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: { id: string; email: string | null; status: string; cart_value_cents: number | null; first_seen_at: string; recovered_order_id: string | null }[] | null;
        error: unknown;
      }>,
    { maxRows: MAX_RECOVERY_ROWS, label: "cart recovery stats read" },
  );

  // OUR OWN TESTING IS NOT CUSTOMER BEHAVIOUR. The owner's two addresses were
  // 25% of carts and 60% of reported recoveries, and they "recover" at 54.5%
  // against 13.8% for real customers because the owner completes the carts
  // they open while testing. Reporting only — internal addresses still receive
  // every message. See email/internal-addresses.ts.
  const internalConfig = internalAddressConfig();
  const rows = allCartRows.filter((row) => !isInternalAddress(row.email, internalConfig));
  const internalCartsExcluded = allCartRows.length - rows.length;

  const totalAbandoned = rows.length;
  const recoveredRows = rows.filter((row) => row.status === "recovered");
  const totalRecovered = recoveredRows.length;

  // ONE ORDER IS ONE RECOVERY, however many carts it closed.
  //
  // A shopper who opens four carts and then buys once had ONE order recovered,
  // not four. Production carried exactly this: order-b8a56a42 was the
  // recovered_order_id of four separate carts, so the cart count reported four
  // recoveries for one purchase while the revenue tile — which reads orders
  // through `.in()` and therefore de-duplicates for free — counted it once.
  // The two tiles disagreed, and the count was the one that was wrong.
  const recoveredOrderCount = new Set(
    recoveredRows.map((row) => row.recovered_order_id).filter((id): id is string => Boolean(id)),
  ).size;
  const potentialLostRevenueCents = rows
    .filter((row) => row.status === "active")
    .reduce((sum, row) => sum + Number(row.cart_value_cents ?? 0), 0);

  const recoveredOrderIds = recoveredRows.map((row) => row.recovered_order_id).filter((id): id is string => Boolean(id));
  let revenueRecoveredCents = 0;
  if (recoveredOrderIds.length > 0) {
    // THIS IS REVENUE, AND IT USES THE REVENUE DEFINITION — a decision, recorded
    // here because the alternative is defensible and was rejected.
    //
    // It summed GROSS `amount_paid` with NO refund subtraction and NO status
    // filter, so a cart "recovered" by an order that never took a payment
    // contributed its full value, and a recovery that was later returned still
    // counted as money kept.
    //
    // The gross figure has an honest reading — ATTRIBUTION: the email did bring
    // the customer back, and a return weeks later is a different event. It is
    // rejected because of where this number is rendered. It is a tile labelled
    // "Revenue Recovered" beside "Potential Lost Revenue", read to decide
    // whether recovery emails pay for themselves, and that question is answered
    // by what the store KEPT. ledger.ts exists so "revenue" means one thing on
    // every surface; a second definition behind a money tile is what it forbids.
    //
    // Attribution is not lost: `totalRecovered` above counts every cart the
    // emails closed, refunded or not. The count says whether the campaign
    // worked; this says what it was worth.
    //
    // CHUNKED because the cart read above is no longer capped at one page:
    // `recoveredOrderIds` can now be arbitrarily long, and an unchunked `.in`
    // would either blow the URL length limit or come back one page short —
    // undercounting a money tile.
    const orders: Array<Record<string, unknown>> = [];
    for (let i = 0; i < recoveredOrderIds.length; i += IN_CHUNK) {
      const { data } = await supabaseAdmin
        .from("orders")
        .select("amount_paid, refund_amount, payment_status, order_type, marketing_source_kind")
        .in("order_id", recoveredOrderIds.slice(i, i + IN_CHUNK));
      orders.push(...((data ?? []) as Array<Record<string, unknown>>));
    }
    // ONE CHANNEL PER ORDER. An order whose primary marketing source is an
    // automation, a campaign, an ambassador or an ad is that channel's revenue
    // and is not "recovered" money as well — the cart count above still
    // records that the cart closed. A recovery-coupon order, an organic
    // order, and an order from before the source existed all count here.
    const creditedElsewhere = (kind: unknown) =>
      typeof kind === "string" && kind !== "" && kind !== "cart_recovery" && kind !== "organic";
    revenueRecoveredCents = orders
      .filter((row) => isRevenueOrderStatus(row.payment_status as string | null) && isSaleOrder(row.order_type as string | null))
      .filter((row) => !creditedElsewhere(row.marketing_source_kind))
      .reduce((sum, row) => sum + Math.round(netOrderRevenue(row as { amount_paid?: number | null; refund_amount?: number | null }) * 100), 0);
  }

  // Paged for the same reason as the cart read: the open and click rates are
  // ratios over the WHOLE of this table, and a capped read makes them the rates
  // of one arbitrary page.
  const { rows: allSentEmails } = await readAllRowsBounded<{
    abandoned_cart_id: string;
    stage: string;
    sent_at: string | null;
    opened_at: string | null;
    clicked_at: string | null;
    coupon_id: string | null;
  }>(
    (from, to) => supabaseAdmin
      .from("abandoned_cart_emails")
      .select("abandoned_cart_id, stage, sent_at, opened_at, clicked_at, coupon_id")
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: { abandoned_cart_id: string; stage: string; sent_at: string | null; opened_at: string | null; clicked_at: string | null; coupon_id: string | null }[] | null;
        error: unknown;
      }>,
    { maxRows: MAX_RECOVERY_ROWS, label: "cart recovery email read" },
  );

  // The same exclusion as the carts above, or the open and click rates would
  // still be measured over our own reading of our own mail.
  //
  // EXCLUDE THE KNOWN-INTERNAL, rather than keeping only the known-external.
  // The two are not equivalent and the difference is F-A-14 again: the cart
  // read is bounded, so keeping only emails whose cart came back in it would
  // silently drop every email belonging to a cart beyond that bound and report
  // the open rate of whatever fitted. An email whose cart is unknown here is
  // counted, which is the same direction internal-addresses.ts argues for —
  // over-exclusion hides real behaviour and is the harder failure to notice.
  const internalCartIds = new Set(
    allCartRows.filter((row) => isInternalAddress(row.email, internalConfig)).map((row) => row.id),
  );
  const sentEmails = allSentEmails.filter((row) => !internalCartIds.has(row.abandoned_cart_id));

  // WHAT THE PROGRAMME CAN ACTUALLY TAKE CREDIT FOR.
  //
  // `totalRecovered` counts a cart as recovered whenever a paid order arrives
  // from that address inside the window — click or no click, email or no
  // email. That answers "did they come back", which is worth knowing and is
  // NOT the same question as "did we bring them back". On 2026-09-10 the
  // dashboard reported ten recoveries; six were the owner, two of the
  // remaining four had been sent no recovery email AT ALL, one was an
  // ambassador referral, and the last never opened either message.
  //
  // A cart counts here only if one of its own recovery emails was clicked.
  // That is the weakest claim that is still a claim, and it is the number to
  // judge the programme by; the looser one stays beside it, labelled for what
  // it is, because a fall in either is worth seeing.
  const clickedCartIds = new Set(
    allSentEmails.filter((row) => row.clicked_at).map((row) => row.abandoned_cart_id),
  );
  const attributedRecovered = recoveredRows.filter((row) => clickedCartIds.has(row.id)).length;

  // Per stage, in sequence order, so the funnel reads top to bottom.
  const stageOrder = ["t30m", "t12h", "t24h", "t72h"];
  const stageTallies = new Map<string, { sent: number; opened: number; clicked: number }>();
  for (const row of sentEmails) {
    const stage = String(row.stage ?? "");
    const tally = stageTallies.get(stage) ?? { sent: 0, opened: 0, clicked: 0 };
    tally.sent += 1;
    if (row.opened_at) tally.opened += 1;
    if (row.clicked_at) tally.clicked += 1;
    stageTallies.set(stage, tally);
  }
  const stages = stageOrder
    .filter((stage) => stageTallies.has(stage))
    .map((stage) => ({ stage, ...(stageTallies.get(stage) as { sent: number; opened: number; clicked: number }) }));

  const openRatePercent = sentEmails.length > 0 ? Math.round((sentEmails.filter((row) => row.opened_at).length / sentEmails.length) * 1000) / 10 : 0;
  const clickRatePercent = sentEmails.length > 0 ? Math.round((sentEmails.filter((row) => row.clicked_at).length / sentEmails.length) * 1000) / 10 : 0;

  const couponEmails = sentEmails.filter((row) => row.coupon_id);
  let couponRedemptionRatePercent = 0;
  if (couponEmails.length > 0) {
    const couponIds = couponEmails.map((row) => row.coupon_id).filter((id): id is string => Boolean(id));
    const coupons: Array<Record<string, unknown>> = [];
    for (let i = 0; i < couponIds.length; i += IN_CHUNK) {
      const { data } = await supabaseAdmin
        .from("coupons")
        .select("id, redemptions_count")
        .in("id", couponIds.slice(i, i + IN_CHUNK));
      coupons.push(...((data ?? []) as Array<Record<string, unknown>>));
    }
    const redeemedCount = coupons.filter((row) => Number(row.redemptions_count ?? 0) > 0).length;
    couponRedemptionRatePercent = Math.round((redeemedCount / couponEmails.length) * 1000) / 10;
  }

  let averageRecoveryTimeHours: number | null = null;
  if (recoveredOrderIds.length > 0) {
    const orderTimestamps: Array<{ order_id: string; created_at: string }> = [];
    for (let i = 0; i < recoveredOrderIds.length; i += IN_CHUNK) {
      const { data } = await supabaseAdmin
        .from("orders")
        .select("order_id, created_at")
        .in("order_id", recoveredOrderIds.slice(i, i + IN_CHUNK));
      orderTimestamps.push(...((data ?? []) as Array<{ order_id: string; created_at: string }>));
    }
    const orderCreatedAtByOrderId = new Map(orderTimestamps.map((row) => [row.order_id, row.created_at]));
    const durations = recoveredRows
      .map((row) => {
        const orderCreatedAt = row.recovered_order_id ? orderCreatedAtByOrderId.get(row.recovered_order_id) : null;
        if (!orderCreatedAt) return null;
        return (new Date(String(orderCreatedAt)).getTime() - new Date(row.first_seen_at).getTime()) / (60 * 60 * 1000);
      })
      .filter((value): value is number => value !== null && value >= 0);

    if (durations.length > 0) {
      averageRecoveryTimeHours = Math.round((durations.reduce((sum, value) => sum + value, 0) / durations.length) * 10) / 10;
    }
  }

  return {
    totalAbandoned,
    totalRecovered,
    attributedRecovered,
    recoveredOrderCount,
    internalCartsExcluded,
    recoveryPercent: totalAbandoned > 0 ? Math.round((totalRecovered / totalAbandoned) * 1000) / 10 : 0,
    potentialLostRevenueCents,
    revenueRecoveredCents,
    openRatePercent,
    clickRatePercent,
    couponRedemptionRatePercent,
    averageRecoveryTimeHours,
    stages,
  };
}

export interface RecoveryTrendPoint {
  date: string;
  abandoned: number;
  recovered: number;
}

export async function getCartRecoveryTrend(days: number): Promise<RecoveryTrendPoint[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // Paged for the same reason as getCartRecoveryStats: a date range is not a row
  // cap, and a capped read here draws a chart that flattens out partway through
  // the window rather than failing.
  const { rows } = await readAllRowsBounded<{ first_seen_at: string; status: string }>(
    (from, to) => supabaseAdmin
      .from("abandoned_carts")
      .select("first_seen_at, status")
      .gte("first_seen_at", since.toISOString())
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: { first_seen_at: string; status: string }[] | null; error: unknown }>,
    { maxRows: MAX_RECOVERY_ROWS, label: "cart recovery trend read" },
  );

  const byDate = new Map<string, { abandoned: number; recovered: number }>();
  for (const row of rows) {
    const date = String(row.first_seen_at).slice(0, 10);
    const entry = byDate.get(date) ?? { abandoned: 0, recovered: 0 };
    entry.abandoned += 1;
    if (row.status === "recovered") entry.recovered += 1;
    byDate.set(date, entry);
  }

  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts }));
}

function restoreUrl(cartId: string) {
  return `${getSiteUrl()}/cart/restore?id=${cartId}`;
}

// Manual "resend recovery email" - re-sends whichever stage the admin
// picks, regardless of what the automatic sweep has already sent (an
// explicit admin action, not subject to the sweep's once-per-stage guard).
/** The highest-value line's slug, for the batch number the proof email names. */
function leadSlugForItems(
  items: ReadonlyArray<Partial<AbandonedCartItemSnapshot>>,
  catalogue: ReadonlyMap<string, RecoveryCatalogueEntry>,
): string {
  let best = "";
  let bestValue = -1;
  for (const item of items) {
    const slug = String(item?.slug ?? "").trim();
    const entry = slug ? catalogue.get(slug) : undefined;
    if (!entry) continue;
    const quantity = Math.max(1, Math.floor(Number(item?.quantity ?? 1)) || 1);
    const value = (Number(entry.unitPriceCents) || 0) * quantity;
    if (value > bestValue) { bestValue = value; best = slug; }
  }
  return best;
}

/** Where a shopper replies. Must stay a real inbox — it renders as a mailto. */
const RECOVERY_SUPPORT_EMAIL = "support@vantalabsresearch.com";

export async function resendCartRecoveryEmail(cartId: string, stage: "t30m" | "t12h" | "t24h" | "t72h") {
  const { data: cart, error } = await supabaseAdmin
    .from("abandoned_carts")
    .select("id, email, customer_name, items, cart_value_cents")
    .eq("id", cartId)
    .maybeSingle();

  if (error) throw error;
  if (!cart) throw new Error("Cart not found");

  // SUPPRESSED MEANS NOTHING HAPPENS. sendMarketingEmail would refuse this
  // address anyway, but by then the t72h branch below had already minted a
  // real discount code and reset the tracking row for a mail that never went.
  if (await isMarketingSuppressed(cart.email)) {
    return { success: false, suppressed: true, error: "This address is unsubscribed or suppressed. Nothing was sent and no code was minted." };
  }

  const config = await getCartRecoveryControlConfig();
  // RENDERED FROM THE CATALOGUE, exactly as the sweep does it (AUTH-3). This
  // path used to pass the stored snapshot straight into the template, so the
  // admin resend button re-opened the hole the sweep had closed: the tracking
  // beacon stores whatever the browser posted, per line, verbatim. It also
  // meant a manual resend showed no product image and no price, while the same
  // stage sent by the sweep showed both.
  const storedItems = Array.isArray(cart.items) ? (cart.items as AbandonedCartItemSnapshot[]) : [];
  let catalogue: Map<string, RecoveryCatalogueEntry>;
  try {
    catalogue = await loadRecoveryCatalogue(storedItems.map((item) => String(item?.slug ?? "")));
  } catch (error) {
    console.error("[admin-cart-recovery] catalogue unavailable; nothing resent", error);
    return { success: false, error: "The product catalogue could not be read, so nothing was sent. Try again in a moment." };
  }
  const items = recoveryEmailItems(storedItems, catalogue);
  if (items.length === 0) {
    return { success: false, error: "Nothing in this cart is a live product any more, so there is no honest email to build from it." };
  }
  // THE SAME RECONCILED TOTAL THE SWEEP PRINTS, for the same reason.
  //
  // cart_value_cents is a snapshot from whenever the beacon fired; `items` above
  // has just been re-read from the live catalogue and re-priced at the dose the
  // shopper chose. Passing the snapshot printed a "Cart total" that the summary
  // above it contradicted — and the resend is the path an operator presses
  // deliberately, on the carts that matter most, so it is the worst place to
  // show a number the shopper can disprove by clicking through.
  const cartValueCents = reconciledCartValueCents(items, Number(cart.cart_value_cents ?? 0));
  const leadSlug = leadSlugForItems(storedItems, catalogue);
  const batchNumber = leadSlug ? catalogue.get(leadSlug)?.batchNumber ?? "" : "";
  const name = cart.customer_name ?? "";

  // THE SAME FLOOR THE SWEEP KEEPS. Stages are exempt from the 24-hour quiet
  // period against each other, so the guard below lets a resend go minutes
  // after the sweep's own stage; on 2026-09-07 an operator batch put a third
  // cart email of the day into two real inboxes that way. The sweep now holds
  // a stage for MIN_STAGE_GAP_MS after the previous one (cart-recovery.ts), and
  // a resend is not the way round it. Read before the guard so a refusal
  // claims nothing, mints nothing and arms no cooldown.
  const lastStageSentAt = await lastStageSentAtFor(cart.id);
  if (lastStageSentAt !== null && Date.now() - lastStageSentAt < MIN_STAGE_GAP_MS) {
    const retryAt = lastStageSentAt + MIN_STAGE_GAP_MS;
    return {
      success: false,
      deferred: true,
      retryAt,
      error: `Held: this cart's previous stage went at ${formatDisplayDate(lastStageSentAt, "datetime") ?? "an unknown time"} ET, and stages keep at least ${Math.round(MIN_STAGE_GAP_MS / 3_600_000)} hours between them. The resend can go after ${formatDisplayDate(retryAt, "datetime") ?? "an unknown time"} ET.`,
    };
  }

  // THE GUARD FIRST, before anything is minted or reset. A manual resend is
  // an explicit admin action and skips the sweep's per-stage and 30-day
  // cooldowns — but it is still one marketing email to one inbox, and the
  // one-a-day rule is the same rule for everyone. Asked here so a deferral
  // costs nothing: no coupon minted for a mail that did not go, no tracking
  // row saying "sent just now", no seven-day cooldown armed by a non-send.
  const campaignType = `cart_recovery_${stage}`;
  const guard = await claimMarketingSend({
    email: cart.email,
    campaignType,
    referenceId: cart.id,
    templateKey: campaignType,
  });
  if (guard.outcome === "deferred") {
    return {
      success: false,
      deferred: true,
      retryAt: guard.retryAt,
      error: `Held by the marketing frequency guard: this customer received a marketing email at ${formatDisplayDate(guard.lastMarketingAt, "datetime") ?? "an unknown time"} ET. The resend can go after ${formatDisplayDate(guard.retryAt, "datetime") ?? "an unknown time"} ET.`,
    };
  }
  if (guard.outcome === "duplicate" || guard.outcome === "refused") {
    return { success: false, error: "This message could not be claimed for sending." };
  }
  const claimedLogId = guard.outcome === "claimed" ? guard.logId : null;
  const guardUnavailable = guard.outcome === "unavailable";

  let couponId: string | null = null;
  let couponCode: string | null = null;
  let couponExpiresAt: string | null = null;
  let couponPercent = 0;
  // Only the final stage carries a code now; the 24-hour message answers
  // questions instead. A manual resend is an explicit admin action, so it
  // mints without the sweep's per-address cooldown — but it REUSES the cart's
  // live code first, exactly as the sweep does (resolveLastChanceCoupon): a
  // second click used to mint a second stackable-by-order code for the same
  // cart, and every click after that another.
  // A REPLACED STAGE CARRIES ITS GIFT HERE TOO.
  //
  // The sweep is not the only way a stage goes out: an operator can resend one,
  // and a cart whose sequence has already run to the end can ONLY be reached
  // this way. If the two paths disagreed about which template a replaced stage
  // renders, the same cart would get the gift from the cron and the ordinary
  // reminder from the button — so the lookup is the same lookup.
  const override = (await loadCartRecoveryOverrides([cart.id])).get(`${cart.id}::${stage}`);

  // A GIFT GOES OUT ONCE, AND A SECOND PRESS IS NOT A SECOND GIFT.
  //
  // Resending an ordinary reminder is harmless and is what this button is for.
  // Resending a gift is not: issueCustomerOffer keeps at most one live token
  // per address per campaign, so minting a second one RETIRES the first — the
  // customer gets two emails and the link in the one they already opened stops
  // working. Nothing else stops this. The sweep is protected by its stage
  // claim; this path reuses the row by design, and the cart_recovery family is
  // exempt from the frequency guard's quiet window, so neither of those would
  // catch a double click.
  if (override && override.consumedAt) {
    return {
      success: false,
      error: `This cart's gift email already went out at ${formatDisplayDate(override.consumedAt, "datetime") ?? "an unknown time"} ET. `
        + "Sending it again would issue a new entitlement and break the link in the message they already have.",
    };
  }

  if (stage === "t72h" && !override) {
    const coupon = (await findLiveCouponForCart(cart.id))
      ?? (await mintCartRecoveryCoupon(cart.email, config.discountPercent, config.couponExpirationHours));
    if (coupon) {
      couponCode = coupon.code;
      couponExpiresAt = coupon.expiresAt;
      couponPercent = coupon.percent;
      const { data: couponRow } = await supabaseAdmin.from("coupons").select("id").eq("code", coupon.code).maybeSingle();
      couponId = couponRow?.id ?? null;
    }
  }

  // "Resend" reuses the same (cart, stage) tracking row rather than
  // inserting a duplicate - the unique index on abandoned_cart_emails
  // enforces one row per stage per cart, and resetting opened_at/clicked_at
  // means tracking reflects this new send, not a stale earlier one.
  const { data: existingRow } = await supabaseAdmin
    .from("abandoned_cart_emails")
    .select("id")
    .eq("abandoned_cart_id", cart.id)
    .eq("stage", stage)
    .maybeSingle();

  let rowId: string;
  if (existingRow) {
    rowId = existingRow.id;
    await supabaseAdmin
      .from("abandoned_cart_emails")
      .update({ sent_at: new Date().toISOString(), opened_at: null, clicked_at: null, coupon_id: couponId })
      .eq("id", rowId);
  } else {
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from("abandoned_cart_emails")
      .insert({ abandoned_cart_id: cart.id, stage, sent_at: new Date().toISOString(), coupon_id: couponId })
      .select("id")
      .single();
    if (insertError || !inserted) throw insertError ?? new Error("Unable to create tracking row");
    rowId = inserted.id;
  }

  // The gift is minted only once the tracking row exists, mirroring the sweep's
  // claim-first order: a mint in front of it can be repeated by a failing send.
  let offerToken: string | null = null;
  if (override?.offerKey) {
    const issued = await issueCustomerOffer({ email: cart.email, offerKey: override.offerKey, referenceId: cart.id });
    offerToken = issued?.token ?? null;
    if (!offerToken) {
      return { success: false, error: "The gift for this cart could not be issued, so nothing was sent. Try again in a moment." };
    }
  }

  const offerParam = offerToken ? `&o=${encodeURIComponent(offerToken)}` : "";
  const trackedRestoreUrl = `${getSiteUrl()}/api/email/track/click?id=${rowId}&url=${encodeURIComponent(restoreUrl(cart.id))}${offerParam}`;
  const openTrackingPixelUrl = `${getSiteUrl()}/api/email/track/open?id=${rowId}`;

  if (override) {
    // FREE SHIPPING IS STATED ONLY IF THE STORE IS ACTUALLY GIVING IT.
    // Read from the live shipping configuration, the same one the checkout
    // prices through, so the line cannot outlive the setting.
    // DEDUPLICATED THROUGH THE SHARED HELPER, because this path and the sweep
    // each used to build the list themselves — so the sweep could be fixed
    // while this one, the button the operator actually presses, kept shipping
    // "Free shipping / Free shipping / 2-day shipping, on us".
    let freeShippingSitewide = false;
    try {
      freeShippingSitewide = isFreeShippingSitewide(await getShippingConfig());
    } catch {
      // A perk we cannot confirm is a perk we do not claim.
    }
    const overridePerks = resolveOverridePerks(override.perks, freeShippingSitewide);

    let promotionNote: string | null = null;
    try {
      const live = await getApplicableBxgyPromotions({ customerEmail: cart.email });
      const headline = live.find((promotion) => !promotion.hidden) ?? live[0];
      if (headline) {
        // THE DEADLINE COMES OFF THE PROMOTION ROW, not out of the copy. So
        // "limited time" is only ever said when the store genuinely holds an
        // end date, and the date shown is the one the checkout stops honouring
        // the promotion at. Clear the endsAt and this sentence loses its
        // deadline by itself rather than going stale in a template.
        const endsAt = headline.endsAt ? new Date(headline.endsAt) : null;
        const endsOn = endsAt && Number.isFinite(endsAt.getTime())
          ? endsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" })
          : null;
        promotionNote = endsOn
          ? `Our ${headline.name} offer runs through ${endsOn} \u2014 a limited-time sale.`
          : `Our ${headline.name} offer is still running where eligible.`;
      }
    } catch {
      // The message is about the gift; a missing mention is not worth failing on.
    }
    const result = await sendMarketingEmail({
      to: cart.email,
      campaignType,
      referenceId: cart.id,
      templateKey: "cartRecoveryGiftTemplate",
      openTrackingPixelUrl,
      claimedLogId,
      guardUnavailable,
      ...cartRecoveryGiftTemplate({
        name, items, cartValueCents,
        restoreUrl: trackedRestoreUrl,
        giftLabel: override.offerKey ? OFFER_CATALOG[override.offerKey].label : "",
        offerTerms: override.offerKey
          ? describeOfferTerms(
              override.offerKey,
              new Date(Date.now() + OFFER_CATALOG[override.offerKey].ttlDays * 24 * 60 * 60 * 1000).toISOString(),
            )
          : "",
        promotionNote,
        perks: overridePerks,
        offerPercent: override.offerKey && "percent" in OFFER_CATALOG[override.offerKey].reward
          ? Number((OFFER_CATALOG[override.offerKey].reward as { percent: number }).percent)
          : 0,
        }),
    });
    if (result.success) {
      await markCartRecoveryOverrideConsumed({ cartId: cart.id, stage, reservationId: rowId });
    }
    return result;
  }

  if (stage === "t30m") {
    return sendMarketingEmail({
      to: cart.email,
      campaignType: "cart_recovery_t30m",
      referenceId: cart.id,
      templateKey: "cartRecoveryT30mTemplate",
      openTrackingPixelUrl,
      claimedLogId,
      guardUnavailable,
      ...cartRecoveryT30mTemplate({ name, items, cartValueCents, restoreUrl: trackedRestoreUrl }),
    });
  }

  if (stage === "t12h") {
    return sendMarketingEmail({
      to: cart.email,
      campaignType: "cart_recovery_t12h",
      referenceId: cart.id,
      templateKey: "cartRecoveryT12hTemplate",
      openTrackingPixelUrl,
      claimedLogId,
      guardUnavailable,
      ...cartRecoveryT12hTemplate({
        name, items, cartValueCents, restoreUrl: trackedRestoreUrl,
        coaUrl: `${getSiteUrl()}/coa-library`,
        batchNumber,
        supportEmail: RECOVERY_SUPPORT_EMAIL,
      }),
    });
  }

  if (stage === "t24h") {
    return sendMarketingEmail({
      to: cart.email,
      campaignType: "cart_recovery_t24h",
      referenceId: cart.id,
      templateKey: "cartRecoveryT24hTemplate",
      openTrackingPixelUrl,
      claimedLogId,
      guardUnavailable,
      // A MANUAL RESEND MINTS NO GIFT. The sweep's stage-3 gift is an
      // entitlement with a cost, gated by the segmentation rules and issued
      // once behind a stage claim; a button that re-issued one on every press
      // would be a free-vial dispenser. The operator gets the message, not the
      // gift. The Labor Day-style override path above is how a gift is sent by
      // hand, and it refuses a second press.
      ...cartRecoveryT24hTemplate({
        name, items, cartValueCents, restoreUrl: trackedRestoreUrl,
        giftLabel: "", offerTerms: "",
      }),
    });
  }

  return sendMarketingEmail({
    to: cart.email,
    campaignType: "cart_recovery_t72h",
    referenceId: cart.id,
    templateKey: "cartRecoveryT72hTemplate",
    openTrackingPixelUrl,
    claimedLogId,
    guardUnavailable,
    ...cartRecoveryT72hTemplate({
      name,
      items,
      cartValueCents,
      restoreUrl: trackedRestoreUrl,
      couponCode: couponCode ?? "",
      discountPercent: couponCode ? couponPercent : 0,
      expiresAt: couponExpiresAt ? formatDisplayDate(couponExpiresAt, "datetime") ?? "" : "",
      // Same reasoning as stage 3 above: no gift is minted by a resend.
      giftLabel: "",
      offerTerms: "",
    }),
  });
}

/**
 * THE FUNNEL, WITH ITS MIDDLE PUT BACK.
 *
 * getCartRecoveryStats above reports sent / opened / clicked / recovered, and
 * every one of those four was doing work it could not do:
 *
 *   OPENED is contaminated. Heath Greve's stage-2 open is stamped seven seconds
 *   after the send; Nikki R's stages 1 and 2 are stamped at the same
 *   millisecond. Those are Gmail and Apple image prefetches, not reads. It is
 *   reported here for completeness and must not be used to judge anything.
 *
 *   RECOVERED counted any paid order from that address inside the window, click
 *   or no click. On 2026-09-06 it counted Neil Hidalgo, who received zero
 *   emails. That is the question "did they come back", not "did we bring them
 *   back", and the two were indistinguishable.
 *
 *   Between CLICKED and RECOVERED there was nothing, so nobody could see that a
 *   click was landing shoppers in carts that could not check out.
 *
 * This answers the question the money depends on: of the carts we mailed, how
 * many clicked, how many got a working cart back, how many bought, what that
 * was worth NET OF WHAT IT COST, and how much of it we can actually claim.
 *
 * ATTRIBUTED vs SELF-SERVE is the split that matters most. A recovery credited
 * to `marketing_source_kind = 'cart_recovery'` followed a click or spent a code
 * this programme issued. One without it is a customer who came back on their
 * own, and counting those as recoveries is how a programme with one click ever
 * looked like it was working.
 */
export interface CartRecoveryFunnel {
  windowDays: number;
  sent: number;
  /** Reported, but contaminated by image prefetch. Do not judge anything on it. */
  openedUnreliable: number;
  clicked: number;
  /** Carts a recovery link actually handed back — the click produced a cart. */
  restored: number;
  purchases: number;
  recoveredRevenueCents: number;
  merchandiseCostCents: number;
  /** What the incentives cost: discount given away plus the COGS of gifts spent. */
  incentiveCostCents: number;
  recoveredGrossProfitCents: number;
  attributedRecoveries: number;
  /** Carts that closed with no click and no attributed order. Not ours. */
  selfServeRecoveries: number;
  byVariant: Array<{ variant: string; sent: number; clicked: number }>;
}

export async function getCartRecoveryFunnel(days = 30): Promise<CartRecoveryFunnel> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const empty: CartRecoveryFunnel = {
    windowDays: days, sent: 0, openedUnreliable: 0, clicked: 0, restored: 0, purchases: 0,
    recoveredRevenueCents: 0, merchandiseCostCents: 0, incentiveCostCents: 0,
    recoveredGrossProfitCents: 0, attributedRecoveries: 0, selfServeRecoveries: 0, byVariant: [],
  };

  const { data: sends } = await supabaseAdmin
    .from("abandoned_cart_emails")
    .select("abandoned_cart_id, opened_at, clicked_at, variant")
    .gte("sent_at", since);
  const sendRows = (sends ?? []) as Array<{
    abandoned_cart_id: string; opened_at: string | null; clicked_at: string | null; variant: string | null;
  }>;

  const byVariant = new Map<string, { sent: number; clicked: number }>();
  const mailedCartIds = new Set<string>();
  for (const row of sendRows) {
    mailedCartIds.add(String(row.abandoned_cart_id));
    const key = row.variant ?? "unassigned";
    const bucket = byVariant.get(key) ?? { sent: 0, clicked: 0 };
    bucket.sent += 1;
    if (row.clicked_at) bucket.clicked += 1;
    byVariant.set(key, bucket);
  }

  const funnel: CartRecoveryFunnel = {
    ...empty,
    sent: sendRows.length,
    openedUnreliable: sendRows.filter((row) => row.opened_at).length,
    clicked: sendRows.filter((row) => row.clicked_at).length,
    byVariant: [...byVariant.entries()]
      .map(([variant, counts]) => ({ variant, ...counts }))
      .sort((a, b) => a.variant.localeCompare(b.variant)),
  };
  if (mailedCartIds.size === 0) return funnel;

  // Restores and recoveries, over the carts this window actually mailed.
  const cartIds = [...mailedCartIds];
  const carts: Array<{ id: string; status: string; restored_at: string | null; recovered_order_id: string | null }> = [];
  for (let i = 0; i < cartIds.length; i += IN_CHUNK) {
    const { data } = await supabaseAdmin
      .from("abandoned_carts")
      .select("id, status, restored_at, recovered_order_id")
      .in("id", cartIds.slice(i, i + IN_CHUNK));
    carts.push(...((data ?? []) as typeof carts));
  }
  funnel.restored = carts.filter((cart) => cart.restored_at).length;

  // ORDERS THIS PROGRAMME CAN ACTUALLY CLAIM. marketing-source.ts decides one
  // primary channel per order, so this cannot double-count an order a campaign
  // or an automation also touched — that discipline is the whole reason the
  // column exists.
  const { data: orders } = await supabaseAdmin
    .from("orders")
    .select("order_id, amount_paid, refund_amount, discount_amount, payment_status, order_type, replacement_of")
    .eq("marketing_source_kind", "cart_recovery")
    .gte("created_at", since);
  const attributed = ((orders ?? []) as Array<Record<string, unknown>>)
    // isSaleOrder takes the TYPE, not the row — a membership renewal or a
    // replacement is not a recovered sale and must not be counted as one.
    .filter((row) => isRevenueOrderStatus(String(row.payment_status ?? ""))
      && isSaleOrder(row.order_type as string | null | undefined)
      && !row.replacement_of);

  funnel.purchases = attributed.length;
  funnel.recoveredRevenueCents = attributed.reduce((sum, row) => sum + Math.round(netOrderRevenue(row) * 100), 0);
  funnel.incentiveCostCents = attributed.reduce((sum, row) => sum + Math.round(Number(row.discount_amount ?? 0) * 100), 0);

  // COGS from the order lines themselves, which is where the real per-unit cost
  // lives. A gift shipped at $0 still has a line and still has a unit cost, so
  // the vials this programme gives away are counted here rather than estimated.
  const orderIds = attributed.map((row) => String(row.order_id));
  for (let i = 0; i < orderIds.length; i += IN_CHUNK) {
    const { data } = await supabaseAdmin
      .from("order_items")
      .select("unit_cost_cents, quantity")
      .in("order_id", orderIds.slice(i, i + IN_CHUNK));
    for (const line of (data ?? []) as Array<{ unit_cost_cents: number | null; quantity: number | null }>) {
      funnel.merchandiseCostCents += Number(line.unit_cost_cents ?? 0) * Number(line.quantity ?? 0);
    }
  }
  funnel.recoveredGrossProfitCents = funnel.recoveredRevenueCents - funnel.merchandiseCostCents;

  // THE SPLIT THAT DECIDES WHETHER ANY OF THIS PAID FOR ITSELF.
  const attributedOrderIds = new Set(orderIds);
  const clickedCarts = new Set(sendRows.filter((row) => row.clicked_at).map((row) => String(row.abandoned_cart_id)));
  for (const cart of carts) {
    if (cart.status !== "recovered") continue;
    const orderId = cart.recovered_order_id ? String(cart.recovered_order_id) : "";
    if (attributedOrderIds.has(orderId) || clickedCarts.has(String(cart.id))) funnel.attributedRecoveries += 1;
    else funnel.selfServeRecoveries += 1;
  }

  return funnel;
}


/**
 * The products a recovery band may hand out, with what each really costs.
 *
 * COSTS COME FROM THE DOSE ROW, NEVER THE PARENT. `products.product_cost_cents`
 * holds inherited EvoLabs figures that quote-order.ts measures at 1.4x-6.8x the
 * true landed cost and explicitly refuses to price from. Reading it here would
 * put a number on the admin screen that is wrong by up to seven times, on the
 * one screen where the owner is deciding how much to give away.
 *
 * A product with no dose cost is returned with a null cost rather than a
 * guessed one: the margin readout says "cost unknown" for it, which is the
 * honest answer and the one that prompts somebody to fill the figure in.
 */
export type GiftableProduct = {
  slug: string;
  name: string;
  priceCents: number;
  costCents: number | null;
};

export async function listGiftableProducts(): Promise<GiftableProduct[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("products")
      .select("slug, name, price_cents, product_doses(price_cents, product_cost_cents, is_default, position)")
      .eq("is_active", true)
      .eq("is_enabled", true)
      .eq("is_published", true)
      .eq("is_archived", false)
      .order("name");
    if (error) throw error;

    return (data ?? []).map((row) => {
      const doses = (row.product_doses ?? []) as Array<{
        price_cents: number | null; product_cost_cents: number | null; is_default: boolean | null; position: number | null;
      }>;
      const chosen = doses.find((dose) => dose.is_default)
        ?? [...doses].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
      return {
        slug: String(row.slug ?? ""),
        name: String(row.name ?? row.slug ?? ""),
        priceCents: Number(chosen?.price_cents ?? row.price_cents ?? 0),
        costCents: chosen?.product_cost_cents == null ? null : Number(chosen.product_cost_cents),
      };
    }).filter((product) => product.slug);
  } catch {
    // An empty list disables the band editor's product pickers rather than
    // breaking the page. The sweep has its own catalogue read and is unaffected.
    return [];
  }
}


/**
 * The two figures the band editor needs beyond the product list, measured
 * rather than assumed.
 *
 * POSTAGE IS A REAL COST HERE because the store ships free sitewide, so every
 * recovered order carries it. It is FIXED, which is why it matters so much more
 * to a small cart than a large one — leaving it out overstates the smallest
 * band's margin by around thirteen points, and that is the band most at risk of
 * being over-served.
 *
 * THE PRODUCT COST RATIO comes from the DOSE rows. The parent
 * `products.product_cost_cents` holds inherited EvoLabs figures that
 * quote-order.ts measures at 1.4x-6.8x the true landed cost and refuses to
 * price from; using it here would put a margin on screen that is wrong by up to
 * seven times on the one page where the owner decides how much to give away.
 *
 * Both fall back to conservative constants when there is nothing to measure —
 * a new store with no paid orders still gets a sane readout, and the numbers
 * only get truer as orders arrive.
 */
export type RecoveryEconomicsInputs = { postageCents: number; productCostRatio: number };

/** Until there are paid orders to measure. Roughly this store's observed average. */
const FALLBACK_POSTAGE_CENTS = 793;
/** Until there are dose costs to measure. Deliberately pessimistic. */
const FALLBACK_PRODUCT_COST_RATIO = 0.2;

export async function loadRecoveryEconomicsInputs(): Promise<RecoveryEconomicsInputs> {
  let postageCents = FALLBACK_POSTAGE_CENTS;
  let productCostRatio = FALLBACK_PRODUCT_COST_RATIO;

  try {
    const { data } = await supabaseAdmin
      .from("orders")
      .select("actual_shipping_cost_cents, postage_cost_cents, estimated_shipping_cost_cents")
      .eq("payment_status", "paid")
      .limit(200);
    const costs = (data ?? [])
      .map((row) => Number(row.actual_shipping_cost_cents ?? row.postage_cost_cents ?? row.estimated_shipping_cost_cents ?? 0))
      .filter((cost) => Number.isFinite(cost) && cost > 0);
    if (costs.length > 0) {
      postageCents = Math.round(costs.reduce((sum, cost) => sum + cost, 0) / costs.length);
    }
  } catch {
    // Keep the fallback. A readout from a default is better than no page.
  }

  try {
    const { data } = await supabaseAdmin
      .from("product_doses")
      .select("price_cents, product_cost_cents, is_default")
      .eq("is_default", true);
    const rows = (data ?? [])
      .map((row) => ({ price: Number(row.price_cents ?? 0), cost: Number(row.product_cost_cents ?? 0) }))
      .filter((row) => row.price > 0 && row.cost > 0);
    if (rows.length > 0) {
      // Revenue-weighted, not a mean of ratios: a $120 product and a $15 one do
      // not contribute equally to what a cart of mixed items costs.
      const revenue = rows.reduce((sum, row) => sum + row.price, 0);
      const cost = rows.reduce((sum, row) => sum + row.cost, 0);
      productCostRatio = cost / revenue;
    }
  } catch {
    // Keep the fallback.
  }

  return { postageCents, productCostRatio };
}
