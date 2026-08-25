"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// On-site card entry. Veyra's documented integration is "create a session
// server-side and mount the iframe" — the shopper never leaves this domain and
// this page never sees card data; the iframe is served from veyragate.com and
// handles entry, 3DS challenges and wallets itself.
//
// The AUTHORITATIVE paid signal is the signed `payment.succeeded` webhook, not
// anything this component observes. onSuccess here only moves the shopper along;
// if the browser is closed the instant the charge lands, the webhook still
// settles the order.
//
// WHY THERE IS ALSO A POLL
//
// The first real production purchase proved that onSuccess cannot be the only
// way out. The charge succeeded, the webhook settled the order, and the shopper
// sat on the processor's "Processing…" until they refreshed by hand — at which
// point the freshly mounted iframe showed "Payment complete". The order had been
// paid the entire time. The browser simply never learned it, because the single
// path to completion was an event that did not arrive.
//
// So the page now asks our own server the one question that matters — "is this
// order paid?" — from the moment it mounts. That covers the callback never
// firing, the tab being suspended mid-payment (routine on iOS), a dropped
// network, and the shopper reloading after paying. Whichever answer arrives
// first wins; both lead to the same place.

const SCRIPT_SRC = "https://veyragate.com/v1/checkout.js";
const SCRIPT_ID = "secure-card-entry-js";

/** How often to ask our own server whether the order has settled. */
const POLL_MS = 2500;
/**
 * How long the page stays open before it says anything. Not a timeout — the
 * poll continues either way. It exists so a wait can never be an indefinite,
 * unexplained state, which is what makes a customer pay twice.
 *
 * WHY IT IS THIS LONG, AND WHY IT SAYS WHAT IT SAYS
 *
 * This was 25 seconds, and it fired from the moment the component mounted.
 * The second real production order shows what that means. The page mounted at
 * 03:35:27.8; the notice appeared at 03:35:52.8; the payment did not reach our
 * webhook until 03:36:15.1. For twenty-two seconds the shopper was told
 * "still confirming your payment with your bank" while they were, on the
 * evidence, still typing their card number. That is worse than silence: it
 * describes a state the shopper is not in, on the one screen where being
 * confused costs money.
 *
 * The root problem is that we cannot see the moment they press Pay. The card
 * form is a cross-origin iframe and its only outbound signals are onReady,
 * onError, onCancel and an onSuccess that has not fired on either real
 * purchase. So the honest position is that between mount and settlement we do
 * not know whether a payment is in flight, and the copy must be true in both
 * cases — it can reassure, and it can say "don't pay twice", but it must not
 * assert that a charge is being confirmed.
 *
 * Sixty seconds is set against real card entry, not a guess: on the order
 * above, mount to webhook — iframe load, typing, authorisation, dispatch — was
 * 47 seconds in total.
 */
const REASSURE_AFTER_MS = 60_000;

type MountHandle = { destroy?: () => void };

type VeyraGlobal = {
  mount: (
    target: string | HTMLElement,
    options: {
      sessionId: string;
      onReady?: (event: unknown) => void;
      onSuccess?: (event: { return_url?: string; payment_id?: string }) => void;
      onError?: (event: unknown) => void;
      onCancel?: (event: unknown) => void;
    },
  ) => MountHandle;
};

function loadScript(): Promise<VeyraGlobal> {
  return new Promise((resolve, reject) => {
    const existing = (window as unknown as { Veyra?: VeyraGlobal }).Veyra;
    if (existing) {
      resolve(existing);
      return;
    }
    // Reuse the tag if a previous mount already added it, so a remount does not
    // load the script twice.
    let tag = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (!tag) {
      tag = document.createElement("script");
      tag.id = SCRIPT_ID;
      tag.src = SCRIPT_SRC;
      tag.async = true;
      document.head.appendChild(tag);
    }
    const done = () => {
      const g = (window as unknown as { Veyra?: VeyraGlobal }).Veyra;
      if (g) resolve(g);
      else reject(new Error("Veyra checkout script loaded but exposed no global."));
    };
    tag.addEventListener("load", done, { once: true });
    tag.addEventListener("error", () => reject(new Error("Veyra checkout script failed to load.")), {
      once: true,
    });
    if ((tag as HTMLScriptElement & { readyState?: string }).readyState === "complete") done();
  });
}

