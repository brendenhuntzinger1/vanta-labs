"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useCart } from "@/components/cart-context";
import { APPLE_PAY_VERSION, useApplePayOffered } from "@/components/use-apple-pay-offered";
import {
  EXPRESS_CHECKOUT_ENABLED,
  isApplePlatform,
  isRegisteredApplePayHost,
} from "@/lib/express-checkout";
import type { ComplianceAcknowledgements } from "@/lib/express-wallet";
import { readAttributionForCheckout } from "@/lib/attribution-client";

// -------------------------------------------------------------------------
// Native Apple Pay express checkout for the mini-cart.
//
// The sheet runs on this page, at the top level — no iframe, no postMessage.
// The payment processor is three things and nothing else here: the amount
// authority, the shipping/tax lock, and the charge rail.
//
// Card data never touches this origin. The browser posts Apple's encrypted
// PKPaymentToken straight to the tokenization provider with a PUBLIC key, and
// only the resulting token id is sent to our server.
//
// Every money figure the sheet displays comes VERBATIM from a server response.
// Nothing in this file computes a total.
// -------------------------------------------------------------------------

const BT_API = "https://api.basistheory.com";

/** Written on SUCCESS ONLY. Writing it on any completion would lock a declined
 *  shopper out for the whole window with no way to retry. */
const PAID_LOCK_KEY = "vl_express_paid";
const PAID_LOCK_WINDOW_MS = 20 * 60 * 1000;

/** Sessions expire at 15 minutes server-side; re-mint well before that. */
const SESSION_STALE_MS = 10 * 60 * 1000;

// Minimal structural types for the PassKit API — there is no ambient d.ts for
// it in this project and pulling one in for four call sites isn't worth it.
interface ApplePayLineItem {
  label: string;
  amount: string;
  type?: "final" | "pending";
}
interface ApplePayShippingMethod {
  label: string;
  detail: string;
  amount: string;
  identifier: string;
}
interface ApplePayContact {
  givenName?: string;
  familyName?: string;
  emailAddress?: string;
  phoneNumber?: string;
  addressLines?: string[];
  locality?: string;
  administrativeArea?: string;
  postalCode?: string;
  countryCode?: string;
}
interface ApplePaySessionLike {
  begin(): void;
  abort(): void;
  completeMerchantValidation(session: unknown): void;
  completeShippingContactSelection(update: {
    errors?: unknown[];
    newShippingMethods: ApplePayShippingMethod[];
    newTotal: ApplePayLineItem;
    newLineItems: ApplePayLineItem[];
  }): void;
  completeShippingMethodSelection(update: { newTotal: ApplePayLineItem; newLineItems: ApplePayLineItem[] }): void;
  completePayment(status: number): void;
  onvalidatemerchant: ((event: { validationURL: string }) => void) | null;
  onshippingcontactselected: ((event: { shippingContact: ApplePayContact }) => void) | null;
  onshippingmethodselected: ((event: { shippingMethod: ApplePayShippingMethod }) => void) | null;
  onpaymentauthorized: ((event: { payment: { token: unknown; shippingContact?: ApplePayContact; billingContact?: ApplePayContact } }) => void) | null;
  oncancel: (() => void) | null;
}
interface ApplePaySessionConstructor {
  new (version: number, request: Record<string, unknown>): ApplePaySessionLike;
  canMakePayments(): boolean;
  supportsVersion(version: number): boolean;
  STATUS_SUCCESS: number;
  STATUS_FAILURE: number;
}
type ApplePayErrorConstructor = new (code: string, contactField?: string, message?: string) => unknown;

declare global {
  interface Window {
    ApplePaySession?: ApplePaySessionConstructor;
    ApplePayError?: ApplePayErrorConstructor;
  }
}

interface ServerLineItem {
  label: string;
  amountCents: number;
}
interface SessionResponse {
  available: boolean;
  reason?: string;
  sessionId?: string;
  amountCents?: number;
  orderNumber?: string;
  lineItems?: ServerLineItem[];
}
interface ConfigResponse {
  basis_theory?: { public_api_key?: string };
  wallets?: { merchant_name?: string; apple_pay_enabled?: boolean };
  currency?: string;
}
interface RatesResponse {
  shipping_methods?: Array<{ id: string; label?: string; detail?: string; amount_cents?: number }>;
  tax_amount_cents?: number;
  error?: string;
}


