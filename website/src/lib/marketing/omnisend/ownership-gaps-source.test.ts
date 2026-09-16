import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ordersNeedingOmnisendPaid } from "@/lib/marketing/omnisend/sweeps";

/**
 * THE GAPS THE AUDIT FOUND IN "ONE OWNER OF MARKETING SENDS" (docs/omnisend/AUDIT.md
 * F-02, F-04, F-06, F-12) and the one order hook the first wiring left out.
 *
 *   * F-02: the order backstop must never push orders paid before the
 *     integration went live, or the first tick after the key is set enrols a
 *     week of old orders into post-purchase flows.
 *   * F-04: the birthday sweep keeps granting points but stops MAILING while
 *     Omnisend owns marketing; the frequency guard cannot see Omnisend sends.
 *   * F-06: the admin resend button cannot start a second recovery
 *     conversation for a cart Omnisend owns; a legacy cart (one with an
 *     in-house stage) may still be finished by hand.
 *   * F-12: affiliate campaigns are programme communications, not customer
 *     marketing, and Omnisend has no affiliate audience — they keep sending.
 *   * A processor-initiated full refund or cancel of a paid order tells
 *     Omnisend, exactly as the admin actions do.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

function fn(source: string, header: string): string {
  const start = source.indexOf(header);
  expect(start, `${header} not found`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const next = rest.slice(header.length).search(/\n(?:export )?(?:async )?function |\nexport const |\nconst JOBS/);
  return next === -1 ? rest : rest.slice(0, next + header.length);
}

const SWEEPS = executable(read("src/lib/marketing/omnisend/sweeps.ts"));
const REWARDS = executable(read("src/lib/rewards.ts"));
const RESEND = executable(read("src/lib/admin-cart-recovery.ts"));
const LIFECYCLE = executable(read("src/app/api/cron/lifecycle/route.ts"));
const SEND_ROUTE = executable(read("src/app/api/admin/email/campaigns/[campaignId]/send/route.ts"));
const CAMPAIGNS = executable(read("src/lib/email/campaign-sender.ts"));
const WEBHOOK = executable(read("src/lib/payment-webhook.ts"));

const CHECK = "marketingSendBlockedByOmnisend(";

describe("F-02: the order backstop has a floor", () => {
  const order = (id: string, paidAt: string) => ({
    order_id: id,
    payment_status: "paid",
    order_type: "product",
    replacement_of: null,
    paid_at: paidAt,
    created_at: paidAt,
  });
  const now = new Date("2026-09-16T12:00:00Z");

  it("excludes orders paid before the floor even when they are inside the lookback", () => {
    const rows = [order("old", "2026-09-15T12:00:00Z"), order("new", "2026-09-16T11:00:00Z")];
    const floor = Date.parse("2026-09-16T00:00:00Z");
    expect(ordersNeedingOmnisendPaid(rows, [], now, floor).map((row) => row.order_id)).toEqual(["new"]);
  });

  it("keeps the lookback rule without a floor", () => {
    const rows = [order("old", "2026-09-15T12:00:00Z"), order("stale", "2026-09-01T12:00:00Z")];
    expect(ordersNeedingOmnisendPaid(rows, [], now).map((row) => row.order_id)).toEqual(["old"]);
  });

  it("records the floor in omnisend_sync_state on the first run and reads it on every later one", () => {
    const backstop = fn(SWEEPS, "export async function omnisendOrderBackstop(");
    expect(SWEEPS).toContain('const ORDER_BACKSTOP_KEY = "order_backstop";');
    expect(backstop).toContain("readSyncState<BackstopFloorRecord>(ORDER_BACKSTOP_KEY, LOG)");
    expect(backstop).toContain("writeSyncState(ORDER_BACKSTOP_KEY, { since:");
    expect(backstop).toMatch(/ordersNeedingOmnisendPaid\(rows, ledgerRows, now, floor\)/);
    // The floor is read after the gate and before the order read.
    const gate = backstop.indexOf("omnisendActive()");
    const floor = backstop.indexOf("readSyncState<BackstopFloorRecord>");
    const orders = backstop.indexOf('from("orders")');
    expect(gate).toBeLessThan(floor);
    expect(floor).toBeLessThan(orders);
  });
});

describe("F-04: the birthday sweep banks the points and stands the email down", () => {
  it("consults the switch after the grant and before sendMarketingEmail", () => {
    const sweep = fn(REWARDS, "export async function runBirthdayBonusSweep(");
    expect(REWARDS).toMatch(/import \{[^}]*marketingSendBlockedByOmnisend[^}]*\} from "@\/lib\/marketing\/omnisend\/ownership";/);
    const grant = sweep.indexOf("recordPointsLedgerEntry(");
    const check = sweep.indexOf(CHECK);
    const mail = sweep.indexOf("sendMarketingEmail(");
    expect(grant).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(grant);
    expect(mail).toBeGreaterThan(check);
    expect(sweep).toContain("emailsStoodDown");
  });
});

describe("F-06: the admin resend refuses a cart Omnisend owns", () => {
  it("refuses after the cart is read and before anything is minted or sent, unless the cart has an in-house stage", () => {
    const resend = fn(RESEND, "export async function resendCartRecoveryEmail(");
    expect(RESEND).toMatch(/import \{[^}]*marketingSendBlockedByOmnisend[^}]*\} from "@\/lib\/marketing\/omnisend\/ownership";/);
    const cartRead = resend.indexOf('from("abandoned_carts")');
    const check = resend.indexOf(CHECK);
    const stages = resend.indexOf('from("abandoned_cart_emails")', check);
    const suppressed = resend.indexOf("isMarketingSuppressed(");
    const send = resend.indexOf("sendMarketingEmail(");
    expect(check).toBeGreaterThan(cartRead);
    expect(stages).toBeGreaterThan(check);
    expect(stages).toBeLessThan(suppressed);
    expect(send).toBeGreaterThan(stages);
    expect(resend).toContain("omnisendOwned: true");
    expect(resend).toContain("This cart belongs to Omnisend while OMNISEND_MARKETING_OWNER is set");
  });
});

describe("F-12: affiliate campaigns keep their sender", () => {
  it("the campaign sweep can be limited to affiliate campaigns", () => {
    const sweep = fn(CAMPAIGNS, "export async function runCampaignSweep(");
    expect(sweep).toContain("affiliateOnly?: boolean");
    // Both selects — the due ones and the in-flight ones — take the filter.
    expect(sweep.split('.eq("audience_kind", "affiliate")').length - 1).toBe(2);
  });

  it("the lifecycle job runs affiliate-only rather than standing down fully", () => {
    const start = LIFECYCLE.indexOf("\n  emailCampaigns: {");
    const entry = LIFECYCLE.slice(start, LIFECYCLE.indexOf("\n  },", start));
    expect(entry).toContain(CHECK);
    expect(entry).toContain("runCampaignSweep({ affiliateOnly: true })");
    expect(entry).toContain('mode: "affiliate-only", reason: MARKETING_OWNED_BY_OMNISEND');
    expect(entry).not.toContain("skipped: MARKETING_OWNED_BY_OMNISEND");
  });

  it("the admin send route lets an affiliate campaign through and refuses every other kind", () => {
    const check = SEND_ROUTE.indexOf(CHECK);
    const kindRead = SEND_ROUTE.indexOf('.select("audience_kind")');
    expect(kindRead).toBeGreaterThan(-1);
    expect(kindRead).toBeLessThan(check);
    expect(SEND_ROUTE).toContain('const affiliateCampaign = String(kindRow?.audience_kind ?? "customer") === "affiliate";');
    expect(SEND_ROUTE).toContain("if (!affiliateCampaign && marketingSendBlockedByOmnisend())");
  });
});

describe("processor-initiated reversals reach Omnisend", () => {
  it("a full refund or a cancel of a PAID order fires the matching hook inside the reversal block", () => {
    expect(WEBHOOK).toMatch(/import \{ onOrderCancelled, onOrderPaid, onOrderRefunded \} from "@\/lib\/marketing\/omnisend\/order-hooks";/);
    const wasPaid = WEBHOOK.indexOf('const wasPaid = priorPaymentStatus === "paid" || priorPaymentStatus === "partially_refunded";');
    expect(wasPaid).toBeGreaterThan(-1);
    const block = WEBHOOK.slice(wasPaid, wasPaid + 1500);
    expect(block).toMatch(/if \(wasPaid && nextStatus === "canceled"\) deferOmnisend\("orders", \(\) => onOrderCancelled\(orderId\)\);/);
    expect(block).toMatch(/if \(wasPaid && nextStatus === "refunded" && refundOutcome\.isFullRefund\) deferOmnisend\("orders", \(\) => onOrderRefunded\(orderId\)\);/);
    // Exactly one call each in the whole file (the import carries no paren):
    // never on a failure that was never paid, never for a partial refund.
    expect(WEBHOOK.split("onOrderRefunded(").length - 1).toBe(1);
    expect(WEBHOOK.split("onOrderCancelled(").length - 1).toBe(1);
  });
});