export default function VeyraCheckout({
  sessionId,
  orderId,
}: {
  sessionId: string;
  orderId: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<MountHandle | null>(null);
  // Navigation happens exactly once, whichever signal gets there first.
  const settledRef = useRef(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [reassure, setReassure] = useState(false);

  const goToConfirmation = useCallback(
    (returnUrl?: string) => {
      if (settledRef.current) return;
      settledRef.current = true;
      window.location.assign(returnUrl || `/order-confirmation/${orderId}`);
    },
    [orderId],
  );

  /**
   * Ask our own server whether the order is paid. Deliberately silent on
   * failure: a dropped request during payment is expected on mobile data and
   * must never produce an error the shopper can misread as a failed charge.
   */
  const checkOrderStatus = useCallback(async () => {
    if (settledRef.current) return;
    try {
      const response = await fetch(`/api/checkout/order-status/${encodeURIComponent(orderId)}`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = (await response.json()) as { paid?: boolean };
      if (data?.paid) goToConfirmation();
    } catch {
      // Keep polling. The next tick may succeed.
    }
  }, [orderId, goToConfirmation]);

  useEffect(() => {
    let cancelled = false;

    loadScript()
      .then((Veyra) => {
        if (cancelled || !containerRef.current) return;
        handleRef.current = Veyra.mount(containerRef.current, {
          sessionId,
          onReady: () => {
            if (!cancelled) setStatus("ready");
          },
          onSuccess: (event) => {
            // The fast path when it works. The poll is what covers it when it
            // does not.
            goToConfirmation(event?.return_url);
          },
          onError: () => {
            if (cancelled) return;
            setStatus("error");
            setMessage(
              "We couldn't load secure card entry. Your card has not been charged — please refresh to try again.",
            );
          },
        });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setStatus("error");
        // NEVER surface err.message — loadScript throws messages naming the
        // payment processor ("… checkout script failed to load"), and a blocked
        // or slow CDN is the common case, so a shopper would be shown a
        // supplier's brand at the moment of payment. The technical detail goes
        // to the console for debugging; the shopper gets Vanta Labs' own words.
        console.error("[checkout] secure card entry failed to load", err);
        setMessage(
          "We couldn't load secure card entry. Your card has not been charged. Please refresh, or contact support if this continues.",
        );
      });

    return () => {
      cancelled = true;
      try {
        handleRef.current?.destroy?.();
      } catch {
        // Unmounting must never throw during navigation.
      }
    };
  }, [sessionId, orderId, goToConfirmation]);

  // The settlement watch, independent of the iframe entirely.
  useEffect(() => {
    // Immediately, because this also catches the shopper who already paid and
    // then reloaded: they must land on their receipt, never on a card form that
    // invites a second payment.
    void checkOrderStatus();

    const poll = window.setInterval(() => void checkOrderStatus(), POLL_MS);
    const reassureTimer = window.setTimeout(() => setReassure(true), REASSURE_AFTER_MS);

    // iOS Safari freezes timers in a backgrounded tab, and a 3DS step or a
    // wallet sheet backgrounds it routinely. Re-ask the moment we are visible
    // again rather than waiting for a timer that was never running.
    const recheck = () => {
      if (document.visibilityState === "visible") void checkOrderStatus();
    };
    document.addEventListener("visibilitychange", recheck);
    // Back/forward restores from the bfcache without remounting React.
    window.addEventListener("pageshow", recheck);

    return () => {
      window.clearInterval(poll);
      window.clearTimeout(reassureTimer);
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("pageshow", recheck);
    };
  }, [checkOrderStatus]);

  return (
    <div className="w-full">
      {status === "loading" && (
        <p className="mb-4 text-sm text-white/60">Loading secure card entry…</p>
      )}
      {status === "error" && (
        <div className="mb-4 border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {message}
        </div>
      )}
      {/* The processor replaces this node's contents with the card iframe.
          The id is intentionally generic — it is visible in page source. */}
      <div ref={containerRef} id="secure-card-entry" className="min-h-[420px] w-full" />
      {reassure && status !== "error" && (
        // Deliberately says nothing about whether a payment is in flight — we
        // cannot see inside the card form, so we do not know. Every clause here
        // is true both for someone still filling the form in and for someone
        // whose charge is mid-authorisation. It never suggests paying again:
        // "try again" is the one instruction that could take money twice.
        <div
          role="status"
          aria-live="polite"
          className="mt-4 border border-white/15 bg-white/[0.03] px-4 py-3 text-sm text-white/70"
        >
          Take your time — this page stays open as long as you need.{" "}
          <strong className="text-white/90">
            If you&rsquo;ve already submitted your card, don&rsquo;t submit it again
          </strong>{" "}
          — we&rsquo;re watching for the payment and will take you straight to your receipt the
          moment it clears.
        </div>
      )}
    </div>
  );
}
