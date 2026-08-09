"use client";

import Link from "next/link";
import Image from "next/image";
import { useMemo, useSyncExternalStore } from "react";
import { resolveProductImage } from "@/lib/product-image";

type RecentlyViewedItem = { slug: string; name: string; price: string; image: string };

const STORAGE_KEY = "vl_recently_viewed";
const UPDATE_EVENT = "vl:recently-viewed";

function parseStore(raw: string): RecentlyViewedItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RecentlyViewedItem => item && typeof item.slug === "string" && typeof item.name === "string",
    );
  } catch {
    return [];
  }
}

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(UPDATE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(UPDATE_EVENT, callback);
  };
}
function getSnapshot() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}
const getServerSnapshot = () => "";

/**
 * Display-only recently-viewed rail for the account dashboard. Reads the same
 * localStorage store the product page writes; records nothing itself. Renders
 * null when the store is empty so the section simply doesn't appear.
 */
export function AccountRecentlyViewed() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const items = useMemo(() => parseStore(snapshot).slice(0, 8), [snapshot]);

  if (items.length === 0) return null;

  return (
    <section className="vl-panel rounded-2xl p-5 sm:p-6">
      <h2 className="text-lg font-semibold text-white">Recently viewed</h2>
      <div className="mt-4 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => (
          <Link
            key={item.slug}
            href={`/products/${item.slug}`}
            className="vl-focus-ring group w-36 shrink-0 snap-start rounded-xl border border-white/10 bg-white/[0.02] p-2.5 transition-colors duration-200 hover:border-white/25"
          >
            <div className="relative aspect-square overflow-hidden rounded-lg bg-white/5">
              <Image
                src={resolveProductImage(item.image)}
                alt={item.name}
                fill
                sizes="144px"
                className="object-cover transition-transform duration-300 group-hover:scale-105"
              />
            </div>
            <p className="mt-2.5 line-clamp-2 text-xs text-white/80">{item.name}</p>
            <p className="mt-1 text-xs text-white/50">{item.price}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
