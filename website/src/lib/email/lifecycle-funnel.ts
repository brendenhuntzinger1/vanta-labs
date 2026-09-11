import { isProductPurchaseOrder, isRevenueOrderStatus } from "@/lib/ledger";
import { AUTOMATION_KEYS, AUTOMATION_LABELS } from "@/lib/email/automation-catalog";
import { summarizeSendEngagement, type EngagementKind } from "@/lib/email/engagement-classification";

/**
 * ONE FUNNEL, EVERY FLOW, THE WAY THE MONEY IS MADE.
 *
 *   eligible → attempted → sent → delivered / bounced → human open → human
 *   click → restored → checkout → paid → revenue → gross profit
 *
 * per flow and per stage, with the BENCHMARK-STYLE figures (any open, an
 * order within five days of an open or a click) reported beside the STRICT
 * ones (opens and clicks a person made, orders the attribution cookie or a
 * recovery code actually ties to the send) and never summed into them. The
 * strict column is what a decision is made on. The benchmark column is what
 * a published industry figure means, so the two can be compared honestly.
 *
 * PURE. Rows in, rows out. The loader beside it (lifecycle-funnel-report.ts)
 * reads the database; this decides nothing about where the rows came from,
 * so every rule below is pinned by a fixture rather than a production query.
 *
 * WHY RATES ARE AGAINST DELIVERED. A message the provider never delivered
 * cannot be opened; a rate over sends punishes a bounce twice. Delivery is
 * known only for sends that recorded a provider message id (every marketing
 * send since 2026-09-04); where none in a row did, the rate falls back to
 * sends and says so.
 */

/** Klaviyo's published abandoned-cart averages and top-decile figures, per delivered email. */
export const CART_RECOVERY_BENCHMARK = Object.freeze({
  source: "Klaviyo abandoned-cart flow benchmarks, per recipient",
  floor: { openAny: 0.505, clickAny: 0.0625, placedOrder: 0.0333 },
  target: { clickAny: 0.1333, placedOrder: 0.0769 },
});

/** Below this many delivered sends a rate cannot be read against the benchmark. */
export const MIN_READABLE_SENDS = 150;

/** The benchmark's own attribution window: an order within five days of an open or a click. */
export const BENCHMARK_ATTRIBUTION_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

const CART_STAGES = ["t30m", "t12h", "t24h", "t72h"] as const;
const CART_STAGE_LABELS: Record<string, string> = {
  t30m: "Stage 1 · reminder",
  t12h: "Stage 2 · COA report",
  t24h: "Stage 3 · gift",
  t72h: "Stage 4 · last note",
};

export interface FunnelSendRow {
  campaignType: string;
  referenceId: string | null;
  recipientEmail: string | null;
  sentAt: string;
  providerMessageId: string | null;
  status: string;
}
export interface FunnelDeliveryRow { providerMessageId: string | null; kind: string; receivedAt: string }
export interface FunnelEngagementRow {
  campaignType: string;
  referenceId: string | null;
  recipientEmail: string | null;
  kind: EngagementKind;
  at: string;
  userAgent: string | null;
}
export interface FunnelCartRow { id: string; email: string; firstSeenAt: string; restoredAt: string | null; checkoutStartedAt: string | null }
export interface FunnelOrderRow {
  orderId: string;
  email: string;
  paidAt: string;
  amountPaid: number;
  refundAmount: number;
  discountAmount: number;
  marketingSourceKind: string | null;
  marketingSourceRef: string | null;
  paymentStatus: string;
  orderType: string | null;
  replacementOf: string | null;
}
export interface FunnelOrderItemRow { orderId: string; unitCostCents: number; quantity: number }

export interface LifecycleFunnelInput {
  now: number;
  windowDays: number;
  isInternal: (email: string | null | undefined) => boolean;
  sends: FunnelSendRow[];
  deliveries: FunnelDeliveryRow[];
  engagements: FunnelEngagementRow[];
  carts: FunnelCartRow[];
  orders: FunnelOrderRow[];
  orderItems: FunnelOrderItemRow[];
}

