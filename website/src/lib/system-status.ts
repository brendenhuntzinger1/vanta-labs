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

  // ---------------------------------------------------------------- DATA --
  //
  // Everything above answers "is the integration wired up?". These answer "is
  // the DATA the store will trade on actually correct?" — the questions whose
  // wrong answers cost money on day one rather than failing loudly.
  //
  // Nothing here prints a secret or an address. Credentials report only
  // CONFIGURED / MISSING; the ship-from origin reports only CONFIGURED /
  // INCOMPLETE and names the missing FIELDS, never their values.

  // Published products a customer can see but cannot buy. Checkout refuses a
  // non-positive price (quote-order.ts), so each of these is a storefront
  // listing that dead-ends at the cart.
  try {
    const { data: published } = await supabaseAdmin
      .from("products")
      .select("name, slug, price_cents, product_cost_cents, track_inventory, inventory_quantity")
      .eq("is_published", true)
      .eq("is_archived", false);

    const rows = (published ?? []) as Array<{
      name: string | null; slug: string | null;
      price_cents: number | null; product_cost_cents: number | null;
      track_inventory: boolean | null; inventory_quantity: number | null;
    }>;
    const label = (row: { name: string | null; slug: string | null }) => row.name ?? row.slug ?? "unnamed";

    const unpriced = rows.filter((row) => !(Number(row.price_cents ?? 0) > 0));
    out.push({
      key: "product_prices",
      label: "Published products have a price",
      level: unpriced.length === 0 ? "ok" : "error",
      detail: unpriced.length === 0
        ? `All ${rows.length} published products are priced`
        : `${unpriced.length} published product(s) have no price and cannot be bought: ${unpriced.map(label).join(", ")}. Set a price or unpublish them.`,
      blocksLaunch: true,
    });

    const untracked = rows.filter((row) => row.track_inventory !== true);
    const trackedWithoutCount = rows.filter(
      (row) => row.track_inventory === true && row.inventory_quantity == null,
    );
    const inventoryProblems = untracked.length + trackedWithoutCount.length;
    out.push({
      key: "product_inventory_data",
      label: "Published products have stock numbers",
      level: inventoryProblems === 0 ? "ok" : "warn",
      detail: inventoryProblems === 0
        ? `All ${rows.length} published products are stock-tracked with a count`
        : `${inventoryProblems} published product(s) can oversell: ${[...untracked, ...trackedWithoutCount].map(label).join(", ")}. Turn on stock tracking and set a count.`,
      blocksLaunch: false,
    });

    // COGS drives every profit figure. A missing cost does not break a sale, it
    // makes the margin on that sale a guess — the profit report falls back to
    // the worst-case assumption in Control Center.
    const withoutCost = rows.filter((row) => !(Number(row.product_cost_cents ?? 0) > 0));
    out.push({
      key: "product_cogs",
      label: "Published products have a unit cost (COGS)",
      level: withoutCost.length === 0 ? "ok" : "warn",
      detail: withoutCost.length === 0
        ? `All ${rows.length} published products have a cost on file`
        : `${withoutCost.length} product(s) have no unit cost, so their profit is estimated: ${withoutCost.map(label).join(", ")}.`,
      blocksLaunch: false,
    });
  } catch {
    out.push({
      key: "product_prices",
      label: "Published product data",
      level: "warn",
      detail: "Could not be checked — the products table did not answer.",
      blocksLaunch: false,
    });
  }

  // The two shipping addresses. NEITHER value is printed: the ship-from origin
  // is a private address, and this screen is not the place it appears.
  try {
    const { getShippingAddresses } = await import("@/lib/shipping-origin");
    const addresses = await getShippingAddresses();
    out.push({
      key: "shipping_origin",
      label: "Ship-from address (private — never shown to customers)",
      level: addresses.originValidation.isComplete ? "ok" : "error",
      detail: addresses.originValidation.isComplete
        ? "CONFIGURED"
        : `INCOMPLETE — missing ${addresses.originValidation.missing.join(", ")}. Labels cannot be bought without it.`,
      blocksLaunch: true,
    });
    out.push({
      key: "return_address",
      label: "Return address printed on parcels (your business identity)",
      level: addresses.usesSeparateReturn ? "ok" : "error",
      detail: addresses.usesSeparateReturn
        ? "CONFIGURED — set separately from your ship-from address"
        : `INCOMPLETE — ${addresses.blockedReason ?? "not set"}. Shipping is blocked until it is set, so your private address can never be printed by default.`,
      blocksLaunch: true,
    });
  } catch {
    out.push({
      key: "shipping_origin",
      label: "Shipping addresses",
      level: "warn",
      detail: "Could not be checked.",
      blocksLaunch: false,
    });
  }

  // Marketing email must carry a physical postal address to be lawful.
  const postal = (process.env.MARKETING_POSTAL_ADDRESS ?? "").trim();
  out.push({
    key: "marketing_postal",
    label: "Marketing email postal address",
    level: postal ? "ok" : "warn",
    detail: postal
      ? "CONFIGURED"
      : "MISSING — MARKETING_POSTAL_ADDRESS is required in bulk marketing email. Transactional receipts are unaffected.",
    blocksLaunch: false,
  });

  // The Shippo webhook secret is what makes the tracking endpoint trustworthy.
  const shippoWebhook = (process.env.SHIPPO_WEBHOOK_SECRET ?? "").trim();
  out.push({
    key: "shippo_webhook",
    label: "Shippo webhook secret",
    level: shippoWebhook ? "ok" : "error",
    detail: shippoWebhook
      ? "CONFIGURED — tracking updates are authenticated"
      : "MISSING — the tracking webhook fails closed, so orders will never move past label purchased and no shipping or delivery email will send.",
    blocksLaunch: true,
  });

  // The three ambassador rates, as the business logic actually resolves them,
  // with their provenance. Displayed here because "20% because it is stored"
  // and "20% because nothing is stored" are different facts.
  try {
    const { getReferralProgramConfig, getControlSnapshot, isControlCurrentViewAvailable } =
      await import("@/lib/admin-control");
    const [config, snapshot, viewReady] = await Promise.all([
      getReferralProgramConfig(),
      getControlSnapshot("referral"),
      isControlCurrentViewAvailable(),
    ]);
    const stored = snapshot.referral ?? {};
    const provenance = (key: string) => {
      const value = stored[key];
      return value === undefined || value === null || value === "" ? "default" : "saved";
    };
    out.push({
      key: "ambassador_rates",
      label: "Ambassador rates in force",
      level: "ok",
      detail:
        `Personal discount ${config.personalDiscountPercent}% (${provenance("personal_discount_percent")}) · `
        + `customer referral discount ${config.discountPercent}% (${provenance("discount_percent")}) · `
        + `base commission ${config.defaultCommissionPercent}% (${provenance("default_commission_percent")}). `
        + "These three are independent.",
      blocksLaunch: false,
    });
    out.push({
      key: "control_settings_view",
      label: "Settings resolver",
      level: viewReady ? "ok" : "warn",
      detail: viewReady
        ? "Current values resolved in the database — settings history cannot hide a saved value"
        : "Running on the legacy 1,500-row window. Apply src/lib/sql/admin-control-current-view.sql so a long settings history cannot make a saved value read as blank.",
      blocksLaunch: false,
    });
  } catch {
    // A settings read failure is already visible through the sections above.
  }

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
