"use client";

import { useState } from "react";
import { useCart } from "@/components/cart-context";
import type { Product } from "@/lib/catalog-types";

type ReorderResponse = {
  success: boolean;
  available?: Array<{
    slug: string;
    variantId?: string;
    name: string;
    price: number;
    quantity: number;
    image: string;
    stockStatus: string;
    batchNumber: string;
    sku?: string;
  }>;
  unavailable?: string[];
  error?: string;
};

export function ReorderButton({ orderId }: { orderId: string }) {
  const { addToCart, openCart } = useCart();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleReorder = async () => {
    setLoading(true);
    setMessage(null);

    try {
      const response = await fetch("/api/account/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      });
      const result = await response.json() as ReorderResponse;

      if (!result.success) {
        setMessage(result.error ?? "Unable to reorder.");
        return;
      }

      for (const item of result.available ?? []) {
        const product: Product = {
          slug: item.slug,
          name: item.name,
          category: "",
          price: `$${item.price.toFixed(2)}`,
          stockStatus: item.stockStatus as Product["stockStatus"],
          batchNumber: item.batchNumber,
          description: "",
          image: item.image,
          testingDate: "",
          labName: "",
          coaUrl: "",
        };

        addToCart(product, item.quantity, null, {
          variantId: item.variantId,
          sku: item.sku,
          priceOverride: item.price,
          imageOverride: item.image,
          batchNumberOverride: item.batchNumber,
          stockStatusOverride: item.stockStatus,
        });
      }

      const addedCount = result.available?.length ?? 0;
      const skippedCount = result.unavailable?.length ?? 0;

      if (addedCount > 0) {
        openCart();
      }

      setMessage(
        addedCount > 0
          ? `Added ${addedCount} item${addedCount === 1 ? "" : "s"} to your cart.${skippedCount > 0 ? ` ${skippedCount} item${skippedCount === 1 ? " is" : "s are"} no longer available.` : ""}`
          : "None of the items in this order are available to reorder right now.",
      );
    } catch {
      setMessage("Unable to reorder right now.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleReorder}
        disabled={loading}
        className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-60"
      >
        {loading ? "Adding…" : "Reorder"}
      </button>
      {message ? <p className="mt-2 text-xs text-zinc-400">{message}</p> : null}
    </div>
  );
}