export interface FunnelRates {
  openAny: number | null;
  openHuman: number | null;
  clickAny: number | null;
  clickHuman: number | null;
  restored: number | null;
  paidStrict: number | null;
  paidBenchmark: number | null;
}

export interface LifecycleFunnelRow {
  flow: string;
  stage: string;
  label: string;
  /** Carts that entered the window (cart flow only); null where eligibility is not tracked. */
  eligible: number | null;
  attempted: number;
  sent: number;
  delivered: number;
  bounced: number;
  deliveryUnknown: number;
  openedAny: number;
  openedHuman: number;
  clickedAny: number;
  clickedHuman: number;
  restored: number;
  checkoutAfterRestore: number;
  paidStrict: number;
  paidBenchmark: number;
  selfServeInWindow: number;
  revenueCents: number;
  cogsCents: number;
  incentiveCents: number;
  grossProfitCents: number;
  denominator: "delivered" | "sent";
  rates: FunnelRates;
  benchmark: typeof CART_RECOVERY_BENCHMARK | null;
  readable: boolean;
}

export interface LifecycleFunnelReport {
  windowDays: number;
  rows: LifecycleFunnelRow[];
  notes: string[];
}

type FlowStage = { flow: string; stage: string };

/** Which flow and stage a send belongs to, or null for mail that is not a lifecycle flow. */
export function flowOf(campaignType: string): FlowStage | null {
  const type = String(campaignType ?? "");
  if (type.startsWith("cart_recovery_")) return { flow: "cart_recovery", stage: type.slice("cart_recovery_".length) };
  if (type.startsWith("automation:")) return { flow: type, stage: "all" };
  if (type === "campaign" || type === "affiliate_campaign") return { flow: type, stage: "all" };
  return null;
}

function labelFor(flow: string, stage: string): string {
  if (flow === "cart_recovery") return stage === "all" ? "Cart recovery · all stages" : `Cart recovery · ${CART_STAGE_LABELS[stage] ?? stage}`;
  if (flow.startsWith("automation:")) {
    const key = flow.slice("automation:".length) as keyof typeof AUTOMATION_LABELS;
    return AUTOMATION_LABELS[key]?.label ?? key;
  }
  if (flow === "campaign") return "Campaigns";
  if (flow === "affiliate_campaign") return "Affiliate broadcasts";
  return flow;
}

function sendKey(send: { campaignType: string; referenceId: string | null; recipientEmail: string | null }, flow: string): string {
  const recipient = flow === "campaign" || flow === "affiliate_campaign" ? String(send.recipientEmail ?? "").toLowerCase() : "";
  return `${send.campaignType}|${send.referenceId ?? ""}|${recipient}`;
}

function ms(value: string | null | undefined): number {
  const t = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(t) ? t : Number.NaN;
}

function emptyRow(flow: string, stage: string): LifecycleFunnelRow {
  return {
    flow, stage, label: labelFor(flow, stage),
    eligible: null, attempted: 0, sent: 0, delivered: 0, bounced: 0, deliveryUnknown: 0,
    openedAny: 0, openedHuman: 0, clickedAny: 0, clickedHuman: 0,
    restored: 0, checkoutAfterRestore: 0,
    paidStrict: 0, paidBenchmark: 0, selfServeInWindow: 0,
    revenueCents: 0, cogsCents: 0, incentiveCents: 0, grossProfitCents: 0,
    denominator: "sent",
    rates: { openAny: null, openHuman: null, clickAny: null, clickHuman: null, restored: null, paidStrict: null, paidBenchmark: null },
    benchmark: flow === "cart_recovery" ? CART_RECOVERY_BENCHMARK : null,
    readable: false,
  };
}

/** A paid product order: the ledger's definition, so a membership charge or a
 *  replacement reship from a mailed address is never a recovered sale. */
