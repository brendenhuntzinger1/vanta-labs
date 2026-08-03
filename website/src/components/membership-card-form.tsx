"use client";

// Membership card capture — Basis Theory hosted fields.
//
// Ported from Evo's components/membership/MembershipCardForm.jsx (live), which
// is the same lane Refined runs. Structure preserved; three deliberate changes
// are called out below.
//
// SAQ-A: the PAN / MM-YY / CVC live ONLY inside the js.basistheory.com iframe.
// This component never reads them, this origin never receives them, and nothing
// card-shaped is ever logged. We hold a token intent id and non-PAN metadata
// (brand, last4) — nothing else. No Stripe.js anywhere on the customer surface.
//
// CHANGES vs the Evo original:
//  1. AMEX is refused BEFORE tokenize, not after. Evo checks post-tokenize,
//     which vaults the card and then rejects it — the card is stored for a
//     signup that can never succeed. AMEX is hard-blocked on the recurring lane
//     because rebills carry no CVC and AMEX card-not-present hard-declines
//     without one: an AMEX member would sign up cleanly and then fail every
//     renewal silently.
//  2. TypeScript + App Router (Evo is pages-router JS).
//  3. The BT public key and the session are fetched from ONE authenticated
//     endpoint (/api/membership/card-config) rather than two calls.

import { useCallback, useMemo, useRef, useState } from "react";
import {
  BasisTheoryProvider,
  CardElement,
  useBasisTheory,
} from "@basis-theory/basis-theory-react";

// Curated BIN list. Visa / Mastercard first — BT resolves a multi-match card to
// the FIRST entry. AMEX is present so a 15-digit entry still validates and
// reports `complete`, which lets us show a clear "we can't accept Amex for
// memberships" message instead of leaving the form mysteriously incomplete.
// `patterns` is (number | [number, number])[] — a RANGE tuple, not a plain
// array. Written explicitly so the two-element literals stay tuples instead of
// widening to number[].
type CardTypeSpec = {
  niceType: string;
  type: string;
  patterns: (number | [number, number])[];
  gaps: number[];
  lengths: number[];
  code: { name: string; size: number };
};

const CARD_TYPES: CardTypeSpec[] = [
  { niceType: "Visa", type: "visa", patterns: [4], gaps: [4, 8, 12], lengths: [16, 18, 19], code: { name: "CVV", size: 3 } },
  { niceType: "Mastercard", type: "mastercard", patterns: [[51, 55], [2221, 2229], [223, 229], [23, 26], [270, 271], 2720], gaps: [4, 8, 12], lengths: [16], code: { name: "CVC", size: 3 } },
  { niceType: "American Express", type: "american-express", patterns: [34, 37], gaps: [4, 10], lengths: [15], code: { name: "CID", size: 4 } },
  { niceType: "Discover", type: "discover", patterns: [6011, [644, 649], 65], gaps: [4, 8, 12], lengths: [16, 19], code: { name: "CID", size: 3 } },
];

