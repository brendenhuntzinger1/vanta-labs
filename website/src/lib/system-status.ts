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

/** What a shopper is actually charged per unit: the sale price when one is set,
 *  otherwise the list price. Mirrors the catalogue and the profit report. */
export function effectiveUnitPriceCents(row: {
  price_cents: number | null;
  sale_price_cents: number | null;
}): number {
  return Number(row.sale_price_cents) > 0 ? Number(row.sale_price_cents) : Number(row.price_cents ?? 0);
}

/** A row that carries its own price and cost: a product, or one of its doses. */
export interface SellableUnit {
  price_cents: number | null;
  sale_price_cents: number | null;
  product_cost_cents: number | null;
}

/** A published product, with the dose rows that are actually bought from it. */
export interface DoseBearingProduct extends SellableUnit {
  doses?: SellableUnit[] | null;
}

/**
 * WHAT A SHOPPER CAN ACTUALLY BUY FROM THIS PRODUCT.
 *
 * Cost resolution here MUST mirror resolveUnitCostCents in quote-order.ts, or
 * these checks report on a number no order ever uses:
 *
 *   HAS dose rows → the doses are the units; each carries its own price and
 *                   its own landed cost. The parent's product_cost_cents is an
 *                   inherited EvoLabs seed figure, 1.4x-6.8x the true cost, and
 *                   Phase 2 Section 4 nulls it outright for all 38 of them.
 *   NO dose rows  → the product row IS the unit, and its parent cost is the
 *                   only cost it has (which is exactly the case
 *                   sql/product-cogs.sql sets it for).
 *
 * Reading only the parent column meant that after Section 4 the COGS check
 * warned on every dose-bearing product forever, and — far worse — the
 * below-cost check could NEVER fire again, because it requires cost > 0 and
 * every parent cost was NULL. That check is blocksLaunch and is the only thing
 * in the system that catches a swapped price and cost.
 */
export function sellableUnits<T extends DoseBearingProduct>(row: T): SellableUnit[] {
  return row.doses && row.doses.length > 0 ? row.doses : [row];
}

function isBelowCost(unit: SellableUnit): boolean {
  const cost = Number(unit.product_cost_cents ?? 0);
  const price = effectiveUnitPriceCents(unit);
  return cost > 0 && price > 0 && price <= cost;
}

/**
 * Published products a shopper cannot actually buy.
 *
 * The profit guard in quoteOrder() refuses any order it cannot complete above
 * the floor, and it prices the WHOLE cart — so one line that costs more than it
 * sells for can refuse the entire order, in the card lane and the wallet lane
 * alike. The shopper is told "This order can't be completed at a profitable
 * price", which reads as a site fault rather than a price they can avoid.
 *
 * Compared PER SELLABLE UNIT: a dose is measured against its OWN price, never
 * against the parent's, so a large dose's landed cost is never held up against
 * a small dose's price.
 *
 * Rows with no cost on file are NOT flagged: an unknown cost is the "no COGS"
 * check's business, and guessing here would cry wolf on every unpriced import.
 */
export function findProductsPricedBelowCost<T extends DoseBearingProduct>(rows: T[]): T[] {
  return rows.filter((row) => sellableUnits(row).some(isBelowCost));
}

/** The first unit that sells at or below its cost — for the operator message. */
export function firstBelowCostUnit<T extends DoseBearingProduct>(row: T): SellableUnit | null {
  return sellableUnits(row).find(isBelowCost) ?? null;
}

/**
 * Published products where something buyable has no cost on file.
 *
 * A missing cost does not break a sale, it makes the margin on that sale a
 * guess: resolveUnitCostCents returns null for that line and computeOrderProfit
 * marks the order's COGS as ESTIMATED. So the check is per-unit — one uncosted
 * dose is one product whose profit is partly a guess.
 */
