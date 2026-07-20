"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCart } from "@/components/cart-context";
import { SiteHeaderV2 } from "@/components/site-header-v2";

function CartRestoreInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { restoreItems } = useCart();
  const [message, setMessage] = useState("Restoring your cart...");

  useEffect(() => {
    const restoreFromUrl = async () => {
      const id = searchParams.get("id");
      if (!id) {
        setMessage("This cart link is missing its cart id.");
        return;
      }

      try {
        const response = await fetch(`/api/cart/restore?id=${encodeURIComponent(id)}`, { cache: "no-store" });
        const result = await response.json() as { success: boolean; items?: Array<{ slug: string; variantId?: string; name: string; quantity: number; unitPrice: number; image?: string }>; error?: string };

        if (!result.success || !result.items) {
          setMessage(result.error ?? "This cart link is no longer valid.");
          return;
        }

        restoreItems(result.items);
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
        <p className="mt-4 text-white/70">{message}</p>
      </main>
    </div>
  );
}

export default function CartRestorePage() {
  return (
    <Suspense fallback={null}>
      <CartRestoreInner />
    </Suspense>
  );
}
