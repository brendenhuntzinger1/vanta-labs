// Veyra recurring-membership client.
//
// ONE call does everything: first charge + card vault + membership row + cron
// enrollment. After it returns, VEYRA owns the renewal schedule.
//
// 🔴 THE RULE THAT MATTERS MOST — never build a storefront-side renewal cron or
// retry for a membership created here. `runMembershipBillingSweep()` must skip
// any subscription carrying a `veyra_membership_id`. If both sides bill, every
// member is charged twice a month: once by Veyra's renewal cron and once by our
// sweep. This is the same double-fire family as the EVO confirm-backfill leak
// (2026-08-01) — a second system acting on rows it does not own.
//
// Field-name traps that have bitten every storefront wired to this lane:
//   - `interval: "annual"`  NOT "yearly"
//   - `postal_code`         NOT "zip"
//   - `exp_month`/`exp_year` NOT "expiration_month"/"expiration_year"
//
// Preconditions on the merchant. ⚠️ BOTH WERE RESOLVED 2026-08-02 — an earlier
// version of this comment listed them as unmet and, being read as current state,
// sent a later session to the wrong conclusion ("recurring billing cannot
// succeed regardless of code"). Re-verified against the live DB 2026-08-02:
//
//   - API key scopes — ✅ RESOLVED. `memberships:read` + `memberships:write`
//     were added to Vanta's live key. (They were genuinely missing at mint,
//     the same gap Refined hit.)
//   - `policy.charge_model` — ✅ WAS NEVER A BLOCKER. It resolves as
//     `merchant.tier_override_charge_model ?? base.charge_model`
//     (veyragate `lib/risk/tier-policy.ts:1320`), and the tier_3 base is already
//     `destination_charge_with_obo` (:837). Vanta is tier_3 with a NULL
//     override, so it already satisfies the gate.
//     ⚠️ Do NOT "fix" this by reading `merchants.stripe_charge_mode` — that is a
//     DIFFERENT column (it reads `destination_charge_without_on_behalf_of`) and
//     confusing the two is what produced the false blocker. Setting
//     `tier_override_charge_model` to force it would also plant an explicit
//     override where inheritance is already correct, which the tier-cascade
//     engine treats differently and surfaces as a collision on any tier change.
//
//   - AMEX is hard-blocked on this lane: rebills are no-CVC and AMEX CNP hard-
//     declines. Reject the brand at the card form, before tokenizing.
//
// If a signup still fails, the cause is NOT merchant config — look at the client
// (tokenize) or the response body from this endpoint.

import { getRequiredEnv } from "@/lib/env";

/** Matches the vg_memberships_interval_check CHECK constraint exactly. */
export type VeyraMembershipInterval = "weekly" | "biweekly" | "monthly" | "annual";

export interface StartVeyraMembershipInput {
  /** Free label; Veyra has no plan→price catalog. Price comes from amountCents. */
  planCode: string;
  /** Authoritative, server-resolved. Never trust a client-supplied price. */
  amountCents: number;
  interval: VeyraMembershipInterval;
  /** Basis Theory token intent from the card capture that just ran. */
  tokenIntentId: string;
  customerEmail: string;
  currency?: string;
  /** Version string for the consent copy shown at signup. */
  consentTextVersion?: string;
  /** "shippable" for physical fulfilment; "digital" otherwise. */
  subscriptionKind?: "digital" | "shippable";
  discountBps?: number;
  /** Stable per-customer namespace so Veyra can dedupe across signups. */
  customerNamespace?: string;
}

export type StartVeyraMembershipResult =
  | { ok: true; membershipId: string; status: string; raw: unknown }
  /**
   * Customer-actionable (declined card, AMEX, etc). Show `message` and let them
   * retry with a different card — do NOT mark the member past-due.
   */
  | { ok: false; kind: "payment_unavailable"; message: string; raw: unknown }
  /**
   * Misconfiguration or transport. The shopper cannot fix this. Surface a
   * generic message, alert an operator, and do NOT create a local membership —
   * a local row with no Veyra membership behind it never renews and reads as an
   * active member who is never billed.
   */
  | { ok: false; kind: "config_error" | "transport_error"; message: string; raw: unknown };

