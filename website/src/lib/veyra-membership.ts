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

// ---------------------------------------------------------------------------
// Lifecycle control — cancel / skip.
//
// 🔴 WHY THIS EXISTS. Veyra owns the billing schedule once a membership is
// created, so a lifecycle change written ONLY to our own table does not stop
// anything. Observed live 2026-08-03: a member was paused on the storefront
// (local status "paused") while the Veyra membership stayed "active" with its
// next charge still booked. Cancel had the identical hole, which is far worse —
// a customer who cancels keeps being charged, every month, indefinitely.
//
// Rule: for any membership carrying a `veyra_membership_id`, tell Veyra FIRST
// and only update local state if Veyra accepted. Local-only is how you charge
// someone who asked you to stop.
// ---------------------------------------------------------------------------

export type VeyraLifecycleResult =
  | {
      ok: true;
      status?: string;
      /**
       * Veyra's NEW next-charge date after the call. Callers MUST write this to
       * their local row — Veyra owns the schedule, so a local date left at its
       * old value silently disagrees with the date the card is actually charged.
       *
       * Observed 2026-08-03: a pause deferred the charge Sep 3 -> Oct 3 at Veyra
       * while the local row still read Sep 2, so every UI and forecast reading
       * it was a month wrong.
       */
      nextRenewalAt?: string | null;
    }
  | { ok: false; message: string };

async function veyraPost(path: string, body: unknown): Promise<VeyraLifecycleResult> {
  try {
    const res = await fetch(`${veyraBase()}/api/v1/membership/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${veyraSecret()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* fall through to the status-based message below */
    }
    if (!res.ok) {
      const message =
        (parsed.message as string | undefined) ??
        (parsed.error as string | undefined) ??
        `Membership update failed (HTTP ${res.status}).`;
      return { ok: false, message };
    }
    return {
      ok: true,
      status: parsed.status as string | undefined,
      nextRenewalAt: (parsed.next_renewal_at as string | null | undefined) ?? null,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Could not reach the payment provider.",
    };
  }
}

/**
 * Stop future billing at Veyra.
 *
 * `atPeriodEnd: true` keeps the member through the period they already paid for
 * and takes no further charge — the correct default for a customer-initiated
 * cancel. `false` ends it immediately.
 */
export function cancelVeyraMembership(
  veyraMembershipId: string,
  atPeriodEnd = true,
): Promise<VeyraLifecycleResult> {
  return veyraPost(`${encodeURIComponent(veyraMembershipId)}/cancel`, {
    at_period_end: atPeriodEnd,
  });
}

/**
 * Push the next charge forward by one cycle. Moves dates only — not a charge,
 * refund or cancel.
 *
 * ⚠️ This is also what a PAUSE maps to, because Veyra has no pause endpoint
 * (verified 2026-08-03: only cancel / skip_cycle / change / card / retention).
 * So a pause defers exactly ONE cycle. A member left paused past that cycle
 * would be charged again. Callers must treat pause as "skip one period", and
 * this should be revisited if Veyra adds real pause support.
 */
export function skipVeyraMembershipCycle(
  veyraMembershipId: string,
  reason?: string,
): Promise<VeyraLifecycleResult> {
  return veyraPost(`${encodeURIComponent(veyraMembershipId)}/skip_cycle`, {
    ...(reason ? { reason: reason.slice(0, 200) } : {}),
  });
}

/**
 * Reprice the subscription Veyra actually bills, on an upgrade or downgrade.
 *
 * 🔴 WHY THIS EXISTS. A tier change used to update tier_id and
 * next_billing_amount_cents in customer_memberships and stop there. Veyra owns
 * the subscription and its amount, so the member's perks switched to the new
 * tier immediately while their card kept being charged the OLD tier's price —
 * an upgrade undercharged forever and a downgrade overcharged forever, and every
 * membership.renewed webhook carried the stale amount.
 *
 * Exactly the same failure shape as the pause, cancel and card-update holes
 * above: local-only state for a subscription somebody else owns. The `change`
 * endpoint was there the whole time (verified 2026-08-03: cancel / skip_cycle /
 * change / card / retention); it simply had no wrapper.
 *
 * The caller must not move the member onto the new tier unless this succeeds.
 */
export function changeVeyraMembershipPlan(
  veyraMembershipId: string,
  input: { amountCents: number; interval?: VeyraMembershipInterval; planCode?: string },
): Promise<VeyraLifecycleResult> {
  return veyraPost(`${encodeURIComponent(veyraMembershipId)}/change`, {
    amount_cents: Math.max(0, Math.round(input.amountCents)),
    ...(input.interval ? { interval: input.interval } : {}),
    ...(input.planCode ? { plan_code: input.planCode } : {}),
  });
}

/**
 * Replace the card Veyra bills for this membership.
 *
 * 🔴 WHY THIS EXISTS. updatePaymentMethod used to write ONLY our local
 * `payment_method_ref` column. For a Veyra-managed membership the card lives at
 * VEYRA — a local write changes nothing, so a past-due member who "updated
 * their card" was still billed against the dead one on every retry and could
 * never recover. Same failure shape as the pause/cancel holes above: local-only
 * state for a subscription somebody else owns.
 *
 * Takes a Basis Theory token intent from a fresh card capture — the PAN never
 * touches this origin, exactly as at signup.
 */
export function updateVeyraMembershipCard(
  veyraMembershipId: string,
  tokenIntentId: string,
): Promise<VeyraLifecycleResult> {
  return veyraPost(`${encodeURIComponent(veyraMembershipId)}/card`, {
    token_intent_id: tokenIntentId,
  });
}