export function findProductsMissingCost<T extends DoseBearingProduct>(rows: T[]): T[] {
  return rows.filter((row) =>
    sellableUnits(row).some((unit) => !(Number(unit.product_cost_cents ?? 0) > 0)));
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
      .select("id, name, slug, price_cents, sale_price_cents, product_cost_cents, track_inventory, inventory_quantity")
      .eq("is_published", true)
      .eq("is_archived", false);

    const rows = (published ?? []) as Array<{
      id: string; name: string | null; slug: string | null;
      price_cents: number | null; sale_price_cents: number | null; product_cost_cents: number | null;
      track_inventory: boolean | null; inventory_quantity: number | null;
    }>;
    const label = (row: { name: string | null; slug: string | null }) => row.name ?? row.slug ?? "unnamed";

    // Stock lives on the DOSE for anything sold by dose, so a parent product
    // can legitimately carry no stock of its own.
    // Price and cost come back with the stock columns because the COGS and
    // margin checks below resolve BOTH from the dose when one exists — see
    // sellableUnits(). One read, three checks.
    type DoseRow = {
      product_id: string;
      track_inventory: boolean | null;
      inventory_quantity: number | null;
      price_cents: number | null;
      sale_price_cents: number | null;
      product_cost_cents: number | null;
    };
    const { data: doseRows } = rows.length > 0
      ? await supabaseAdmin
          .from("product_doses")
          .select("product_id, track_inventory, inventory_quantity, price_cents, sale_price_cents, product_cost_cents")
          .in("product_id", rows.map((row) => row.id))
      : { data: [] };
    const dosesByProduct = new Map<string, DoseRow[]>();
    for (const dose of (doseRows ?? []) as DoseRow[]) {
      const list = dosesByProduct.get(String(dose.product_id)) ?? [];
      list.push(dose);
      dosesByProduct.set(String(dose.product_id), list);
    }
    // The shape the cost checks read: a product plus the units bought from it.
    const priced = rows.map((row) => ({ ...row, doses: dosesByProduct.get(row.id) ?? [] }));

    /**
     * The rule reserve_inventory() actually enforces, mirrored exactly:
     * a row is protected when track_inventory is true OR it carries positive
     * stock. Reading only the flag reported eighteen correctly-protected
     * products as able to oversell.
     */
    const isProtected = (row: { track_inventory: boolean | null; inventory_quantity: number | null }) =>
      row.track_inventory === true || Number(row.inventory_quantity ?? 0) > 0;

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

    // A product is at risk only when NOTHING that can be bought from it is
    // protected: every one of its doses is unprotected, or it has no doses and
    // the product row itself is unprotected.
    const oversellable = rows.filter((row) => {
      const doses = dosesByProduct.get(row.id) ?? [];
      return doses.length > 0
        ? doses.every((dose) => !isProtected(dose))
        : !isProtected(row);
    });
    out.push({
      key: "product_inventory_data",
      label: "Published products have stock numbers",
      level: oversellable.length === 0 ? "ok" : "warn",
      detail: oversellable.length === 0
        ? `All ${rows.length} published products are protected against overselling`
        : `${oversellable.length} published product(s) can oversell: ${oversellable.map(label).join(", ")}. Turn on stock tracking and set a count.`,
      blocksLaunch: false,
    });

    // COGS drives every profit figure. A missing cost does not break a sale, it
    // makes the margin on that sale a guess — the profit report falls back to
    // the worst-case assumption in Control Center.
    const withoutCost = findProductsMissingCost(priced);
    out.push({
      key: "product_cogs",
      label: "Published products have a unit cost (COGS)",
      level: withoutCost.length === 0 ? "ok" : "warn",
      detail: withoutCost.length === 0
        ? `All ${rows.length} published products have a cost on file`
        : `${withoutCost.length} product(s) have no unit cost, so their profit is estimated: ${withoutCost.map(label).join(", ")}.`,
      blocksLaunch: false,
    });

    /**
     * Nothing else catches a below-cost product. "Has a price" passes (there is
     * one) and "has a unit cost" passes (there is one); it is the RELATIONSHIP
     * between them that is wrong — which is exactly what a swapped price and
     * cost looks like, and it silently refuses every cart containing the item.
     */
    const belowCost = findProductsPricedBelowCost(priced);
    out.push({
      key: "product_sellable_margin",
      label: "Published products can be sold at a profit",
      level: belowCost.length === 0 ? "ok" : "error",
      detail: belowCost.length === 0
        ? `All ${rows.length} published products price above their cost`
        : `${belowCost.length} published product(s) cost at least as much as they sell for, so checkout refuses any cart containing them: ${belowCost
            .map((row) => {
              // Report the OFFENDING unit's own figures — a dose when the
              // product sells by dose — so the operator is shown the pair that
              // is actually wrong rather than the parent's unrelated numbers.
              const unit = firstBelowCostUnit(row) ?? row;
              return `${label(row)} (sells ${(effectiveUnitPriceCents(unit) / 100).toFixed(2)}, costs ${(Number(unit.product_cost_cents) / 100).toFixed(2)})`;
            })
            .join(", ")}. Correct the price or the cost — a swapped pair looks exactly like this — or unpublish them.`,
      blocksLaunch: true,
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

  /**
   * Error reporting, checked here because Sentry cannot report that Sentry is
   * down. A DSN that Sentry refuses leaves the server reporting nothing at all,
   * and the only evidence is one line in the platform log that nobody reads.
   * Production has already run a deployment in exactly that state.
   *
   * Prints the host and project id, never the key.
   */
  {
    const { sentryDsnState } = await import("@/lib/sentry-init");
    const { sentryEnvironment, sentryRelease } = await import("@/lib/sentry-privacy");
    const dsn = sentryDsnState();
    const release = sentryRelease();
    const tags = `environment "${sentryEnvironment()}"${release ? `, release ${release.slice(0, 7)}` : ", NO release tag"}`;
    out.push({
      key: "error_reporting",
      label: "Error reporting (Sentry)",
      level: dsn.state === "ok" ? (dsn.browser ? "ok" : "warn") : dsn.state === "missing" ? "not_configured" : "error",
      detail: dsn.state === "ok"
        ? dsn.browser
          ? `Server AND browser reporting to project ${dsn.projectId} at ${dsn.host} — ${tags}`
          : // Stated separately because the failure is silent and reads like
            // health: the server reports, every browser reports nothing, and an
            // empty Sentry looks like an error-free site rather than a blind one.
            `SERVER ONLY — reporting to project ${dsn.projectId} at ${dsn.host} (${tags}), but NEXT_PUBLIC_SENTRY_DSN is unset, so no browser ever reports. Only NEXT_PUBLIC_ variables reach client bundles; SENTRY_DSN alone leaves the browser silent. Set NEXT_PUBLIC_SENTRY_DSN in Vercel and redeploy.`
        : dsn.state === "missing"
          ? "No DSN set, so nothing is reported. Set NEXT_PUBLIC_SENTRY_DSN (and SENTRY_DSN) in Vercel and redeploy."
          : `The configured DSN is unusable (${dsn.reason}) — NOTHING is being reported. Check the DSN value in Vercel: it must be the full https://…@…ingest.…sentry.io/<id> URL, not the variable's name.`,
      blocksLaunch: false,
    });
  }

  return out;
}