const money = (cents: number) => (cents / 100).toFixed(2);


/** Apple rejects a negative lineItem amount, so a credit is shown as one. */
const toSheetLineItem = (item: ServerLineItem): ApplePayLineItem => ({
  label: item.label,
  amount: money(item.amountCents),
  type: "final",
});

export interface ExpressApplePayButtonProps {
  /** EVERY required confirmation ticked. Nothing server-side happens before
   *  this is true — the compliance gate is also the session-mint gate. */
  acknowledged: boolean;
  /** The shared shape, so the wallet lane cannot fall behind the card lane when
   *  a statement is added. The server re-checks it either way. */
  acknowledgements: ComplianceAcknowledgements;
  onUnavailable?: () => void;
}

// Apple only draws its button when it sees the prefixed appearance value, and
// the CSS minifier collapses `-webkit-appearance` into `appearance`, dropping
// it. Setting it inline puts it beyond the minifier's reach. Typed loosely
// because `-apple-pay-button` is not in the CSSProperties value union.
const APPLE_PAY_APPEARANCE = { WebkitAppearance: "-apple-pay-button" } as React.CSSProperties;

export function ExpressApplePayButton({ acknowledged, acknowledgements, onUnavailable }: ExpressApplePayButtonProps) {
  const router = useRouter();
  const { items, referralCode, couponCode, shippingProtectionEnabled, closeCart } = useCart();

  const [session, setSession] = useState<SessionResponse | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [warming, setWarming] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState(false);
  const [error, setError] = useState("");

  // Guards two distinct duplicate windows: an in-flight authorize, and a stale
  // PassKit callback arriving after we've already succeeded.
  const submittingRef = useRef(false);
  const paidRef = useRef(false);
  // Shipping/tax as the AMOUNT AUTHORITY returned them, carried across
  // callbacks so authorize sends back exactly what was displayed.
  const lockedRef = useRef<{ methodId: string | null; shippingCents: number; taxCents: number }>({
    methodId: null,
    shippingCents: 0,
    taxCents: 0,
  });
  const abortRef = useRef<AbortController | null>(null);
  const mintedAtRef = useRef(0);

  // Cart identity — any change to it invalidates the armed amount.
  const cartKey = useMemo(
    () =>
      JSON.stringify({
        items: items.map((item) => [item.variantId ? `${item.slug}::${item.variantId}` : item.slug, item.quantity]),
        referralCode: referralCode ?? "",
        couponCode: couponCode ?? "",
        shippingProtectionEnabled,
      }),
    [items, referralCode, couponCode, shippingProtectionEnabled],
  );

  // Platform gate. Read through useSyncExternalStore so it is false during SSR
  // and resolved on the client without a cascading render.
  //
  // The Apple-platform test is a USER-AGENT test, not `window.ApplePaySession`
  // — Apple's own SDK makes that (and canMakePayments()) truthy on desktop
  // Chrome, which renders an express section that can never complete. The host
  // check matters just as much: native Apple Pay validates the exact serving
  // host, and an unregistered one fails merchant validation with an opaque
  // error on a page that otherwise looks fine.
  const platformOk = useApplePayOffered();

  useEffect(() => {
    if (!platformOk) onUnavailable?.();
  }, [platformOk, onUnavailable]);

  // Warm the connections the sheet will need the moment it opens.
  useEffect(() => {
    if (!platformOk) return;
    for (const href of [BT_API, "https://applepay.cdn-apple.com"]) {
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = href;
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
  }, [platformOk]);

  const mintSession = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setWarming(true);
    setError("");
    try {
      const response = await fetch("/api/checkout/express/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          items: items.map((item) => ({
            id: item.variantId ? `${item.slug}::${item.variantId}` : item.slug,
            quantity: item.quantity,
          })),
          referralCode: referralCode ?? undefined,
          couponCode: couponCode ?? undefined,
          shippingProtection: shippingProtectionEnabled,
          acknowledgements,
        }),
      });
      const data = (await response.json()) as SessionResponse;
      if (controller.signal.aborted) return;
      if (!data.available || !data.sessionId || typeof data.amountCents !== "number") {
        setSession(null);
        onUnavailable?.();
        return;
      }
      mintedAtRef.current = Date.now();
      setSession(data);

      const configResponse = await fetch(`/api/checkout/express/config?session_id=${encodeURIComponent(data.sessionId)}`, {
        signal: controller.signal,
      });
      const configData = (await configResponse.json()) as ConfigResponse;
      if (controller.signal.aborted) return;
      if (!configResponse.ok || !configData?.basis_theory?.public_api_key || !configData.wallets?.apple_pay_enabled) {
        setConfig(null);
        onUnavailable?.();
        return;
      }
      setConfig(configData);
    } catch (mintError) {
      if ((mintError as { name?: string })?.name === "AbortError") return;
      setSession(null);
      setConfig(null);
      onUnavailable?.();
    } finally {
      if (!controller.signal.aborted) setWarming(false);
    }
  }, [items, referralCode, couponCode, shippingProtectionEnabled, acknowledgements, onUnavailable]);

  // Re-mint on every input change. sessionId AND amountCents are dropped
  // SYNCHRONOUSLY first: leaving either behind while a new session is in flight
  // is how a wallet sheet ends up authorizing one amount and charging another.
  useEffect(() => {
    if (!platformOk || !acknowledged || paidRef.current) return;
    setSession(null);
    setConfig(null);
    const timer = window.setTimeout(() => {
      void mintSession();
    }, 300);
    return () => {
      window.clearTimeout(timer);
      abortRef.current?.abort();
    };
    // mintSession changes with the same inputs cartKey encodes; depending on
    // cartKey keeps this to one re-mint per real change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platformOk, acknowledged, cartKey]);

  // A session left sitting (tab backgrounded, phone locked) goes stale and its
  // rate/pay calls start 409-ing. Re-arm on return.
  useEffect(() => {
    if (!platformOk || !acknowledged) return;
    const refresh = () => {
      if (paidRef.current || submittingRef.current) return;
      if (document.visibilityState !== "visible") return;
      if (mintedAtRef.current && Date.now() - mintedAtRef.current < SESSION_STALE_MS) return;
      void mintSession();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [platformOk, acknowledged, mintSession]);

  const startPayment = useCallback(() => {
    const ApplePaySession = window.ApplePaySession;
    if (!ApplePaySession || !session?.sessionId || typeof session.amountCents !== "number") return;
    const btKey = config?.basis_theory?.public_api_key;
    if (!btKey) return;

    // Client-side double-pay lock. Best-effort — never blocks a legitimate
    // charge if storage is unavailable.
    try {
      const raw = window.localStorage.getItem(PAID_LOCK_KEY);
      if (raw) {
        const lock = JSON.parse(raw) as { ts?: number; orderId?: string };
        if (lock?.ts && Date.now() - lock.ts < PAID_LOCK_WINDOW_MS && lock.orderId) {
          setError("That order has already been placed.");
          return;
        }
      }
    } catch {
      // Unreadable lock is not a reason to refuse a real payment.
    }

    const sessionId = session.sessionId;
    const amountCents = session.amountCents;
    const serverLineItems = session.lineItems ?? [];
    const merchantName = config?.wallets?.merchant_name || "Secure Checkout";
    const currency = (config?.currency || "usd").toUpperCase();

    setError("");
    lockedRef.current = { methodId: null, shippingCents: 0, taxCents: 0 };

    // The opening sheet. `A` is NOT the charge — A + shipping + tax is — so the
    // total and the shipping/tax rows open as 'pending'. A hard 'final' total
    // with no shipping/tax rows would show the shopper a number that then
    // silently grows. They flip to 'final' only once the amount authority has
    // answered with real numbers.
    //
    // The constructor throws (InvalidAccessError on an unsupported version, and
    // on a malformed request dictionary), so `paying` is NOT set until it has
    // returned — setting it first left the button stuck reading "Confirming…"
    // forever, with no error and no way back short of reopening the drawer.
    let created: ApplePaySessionLike | null = null;
    try {
      created = new ApplePaySession(APPLE_PAY_VERSION, {
        // Merchant country, not the shopper's destination.
        countryCode: "US",
        currencyCode: currency,
        merchantCapabilities: ["supports3DS", "supportsCredit", "supportsDebit"],
        // AMEX is excluded: on a descriptor-masked account it lands without a
        // billing-of-record address and issuers hard-decline. AMEX-only wallet
        // users fall through to the card form.
        supportedNetworks: ["visa", "masterCard", "discover"],
        requiredShippingContactFields: ["postalAddress", "name", "email", "phone"],
        // 'email' here is mandatory: without it iOS leaves billingContact email
        // empty, the charge reaches the processor with no cardholder identity,
        // and issuers decline. billingContact is the authoritative identity;
        // shippingContact is a best-effort fallback (Apple strips its email on
        // some iOS versions).
        requiredBillingContactFields: ["name", "email"],
        total: { label: merchantName, type: "pending", amount: money(amountCents) },
        lineItems: [
          ...serverLineItems.map(toSheetLineItem),
          { label: "Shipping", amount: "0.00", type: "pending" },
          { label: "Sales tax", amount: "0.00", type: "pending" },
        ],
      });
    } catch {
      setError("Apple Pay isn't available on this device. Please use the card form.");
      return;
    }
    const appleSession = created;
    setPaying(true);

    const failSheet = (message: string) => {
      setError(message);
      setPaying(false);
      try {
        appleSession.completePayment(ApplePaySession.STATUS_FAILURE);
      } catch {
        // Sheet already closed.
      }
    };

    appleSession.onvalidatemerchant = async (event) => {
      try {
        const response = await fetch(`${BT_API}/apple-pay/session`, {
          method: "POST",
          headers: { "BT-API-KEY": btKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            validation_url: event.validationURL,
            display_name: merchantName,
            domain: window.location.hostname,
          }),
        });
        if (!response.ok) {
          setError("Apple Pay could not be verified for this site.");
          appleSession.abort();
          setPaying(false);
          return;
        }
        appleSession.completeMerchantValidation(await response.json());
      } catch {
        setError("Apple Pay could not be verified for this site.");
        appleSession.abort();
        setPaying(false);
      }
    };

    appleSession.onshippingcontactselected = async (event) => {
      const contact = event.shippingContact ?? {};
      const invalid = (message: string) => {
        lockedRef.current = { methodId: null, shippingCents: 0, taxCents: 0 };
        const ApplePayError = window.ApplePayError;
        appleSession.completeShippingContactSelection({
          errors: ApplePayError ? [new ApplePayError("shippingContactInvalid", "postalAddress", message)] : [],
          newShippingMethods: [],
          newTotal: { label: merchantName, amount: money(amountCents), type: "pending" },
          newLineItems: [
            ...serverLineItems.map(toSheetLineItem),
            { label: "Shipping", amount: "0.00", type: "pending" },
            { label: "Sales tax", amount: "0.00", type: "pending" },
          ],
        });
      };

      let rates: RatesResponse | null = null;
      let ok = false;
      try {
        const response = await fetch("/api/checkout/express/shipping-rates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionId,
            contact: {
              postal_code: contact.postalCode ?? "",
              state: contact.administrativeArea ?? "",
              city: contact.locality ?? "",
              country: contact.countryCode ?? "",
            },
          }),
        });
        ok = response.ok;
        rates = (await response.json()) as RatesResponse;
      } catch {
        rates = null;
      }

      const methods = rates?.shipping_methods ?? [];
      // Refuse the processor's fail-open placeholder BEFORE it can render. Its
      // presence means our shipping/tax lock never completed, so its cache
      // holds either nothing or the previous address's numbers — and the row
      // itself carries the processor's branding onto our sheet. Authorize
      // refuses the same id server-side; the literal is repeated here rather
      // than imported because express-wallet.ts is node-only.
      const hasFallback = methods.some((method) => method.id === "veyra_fallback_free");
      if (!ok || rates?.error || hasFallback || methods.length === 0) {
        invalid(rates?.error || "We can't ship to that address.");
        return;
      }

      // Built ONLY from this response body — the same bytes the amount
      // authority cached and will charge against.
      const method = methods[0];
      const shippingCents = Number(method.amount_cents ?? 0);
      const taxCents = Number(rates?.tax_amount_cents ?? 0);
      lockedRef.current = { methodId: method.id, shippingCents, taxCents };

      appleSession.completeShippingContactSelection({
        newShippingMethods: methods.map((entry) => ({
          label: entry.label ?? "Standard Shipping",
          detail: entry.detail ?? "",
          amount: money(Number(entry.amount_cents ?? 0)),
          identifier: entry.id,
        })),
        newTotal: {
          label: merchantName,
          amount: money(amountCents + shippingCents + taxCents),
          type: "final",
        },
        newLineItems: [
          ...serverLineItems.map(toSheetLineItem),
          { label: "Shipping", amount: money(shippingCents), type: "final" },
          { label: "Sales tax", amount: money(taxCents), type: "final" },
        ],
      });
    };

    // Only one method is ever offered, so this is a formality — but it must
    // still recompute from the numbers already held in the ref, never from the
    // sheet's own strings.
    appleSession.onshippingmethodselected = async () => {
      const { shippingCents, taxCents } = lockedRef.current;
      appleSession.completeShippingMethodSelection({
        newTotal: {
          label: merchantName,
          amount: money(amountCents + shippingCents + taxCents),
          type: "final",
        },
        newLineItems: [
          ...serverLineItems.map(toSheetLineItem),
          { label: "Shipping", amount: money(shippingCents), type: "final" },
          { label: "Sales tax", amount: money(taxCents), type: "final" },
        ],
      });
    };

    appleSession.onpaymentauthorized = async (event) => {
      // A duplicate authorization MUST still be acknowledged with SUCCESS —
      // leaving Apple's sheet unanswered hangs it into a generic failure modal.
      if (submittingRef.current || paidRef.current) {
        try {
          appleSession.completePayment(ApplePaySession.STATUS_SUCCESS);
        } catch {
          // Sheet already closed.
        }
        return;
      }
      submittingRef.current = true;

      // Never authorize a sheet whose total was never upgraded from 'pending'.
      // Without a locked method the shopper would get Face ID followed by a
      // generic decline instead of an addressable message.
      if (!lockedRef.current.methodId) {
        submittingRef.current = false;
        failSheet("We couldn't confirm shipping for that address. Please try again.");
        return;
      }

      const shipping = event.payment.shippingContact ?? {};
      const billing = event.payment.billingContact ?? {};

      try {
        // Encrypted PKPaymentToken goes STRAIGHT to the tokenization provider
        // with a public key. It never touches our origin.
        const tokenResponse = await fetch(`${BT_API}/apple-pay`, {
          method: "POST",
          headers: { "BT-API-KEY": btKey, "Content-Type": "application/json" },
          body: JSON.stringify({ apple_payment_data: event.payment.token }),
        });
        if (!tokenResponse.ok) {
          submittingRef.current = false;
          failSheet("We couldn't process that card. Please try again.");
          return;
        }
        const tokenBody = (await tokenResponse.json()) as { id?: string; apple_pay?: { id?: string } };
        const tokenId = tokenBody?.apple_pay?.id ?? tokenBody?.id;
        if (!tokenId) {
          submittingRef.current = false;
          failSheet("We couldn't process that card. Please try again.");
          return;
        }

        const authorizeResponse = await fetch("/api/checkout/express/authorize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionId,
            basis_theory_token_intent_id: tokenId,
            attribution: readAttributionForCheckout(),
            selected_shipping_method_id: lockedRef.current.methodId,
            wallet_contact: {
              // Billing contact is the cardholder of record; shipping is the
              // fallback Apple populates more reliably.
              first_name: billing.givenName || shipping.givenName || null,
              last_name: billing.familyName || shipping.familyName || null,
              email: billing.emailAddress || shipping.emailAddress || null,
              phone: shipping.phoneNumber || billing.phoneNumber || null,
              address1: shipping.addressLines?.[0] ?? null,
              address2: shipping.addressLines?.[1] ?? null,
              city: shipping.locality ?? null,
              state: shipping.administrativeArea ?? null,
              postal_code: shipping.postalCode ?? null,
              country: shipping.countryCode ?? null,
            },
          }),
        });
        const result = (await authorizeResponse.json()) as {
          ok?: boolean;
          outcome?: string;
          orderId?: string;
          message?: string;
          redirectUrl?: string;
        };

        if (!result.ok) {
          submittingRef.current = false;

          // 3DS continuation. The sheet has no surface for a challenge, so
          // acknowledge it as successful — that closes it cleanly instead of
          // dropping the shopper into Apple's generic failure modal — and then
          // hand them to the hosted challenge page, which completes the charge
          // and fires the webhook. Nothing is paid yet, so NO paid lock is
          // written and the session is not re-minted.
          if (result.outcome === "requires_action" && result.redirectUrl) {
            try {
              appleSession.completePayment(ApplePaySession.STATUS_SUCCESS);
            } catch {
              // Sheet already closed.
            }
            setError("");
            setPaying(false);
            closeCart();
            window.location.assign(result.redirectUrl);
            return;
          }

          failSheet(result.message || "That payment couldn't be completed.");
          // A terminal failure burns the session. Re-arm with a fresh one so
          // the shopper can retry with another card. This is a shopper-initiated
          // retry, not an automatic re-charge.
          //
          // Excluded: the unresolved outcomes (a re-arm invites a second charge
          // on a payment that may have landed) and `duplicate` (the processor
          // has already refused this cart as a repeat of an order placed moments
          // ago, so another tap inside its window can only be refused again).
          if (
            result.outcome !== "requires_action" &&
            result.outcome !== "never_heard_back" &&
            result.outcome !== "duplicate"
          ) {
            void mintSession();
          }
          return;
        }

        paidRef.current = true;
        try {
          window.localStorage.setItem(
            PAID_LOCK_KEY,
            JSON.stringify({ ts: Date.now(), orderId: result.orderId, amountCents }),
          );
        } catch {
          // Storage unavailable — the server-side claims are the real guard.
        }
        appleSession.completePayment(ApplePaySession.STATUS_SUCCESS);
        setError("");
        setPaid(true);
        setPaying(false);
        if (result.orderId) {
          closeCart();
          router.push(`/order-confirmation/${result.orderId}`);
        }
      } catch {
        submittingRef.current = false;
        // We genuinely do not know whether the charge landed, so do NOT tell
        // the shopper it failed in a way that invites a retry.
        failSheet("We're confirming your payment. Please don't try again — you'll get an email shortly.");
      }
    };

    appleSession.oncancel = () => {
      submittingRef.current = false;
      setPaying(false);
    };

    try {
      appleSession.begin();
    } catch {
      // begin() throws on the same conditions the constructor does, plus a
      // non-user-gesture call. Recover the button rather than stranding it.
      setPaying(false);
      setError("Apple Pay couldn't be started. Please try again.");
    }
  }, [session, config, closeCart, router, mintSession]);

  if (!EXPRESS_CHECKOUT_ENABLED || !platformOk) {
    return null;
  }

  // Acknowledgements not yet ticked: no session has been minted (deliberately —
  // the compliance gate is the mint gate), so show the disabled affordance with
  // its reason rather than nothing.
  if (!acknowledged) {
    return (
      <div className="space-y-1.5">
        {/* Apple's own button, dimmed. Rendering a lookalike pill with the words
            "Apple Pay" set in the site's typeface misuses the mark; the supplied
            button dims correctly and stays recognisably Apple's. */}
        <button
          type="button"
          disabled
          aria-label="Buy with Apple Pay"
          className="vl-apple-pay-button"
          style={APPLE_PAY_APPEARANCE}
        />
        <p className="text-center text-[11px] text-zinc-500">
          Confirm the three required statements above to use Apple Pay.
        </p>
      </div>
    );
  }

  // Pixel-identical skeleton while the session warms, so the swap to the real
  // button is invisible rather than a layout jump.
  if (warming || !session?.sessionId || !config?.basis_theory?.public_api_key) {
    if (warming) {
      return <div className="h-[56px] w-full animate-pulse rounded-full bg-white/10" aria-hidden="true" />;
    }
    // Not warming and still no usable session: never render a dead button.
    return null;
  }

  // While a payment is in flight the native button is replaced rather than
  // relabelled: Apple draws its own content, so text placed inside it is never
  // shown and the button would appear frozen with no feedback.
  if (paying || paid) {
    return (
      <div className="space-y-1.5">
        <div
          role="status"
          aria-live="polite"
          className="flex h-[56px] w-full items-center justify-center rounded-full bg-white/25 text-sm font-semibold text-black/60"
        >
          {paid ? "Order placed" : "Confirming…"}
        </div>
        {error ? <p className="text-center text-[11px] text-rose-300">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {/* Apple's own button — the mark, wordmark and typography are drawn by the
          OS. It carries no children on purpose; anything inside is not rendered. */}
      <button
        type="button"
        onClick={startPayment}
        aria-label="Buy with Apple Pay"
        className="vl-apple-pay-button vl-focus-ring"
        style={APPLE_PAY_APPEARANCE}
      />
      {error ? <p className="text-center text-[11px] text-rose-300">{error}</p> : null}
    </div>
  );
}
