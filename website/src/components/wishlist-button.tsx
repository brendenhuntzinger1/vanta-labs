"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="M12 20.5s-7.5-4.6-9.8-9.2C.6 7.8 2.3 4.5 5.6 4c2-.3 3.9.6 5 2.2 1.1-1.6 3-2.5 5-2.2 3.3.5 5 3.8 3.4 7.3C19.5 15.9 12 20.5 12 20.5Z" />
    </svg>
  );
}

export function WishlistButton({ slug, initialInWishlist = false, className }: { slug: string; initialInWishlist?: boolean; className?: string }) {
  const router = useRouter();
  const [inWishlist, setInWishlist] = useState(initialInWishlist);
  const [loading, setLoading] = useState(false);

  const handleClick = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (loading) return;

    setLoading(true);
    try {
      const response = await fetch("/api/account/wishlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });

      if (response.status === 401) {
        router.push("/account/login");
        return;
      }

      const result = await response.json() as { success: boolean; inWishlist?: boolean };
      if (result.success) {
        setInWishlist(Boolean(result.inWishlist));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      aria-label={inWishlist ? "Remove from wishlist" : "Save to wishlist"}
      aria-pressed={inWishlist}
      className={`${className ?? "vl-btn-secondary vl-focus-ring inline-flex h-9 w-9 items-center justify-center"} ${inWishlist ? "text-rose-400" : ""}`}
    >
      <HeartIcon filled={inWishlist} />
    </button>
  );
}