function veyraBase(): string {
  return getRequiredEnv("VEYRA_API_BASE").replace(/\/+$/, "");
}

function veyraSecret(): string {
  // Mirrors payment-provider.ts: accept the documented PAYMENT_SECRET_KEY as a
  // fallback so an operator who set that name still works.
  const key = (process.env.VEYRA_SECRET_KEY || process.env.PAYMENT_SECRET_KEY || "").trim();
  if (!key) {
    throw new Error("Payment provider secret is not configured (set VEYRA_SECRET_KEY or PAYMENT_SECRET_KEY).");
  }
  return key;
}

/**
 * Create a recurring membership at Veyra. Charges the card NOW and enrolls it in
 * Veyra's renewal cron.
 *
 * Never throws — every failure is a typed result so the caller can decide
 * between "let the shopper retry" and "alert an operator", which are different
 * outcomes and must not collapse into one generic error.
 */
export async function startVeyraMembership(
  input: StartVeyraMembershipInput,
): Promise<StartVeyraMembershipResult> {
  let res: Response;
  let bodyText: string;

  try {
    res = await fetch(`${veyraBase()}/api/v1/membership`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${veyraSecret()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        plan_code: input.planCode,
        amount_cents: input.amountCents,
        currency: (input.currency || "usd").toLowerCase(),
        interval: input.interval,
        token_intent_id: input.tokenIntentId,
        customer_email: input.customerEmail,
        subscription_kind: input.subscriptionKind ?? "shippable",
        ...(input.discountBps ? { discount_bps: input.discountBps } : {}),
        ...(input.consentTextVersion ? { consent_text_version: input.consentTextVersion } : {}),
        ...(input.customerNamespace ? { customer_namespace: input.customerNamespace } : {}),
      }),
    });
    bodyText = await res.text();
  } catch (e) {
    // Transport failure. We do NOT know whether the charge landed, so the caller
    // must not create a local membership and must not retry blindly.
    return {
      ok: false,
      kind: "transport_error",
      message: e instanceof Error ? e.message : "Could not reach the payment provider.",
      raw: null,
    };
  }

  let body: Record<string, unknown> = {};
  try {
    body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
  } catch {
    return {
      ok: false,
      kind: "transport_error",
      message: "Unreadable response from the payment provider.",
      raw: bodyText.slice(0, 400),
    };
  }

  if (res.ok) {
    const membershipId =
      (body.id as string | undefined) ?? (body.membership_id as string | undefined);
    if (!membershipId) {
      // 2xx with no id — treat as unresolved rather than success. Creating a
      // local membership here would produce a member who is never renewed.
      return {
        ok: false,
        kind: "transport_error",
        message: "Payment provider returned no membership id.",
        raw: body,
      };
    }
    return {
      ok: true,
      membershipId,
      status: (body.status as string | undefined) ?? "active",
      raw: body,
    };
  }

  // Veyra signals a customer-actionable failure (decline, AMEX, unusable card)
  // as `payment_unavailable`. Everything else is ours to fix, not theirs.
  const code = (body.code as string | undefined) ?? (body.error as string | undefined) ?? "";
  const message =
    (body.message as string | undefined) ??
    (body.error as string | undefined) ??
    `Membership creation failed (HTTP ${res.status}).`;

  if (code === "payment_unavailable" || res.status === 402) {
    return { ok: false, kind: "payment_unavailable", message, raw: body };
  }

  return { ok: false, kind: "config_error", message, raw: body };
}

/**
 * AMEX is hard-blocked on the recurring lane — rebills carry no CVC and AMEX
 * card-not-present hard-declines without one, so an AMEX member would sign up
 * successfully and then silently fail on renewal.
 *
 * Call this at the card form BEFORE tokenizing. Refined's port checks after
 * tokenize, which vaults the card and then rejects it — avoid copying that.
 */
export function isAmexBrand(brand: string | null | undefined): boolean {
  const b = (brand ?? "").toLowerCase().replace(/[\s_-]/g, "");
  return b === "amex" || b === "americanexpress";
}
