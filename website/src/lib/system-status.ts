import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { isCheckoutOpen, isMockPaymentMode } from "@/lib/payment-provider";
import { getEmailAdminSettings } from "@/lib/email/settings";
import { getShippoStatus } from "@/lib/shippo/config";
import { getSalesTaxSettings } from "@/lib/admin-control";

// Owner-facing integration health. NEVER exposes secrets — only whether each
// integration is configured/reachable and a plain-English detail. Powers the
// /admin/status screen so the owner can see at a glance what's live vs pending.
export type StatusLevel = "ok" | "warn" | "not_configured" | "error";

export interface IntegrationStatus {
  key: string;
  label: string;
  level: StatusLevel;
  detail: string;
  // True = the store cannot safely take & fulfill a real order without this.
  blocksLaunch: boolean;
}

function safeMockMode(): boolean {
  try {
    return isMockPaymentMode();
  } catch {
    // resolvePaymentProviderName throws on a mock-in-prod misconfig; treat as
    // "not mock" for status purposes (the misconfig surfaces at checkout).
    return false;
  }
}

export async function getSystemStatus(): Promise<IntegrationStatus[]> {
  const out: IntegrationStatus[] = [];

  // Database reachability (same cheap probe as /api/health).
  let dbOk = false;
  try {
    const { error } = await supabaseAdmin.from("products").select("id").limit(1);
    dbOk = !error;
  } catch {
    dbOk = false;
  }
  out.push({
    key: "database",
    label: "Database (Supabase)",
    level: dbOk ? "ok" : "error",
    detail: dbOk ? "Reachable" : "Unreachable — the store cannot operate",
    blocksLaunch: true,
  });

  // Payments / checkout.
  const checkoutOpen = isCheckoutOpen();
  const mock = safeMockMode();
  out.push({
    key: "checkout",
    label: "Payments / Checkout",
    level: checkoutOpen ? (mock ? "warn" : "ok") : "not_configured",
    detail: checkoutOpen
      ? (mock ? "OPEN in TEST (mock) mode — not charging real cards" : "Open — accepting live orders")
      : "Closed — connect a payment processor, then set CHECKOUT_ENABLED=true",
    blocksLaunch: true,
  });

  // Store (transactional commerce) email.
  let emailReady = false;
  try {
    emailReady = (await getEmailAdminSettings()).ready;
  } catch {
    emailReady = false;
  }
  out.push({
    key: "email",
    label: "Store email (orders, shipping, refunds)",
    level: emailReady ? "ok" : "not_configured",
    detail: emailReady ? "Configured & ready" : "Not configured — receipts and shipping emails won't send",
    blocksLaunch: true,
  });

  // Membership billing.
  //
  // Recurring memberships run through the Veyra subscription lane (card captured
  // via Basis Theory, then Veyra owns every renewal) — see veyra-membership.ts.
  // That lane authenticates with VEYRA_SECRET_KEY / PAYMENT_SECRET_KEY, NOT the
  // legacy BILLING_PROVIDER flag, so checking BILLING_PROVIDER reported
  // "Not set up" even with recurring fully wired. Check the real credential.
  const veyraKey = (process.env.VEYRA_SECRET_KEY || process.env.PAYMENT_SECRET_KEY || "").trim();
  const legacyBilling = (process.env.BILLING_PROVIDER ?? "noop").trim().toLowerCase();
  const recurringConfigured = veyraKey.length > 0;
  const legacyConfigured = legacyBilling !== "" && legacyBilling !== "noop";
  const billingConfigured = recurringConfigured || legacyConfigured;
  out.push({
    key: "billing",
    label: "Membership billing",
    level: billingConfigured ? "ok" : "not_configured",
    detail: recurringConfigured
      ? "Recurring subscriptions live via Veyra — card captured at signup, renewals billed automatically"
      : legacyConfigured
        ? `Provider: ${legacyBilling}`
        : "Not configured — monthly memberships can't charge yet (annual works via the order flow)",
    blocksLaunch: false,
  });

  // Shipping labels (Shippo). Orders are fulfilled in-house, so this reports
  // whether labels can be bought — never whether an outside warehouse is
  // reachable. The token's prefix is the ONLY thing read from it; the value
  // itself is never surfaced.
  const shippo = getShippoStatus();
  out.push({
    key: "shipping_labels",
    label: "Shipping labels (Shippo)",
    level: shippo.configured ? (shippo.mode === "live" ? "ok" : "warn") : "not_configured",
    detail: shippo.configured
      ? shippo.mode === "live"
        ? "Live mode — label purchases charge real postage"
        : "TEST mode — labels are simulated and carry no real postage"
      : "SHIPPO_API_TOKEN not set — rates and labels are unavailable",
    blocksLaunch: false,
  });

  // Scheduled jobs (cron) — CRON_SECRET presence is our proxy for "armed".
  const cronConfigured = Boolean((process.env.CRON_SECRET ?? "").trim());
  out.push({
    key: "cron",
    label: "Scheduled jobs (renewals, cart recovery, expiry)",
    level: cronConfigured ? "ok" : "error",
    detail: cronConfigured
      ? "CRON_SECRET set — timer armed"
      : "CRON_SECRET missing — scheduled jobs won't run. Abandoned-checkout inventory holds would never expire, permanently locking stock.",
    // Launch-blocking: expireStaleReservations() runs only from the cron sweep.
    // Without it, every abandoned/failed checkout's 15-min hold never releases,
    // silently removing scarce stock from sale.
    blocksLaunch: true,
  });

  // Sales tax — dynamic, from the shipping address. Collected only for the
  // admin-configured nexus states; an empty list means NO tax is collected
  // anywhere, which is worth an amber nudge (correct for a brand-new store,
  // but the owner should confirm their home state is registered + checked).
  let nexusStates: string[] = [];
  try {
    nexusStates = (await getSalesTaxSettings()).nexusStates;
  } catch {
    nexusStates = [];
  }
  out.push({
    key: "tax",
    label: "Sales tax",
    level: nexusStates.length > 0 ? "ok" : "warn",
    detail: nexusStates.length > 0
      ? `Collecting for ${nexusStates.join(", ")} at destination-state rates (address-based)`
      : "No nexus states configured — no sales tax is being collected. Set your registered state(s) in Control Center → Sales Tax.",
    blocksLaunch: false,
  });

  // Inventory tracking coverage (oversell protection).
  let tracked = 0;
  let total = 0;
  try {
    // Both sides exclude archived products. This measures oversell protection
    // across the SELLABLE catalogue; counting soft-deleted predecessors in the
    // denominator understates coverage against products nobody can buy.
    const [{ count: t }, { count: n }] = await Promise.all([
      supabaseAdmin
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("track_inventory", true)
        .eq("is_archived", false),
      supabaseAdmin
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("is_archived", false),
    ]);
    tracked = t ?? 0;
    total = n ?? 0;
  } catch {
    // leave zeros
  }
  out.push({
    key: "inventory",
    label: "Inventory tracking (oversell protection)",
    level: tracked > 0 ? "ok" : "warn",
    detail: `${tracked} of ${total} products stock-tracked`,
    blocksLaunch: false,
  });

  // Supabase Auth SMTP can't be introspected from the server.
  out.push({
    key: "auth_email",
    label: "Login emails (password reset / verification)",
    level: "warn",
    detail: "Configured in Supabase — verify with a live password-reset test (can't be auto-checked here)",
    blocksLaunch: false,
  });

  return out;
}