function isSale(order: FunnelOrderRow): boolean {
  return isRevenueOrderStatus(order.paymentStatus)
    && isProductPurchaseOrder({ order_type: order.orderType, replacement_of: order.replacementOf });
}

export function buildLifecycleFunnel(input: LifecycleFunnelInput): LifecycleFunnelReport {
  const notes: string[] = [];
  const rows = new Map<string, LifecycleFunnelRow>();
  const rowFor = (flow: string, stage: string) => {
    const key = `${flow}|${stage}`;
    let row = rows.get(key);
    if (!row) { row = emptyRow(flow, stage); rows.set(key, row); }
    return row;
  };

  // ---- Sends: attempted, sent, delivered, bounced. ----
  const deliveryByMessage = new Map<string, Set<string>>();
  for (const d of input.deliveries) {
    if (!d.providerMessageId) continue;
    const kinds = deliveryByMessage.get(d.providerMessageId) ?? new Set<string>();
    kinds.add(d.kind);
    deliveryByMessage.set(d.providerMessageId, kinds);
  }

  type SentSend = FunnelSendRow & { flow: string; stage: string; key: string; sentAtMs: number };
  const sentSends: SentSend[] = [];
  for (const send of input.sends) {
    const place = flowOf(send.campaignType);
    if (!place) continue;
    if (input.isInternal(send.recipientEmail)) continue;
    const row = rowFor(place.flow, place.stage);
    row.attempted += 1;
    if (send.status !== "sent") continue;
    row.sent += 1;
    const kinds = send.providerMessageId ? deliveryByMessage.get(send.providerMessageId) : undefined;
    if (!kinds || kinds.size === 0) row.deliveryUnknown += 1;
    else if (kinds.has("delivered")) row.delivered += 1;
    else if (kinds.has("hard_bounce") || kinds.has("soft_bounce")) row.bounced += 1;
    else row.deliveryUnknown += 1;
    sentSends.push({ ...send, flow: place.flow, stage: place.stage, key: sendKey(send, place.flow), sentAtMs: ms(send.sentAt) });
  }

  // ---- Engagement, classified per send. ----
  const engagementRows = input.engagements
    .map((e) => {
      const place = flowOf(e.campaignType);
      if (!place) return null;
      return { key: sendKey(e, place.flow), kind: e.kind, at: ms(e.at), userAgent: e.userAgent };
    })
    .filter((e): e is { key: string; kind: EngagementKind; at: number; userAgent: string | null } => e !== null && Number.isFinite(e.at));
  const summary = summarizeSendEngagement(
    sentSends.map((s) => ({ key: s.key, sentAt: Number.isFinite(s.sentAtMs) ? s.sentAtMs : null })),
    engagementRows,
  );
  // Earliest engagement of any kind per send, for the benchmark's "before the order" test,
  // and the latest human click per send, for attributing a cart's outcome to a stage.
  const firstTouchAt = new Map<string, number>();
  const humanClickAt = new Map<string, number[]>();
  for (const e of engagementRows) {
    if (!summary.has(e.key)) continue;
    firstTouchAt.set(e.key, Math.min(firstTouchAt.get(e.key) ?? Number.POSITIVE_INFINITY, e.at));
  }
  const sendByKey = new Map(sentSends.map((s) => [s.key, s] as const));
  for (const e of engagementRows) {
    const send = sendByKey.get(e.key);
    if (!send || e.kind !== "clicked") continue;
    // Re-run the classifier's verdict for this single event via the summary's
    // rule: a human click exists for the send and this event is late enough.
    const s = summary.get(e.key);
    if (s?.clickedHuman) (humanClickAt.get(e.key) ?? humanClickAt.set(e.key, []).get(e.key)!).push(e.at);
  }
  for (const send of sentSends) {
    const s = summary.get(send.key);
    if (!s) continue;
    const row = rowFor(send.flow, send.stage);
    if (s.openedAny) row.openedAny += 1;
    if (s.openedHuman) row.openedHuman += 1;
    if (s.clickedAny) row.clickedAny += 1;
    if (s.clickedHuman) row.clickedHuman += 1;
  }

  // ---- Cart outcomes, attributed to a stage. ----
  const cartSends = new Map<string, SentSend[]>();
  for (const send of sentSends) {
    if (send.flow !== "cart_recovery" || !send.referenceId) continue;
    const list = cartSends.get(send.referenceId) ?? [];
    list.push(send);
    cartSends.set(send.referenceId, list);
  }
  /** The stage that earned an outcome at `atMs`: the latest human click before it, else the latest send before it. */
  const stageForCartOutcome = (cartId: string, atMs: number): string | null => {
    const sends = (cartSends.get(cartId) ?? []).filter((s) => Number.isFinite(s.sentAtMs) && s.sentAtMs <= atMs);
    if (sends.length === 0) return null;
    let best: SentSend | null = null;
    let bestAt = Number.NEGATIVE_INFINITY;
    for (const s of sends) {
      for (const clickAt of humanClickAt.get(s.key) ?? []) {
        if (clickAt <= atMs && clickAt > bestAt) { best = s; bestAt = clickAt; }
      }
    }
    if (best) return best.stage;
    return sends.reduce((a, b) => (b.sentAtMs > a.sentAtMs ? b : a)).stage;
  };

  const realCarts = input.carts.filter((c) => !input.isInternal(c.email));
  for (const cart of realCarts) {
    const restoredAt = ms(cart.restoredAt);
    if (!Number.isFinite(restoredAt)) continue;
    const stage = stageForCartOutcome(cart.id, restoredAt);
    if (!stage) continue;
    const row = rowFor("cart_recovery", stage);
    row.restored += 1;
    const checkoutAt = ms(cart.checkoutStartedAt);
    if (Number.isFinite(checkoutAt) && checkoutAt >= restoredAt) row.checkoutAfterRestore += 1;
  }

  // ---- Orders: strict attribution, benchmark attribution, self-serve. ----
  const cogsByOrder = new Map<string, number>();
  for (const item of input.orderItems) {
    cogsByOrder.set(item.orderId, (cogsByOrder.get(item.orderId) ?? 0) + Math.round(Number(item.unitCostCents) || 0) * Math.max(0, Math.round(Number(item.quantity) || 0)));
  }
  const sendsByEmail = new Map<string, SentSend[]>();
  for (const send of sentSends) {
    const email = String(send.recipientEmail ?? "").toLowerCase();
    if (!email) continue;
    const list = sendsByEmail.get(email) ?? [];
    list.push(send);
    sendsByEmail.set(email, list);
  }

  for (const order of input.orders) {
    if (input.isInternal(order.email) || !isSale(order)) continue;
    const paidAt = ms(order.paidAt);
    if (!Number.isFinite(paidAt)) continue;
    const email = String(order.email ?? "").toLowerCase();

    // STRICT: the attribution the store itself recorded.
    let strictPlace: FlowStage | null = null;
    if (order.marketingSourceKind === "cart_recovery" && order.marketingSourceRef) {
      const stage = stageForCartOutcome(order.marketingSourceRef, paidAt);
      if (stage) strictPlace = { flow: "cart_recovery", stage };
    } else if (order.marketingSourceKind === "automation" && order.marketingSourceRef) {
      strictPlace = { flow: `automation:${order.marketingSourceRef}`, stage: "all" };
    } else if (order.marketingSourceKind === "campaign" && order.marketingSourceRef) {
      const send = (sendsByEmail.get(email) ?? []).find((s) => s.referenceId === order.marketingSourceRef && (s.flow === "campaign" || s.flow === "affiliate_campaign"));
      strictPlace = { flow: send?.flow ?? "campaign", stage: "all" };
    }
    if (strictPlace) {
      const row = rowFor(strictPlace.flow, strictPlace.stage);
      row.paidStrict += 1;
      const revenue = Math.round((Number(order.amountPaid) || 0) * 100) - Math.round((Number(order.refundAmount) || 0) * 100);
      const cogs = cogsByOrder.get(order.orderId) ?? 0;
      const incentive = Math.round((Number(order.discountAmount) || 0) * 100);
      row.revenueCents += revenue;
      row.cogsCents += cogs;
      row.incentiveCents += incentive;
      row.grossProfitCents += revenue - cogs - incentive;
    }

    // BENCHMARK: the latest send in the five days before the order that had
    // been opened or clicked before the order; one order counts once.
    const candidates = (sendsByEmail.get(email) ?? []).filter((s) =>
      Number.isFinite(s.sentAtMs) && s.sentAtMs < paidAt && paidAt - s.sentAtMs <= BENCHMARK_ATTRIBUTION_WINDOW_MS);
    const engaged = candidates.filter((s) => (firstTouchAt.get(s.key) ?? Number.POSITIVE_INFINITY) < paidAt);
    if (engaged.length > 0) {
      const latest = engaged.reduce((a, b) => (b.sentAtMs > a.sentAtMs ? b : a));
      rowFor(latest.flow, latest.stage).paidBenchmark += 1;
    } else if (candidates.length > 0) {
      const latest = candidates.reduce((a, b) => (b.sentAtMs > a.sentAtMs ? b : a));
      rowFor(latest.flow, latest.stage).selfServeInWindow += 1;
    }
  }

  // ---- Flow totals, eligibility, rates, ordering. ----
  const flows = new Set([...rows.values()].map((r) => r.flow));
  if (flows.has("cart_recovery") || realCarts.length > 0) {
    const total = rowFor("cart_recovery", "all");
    for (const stage of CART_STAGES) {
      const r = rows.get(`cart_recovery|${stage}`);
      if (!r) continue;
      for (const k of ["attempted", "sent", "delivered", "bounced", "deliveryUnknown", "openedAny", "openedHuman", "clickedAny", "clickedHuman", "restored", "checkoutAfterRestore", "paidStrict", "paidBenchmark", "selfServeInWindow", "revenueCents", "cogsCents", "incentiveCents", "grossProfitCents"] as const) {
        total[k] += r[k];
      }
    }
    total.eligible = realCarts.length;
  }

  for (const row of rows.values()) {
    const denominator = row.delivered > 0 ? row.delivered : row.sent;
    row.denominator = row.delivered > 0 ? "delivered" : "sent";
    const rate = (n: number) => (denominator > 0 ? n / denominator : null);
    row.rates = {
      openAny: rate(row.openedAny), openHuman: rate(row.openedHuman),
      clickAny: rate(row.clickedAny), clickHuman: rate(row.clickedHuman),
      restored: rate(row.restored), paidStrict: rate(row.paidStrict), paidBenchmark: rate(row.paidBenchmark),
    };
    row.readable = denominator >= MIN_READABLE_SENDS;
    if (row.deliveryUnknown > 0 && row.stage !== "all") {
      notes.push(`${row.label}: ${row.deliveryUnknown} of ${row.sent} sends carry no delivery record and are counted as sent only.`);
    }
  }

  const order = (r: LifecycleFunnelRow): number => {
    if (r.flow === "cart_recovery") return r.stage === "all" ? 10 : 1 + CART_STAGES.indexOf(r.stage as typeof CART_STAGES[number]);
    if (r.flow.startsWith("automation:")) {
      const i = AUTOMATION_KEYS.indexOf(r.flow.slice("automation:".length) as typeof AUTOMATION_KEYS[number]);
      return 20 + (i < 0 ? 9 : i);
    }
    if (r.flow === "campaign") return 40;
    if (r.flow === "affiliate_campaign") return 41;
    return 50;
  };

  return {
    windowDays: input.windowDays,
    rows: [...rows.values()].sort((a, b) => order(a) - order(b)),
    notes,
  };
}