const TOKEN_INTENT_RE =
  /^(ti_[a-zA-Z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Consent copy version recorded with the subscription. Bump when the copy changes. */
export const MEMBERSHIP_CONSENT_VERSION = "vanta-membership-v1";

function isAmex(brand: unknown): boolean {
  const b = String(brand ?? "").toLowerCase().replace(/[\s_-]/g, "");
  return b === "amex" || b === "americanexpress";
}

export interface MembershipCardConfig {
  sessionId: string;
  apiKey: string;
  amountCents: number;
  tierName: string;
  billingCycle: "monthly" | "annual";
}

interface Props {
  tierId: string;
  config: MembershipCardConfig;
  onSuccess: () => void;
}

export default function MembershipCardForm({ tierId, config, onSuccess }: Props) {
  const { bt } = useBasisTheory(config.apiKey, { elements: true });
  if (!bt) {
    return <p className="text-sm opacity-70">Loading secure card entry…</p>;
  }
  return (
    <BasisTheoryProvider bt={bt}>
      <CardFormInner tierId={tierId} config={config} onSuccess={onSuccess} />
    </BasisTheoryProvider>
  );
}

function CardFormInner({ tierId, config, onSuccess }: Props) {
  const { bt } = useBasisTheory();
  // The element is reached by REF, not bt.getElement(id). getElement resolves by
  // element id and returns something that is not a usable tokenization target
  // here — tokenIntents.create() then throws and the shopper sees a generic
  // "couldn't process that card" on every card. Evo's live form uses a ref;
  // match it exactly.
  const cardRef = useRef<unknown>(null);
  const [cardBrand, setCardBrand] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amexBlocked = isAmex(cardBrand);

  const priceLabel = useMemo(
    () => `$${(config.amountCents / 100).toFixed(2)}/${config.billingCycle === "annual" ? "year" : "month"}`,
    [config.amountCents, config.billingCycle],
  );

  const handleChange = useCallback((e: { complete?: boolean; cardBrand?: string; brand?: string }) => {
    setComplete(Boolean(e?.complete));
    setCardBrand(e?.cardBrand ?? e?.brand ?? null);
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    if (busy) return;

    // CHANGE 1 — refuse AMEX BEFORE tokenizing, so the card is never vaulted
    // for a signup that cannot succeed.
    if (amexBlocked) {
      setError("American Express can't be used for memberships. Please use Visa, Mastercard or Discover.");
      return;
    }
    if (!complete) {
      setError("Please finish entering your card details.");
      return;
    }
    if (!agreed) {
      setError("Please agree to the recurring billing terms to continue.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const cardEl = cardRef.current;
      if (!bt || !cardEl) {
        setError("Could not read the card form. Please refresh and try again.");
        return;
      }

      // The ONLY place card data is used, and it never leaves the BT iframe —
      // we receive an opaque token intent id back, nothing card-shaped.
      //
      // The cast bridges a gap in BT's own TS types, not a real mismatch:
      // `CreateTokenIntent.data` is typed as a plain DataObject, but the hosted-
      // fields flow passes the Element INSTANCE (the SDK reads the PAN inside
      // its own iframe). This is the exact call Evo runs in production.
      let intent: { id?: string } | undefined;
      try {
        intent = (await bt.tokenIntents.create({
          type: "card",
          data: cardEl,
        } as unknown as Parameters<typeof bt.tokenIntents.create>[0])) as { id?: string };
      } catch {
        // Split from the outer catch so a tokenize failure reads differently
        // from a downstream one — they need different shopper actions.
        setError("We couldn't process that card. Please check the details and try again.");
        return;
      }

      const tokenIntentId = intent?.id;
      if (typeof tokenIntentId !== "string" || !TOKEN_INTENT_RE.test(tokenIntentId)) {
        setError("We couldn't process that card. Please try another card.");
        return;
      }

      const res = await fetch("/api/membership/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tierId,
          billingCycle: config.billingCycle,
          agreedToTerms: true,
          tokenIntentId,
          consentTextVersion: MEMBERSHIP_CONSENT_VERSION,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };

      if (!res.ok || !data.success) {
        setError(data.error || "We couldn't complete that payment. Please try another card.");
        return;
      }

      onSuccess();
    } catch {
      // Never surface a raw error — it can carry gateway detail we don't put in
      // front of a customer on a masked storefront.
      setError("We couldn't process that card. Please try another card.");
    } finally {
      setBusy(false);
    }
  }, [busy, amexBlocked, complete, agreed, bt, tierId, config.billingCycle, onSuccess]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-white/15 bg-black/30 p-3">
        <CardElement
          id="membership-card"
          ref={cardRef as never}
          cardTypes={CARD_TYPES}
          inputMode="numeric"
          validateOnChange
          onChange={handleChange}
          style={{
            base: {
              color: "#f4f4f4",
              fontSize: "16px",
              "::placeholder": { color: "rgba(244,244,244,0.45)" },
            },
          }}
        />
      </div>

      {amexBlocked && (
        <p className="text-sm text-amber-300">
          American Express can&apos;t be used for memberships. Please use Visa, Mastercard or Discover.
        </p>
      )}

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-1"
        />
        <span>
          I authorise Vanta Labs to charge this card {priceLabel} on a recurring basis until I cancel.
          I can cancel any time from my account.
        </span>
      </label>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={busy || !complete || !agreed || amexBlocked}
        className="w-full rounded-md bg-white px-4 py-3 text-sm font-semibold text-black disabled:opacity-40"
      >
        {busy ? "Processing…" : `Start membership — ${priceLabel}`}
      </button>

      <p className="text-xs opacity-60">
        Your card details are entered directly into our payment provider&apos;s secure fields and are
        never stored on this site.
      </p>
    </div>
  );
}
