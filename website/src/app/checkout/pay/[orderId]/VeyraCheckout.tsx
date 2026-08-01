"use client";

import { useEffect, useRef, useState } from "react";

// On-site card entry. Veyra's documented integration is "create a session
// server-side and mount the iframe" — the shopper never leaves this domain and
// this page never sees card data; the iframe is served from veyragate.com and
// handles entry, 3DS challenges and wallets itself.
//
// The AUTHORITATIVE paid signal is the signed `payment.succeeded` webhook, not
// anything this component observes. onSuccess here only moves the shopper along;
// if the browser is closed the instant the charge lands, the webhook still
// settles the order.

const SCRIPT_SRC = "https://veyragate.com/v1/checkout.js";
const SCRIPT_ID = "veyra-checkout-js";

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
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);

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
            // The webhook is what actually marks the order paid; this only sends
            // the shopper to their confirmation.
            window.location.assign(event?.return_url || `/order-confirmation/${orderId}`);
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
        setMessage(
          `${err.message} Your card has not been charged. Please refresh, or contact support if this continues.`,
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
  }, [sessionId, orderId]);

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
      {/* Veyra replaces this node's contents with the checkout iframe. */}
      <div ref={containerRef} id="veyra-checkout" className="min-h-[420px] w-full" />
    </div>
  );
}
