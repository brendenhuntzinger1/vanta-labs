"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCart } from "@/components/cart-context";
import { SiteHeaderV2 } from "@/components/site-header-v2";

function CartRestoreInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { restoreItems, restoreCoupon } = useCart();
  const [message, setMessage] = useState("Restoring your cart...");
  // A RECONCILIATION NOTICE STOPS THE AUTOMATIC HOP TO /cart.
  //
  // A clean restore still goes straight through — that is every restore where
  // nothing changed. But when a line could not be added back, redirecting in
  // silence means a shopper who clicked "your cart is saved" arrives at a cart
  // that is missing something, with no explanation, which reads as the store
  // having lost their order. Saying what went, and letting them continue on
  // their own click, is the difference between an apology and a mystery.
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const restoreFromUrl = async () => {
      const id = searchParams.get("id");
      if (!id) {
        setMessage("This cart link is missing its cart id.");
        return;
      }
      // The recovery grant, when the click redirect carried it here rather than
      // as a cookie. It is handed to the endpoint once, exchanged there for an
      // httpOnly cookie, and then removed from the address bar so it does not
      // sit in history or travel in a link the shopper shares.
      const grant = searchParams.get("k");

      try {
        const response = await fetch(
          `/api/cart/restore?id=${encodeURIComponent(id)}${grant ? `&k=${encodeURIComponent(grant)}` : ""}`,
          { cache: "no-store" },
        );
        if (grant && typeof window !== "undefined") {
          const clean = new URL(window.location.href);
          clean.searchParams.delete("k");
          window.history.replaceState(null, "", clean.toString());
        }
        const result = await response.json() as {
          success: boolean;
          items?: Array<{ slug: string; variantId?: string; name: string; quantity: number; unitPrice: number; image?: string }>;
          sessionId?: string | null;
          email?: string;
          notice?: string;
          coupon?: { code: string; discountType: "percent" | "fixed"; discountValue: number };
          error?: string;
        };

        if (!result.success || !result.items) {
          setMessage(result.error ?? "This cart link is no longer valid.");
          return;
        }

        // Continue the cart's own session, so the tracker updates this cart
        // rather than opening a second one for the same shopper.
        restoreItems(result.items, { sessionId: result.sessionId ?? null });
        // The recovery code the email promised, already validated server-side
        // against the address it is bound to; the checkout validates it again.
        if (result.coupon && result.email) restoreCoupon({ ...result.coupon, email: result.email });
        if (result.notice) {
          setNotice(result.notice);
          setMessage("");
          return;
        }
        router.push("/cart");
      } catch {
        setMessage("Unable to restore this cart right now.");
      }
    };

    restoreFromUrl();
    // Only needs to run once, on mount, against the id in the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      <main className="mx-auto max-w-xl px-6 py-32 text-center">
        <p className="vl2-eyebrow">Cart Recovery</p>
        {message ? <p className="mt-4 text-white/70">{message}</p> : null}
        {notice ? (
          <>
            <p className="mt-4 text-white/70">{notice}</p>
            <button
              type="button"
              onClick={() => router.push("/cart")}
              className="vl-btn-primary mt-8 inline-flex px-6 py-3 text-sm"
            >
              Continue to my cart
            </button>
          </>
        ) : null}
      </main>
    </div>
  );
}

export default function CartRestorePage() {
  return (
    // CartRestoreInner reads useSearchParams, so THIS is what is server
    // rendered. A `null` fallback shipped an empty body, which dropped the
    // footer to the top of the viewport until hydration and then shoved it back
    // down — measured layout shift of 1.00 on a phone. Reserving the same
    // column the page occupies keeps it still.
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#0b0b0b] text-white">
          <main className="mx-auto max-w-xl px-6 py-32 text-center" aria-hidden="true">
            <p className="vl2-eyebrow">Cart Recovery</p>
            <p className="mt-4 text-white/70">Restoring your cart…</p>
          </main>
        </div>
      }
    >
      <CartRestoreInner />
    </Suspense>
  );
}
