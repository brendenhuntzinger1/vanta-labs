"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import Link from "next/link";
import Image from "next/image";

export type RecentlyViewedItem = {
  slug: string;
  name: string;
  price: string;
  image: string;
};

const STORAGE_KEY = "vl_recently_viewed";
const UPDATE_EVENT = "vl:recently-viewed";
const MAX_ITEMS = 8;

function parseStore(raw: string | null): RecentlyViewedItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RecentlyViewedItem =>
        item && typeof item.slug === "string" && typeof item.name === "string",
    );
  } catch {
    return [];
  }
}

// External-store subscription so the rail reflects localStorage without calling
// setState inside an effect. Updates fire on cross-tab "storage" events and on
// our own same-tab UPDATE_EVENT.
function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(UPDATE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(UPDATE_EVENT, callback);
  };
}

function getSnapshot(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function getServerSnapshot(): string {
  return "";
}

// Records the current product in localStorage on view and renders a rail of the
// OTHER recently-viewed products. Purely client-side (no account needed) and
// resilient to disabled/failed storage — it renders nothing then.
export function RecentlyViewed({ current }: { current: RecentlyViewedItem }) {
  const { slug, name, price, image } = current;

  useEffect(() => {
    if (!slug) return;

    const existing = parseStore(getSnapshot());
    const withoutCurrent = existing.filter((item) => item.slug !== slug);
    const next = [{ slug, name, price, image }, ...withoutCurrent].slice(0, MAX_ITEMS);

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event(UPDATE_EVENT));
    } catch {
      // Storage may be unavailable (private mode / quota); the rail is best-effort.
    }
  }, [slug, name, price, image]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const others = useMemo(
    () => parseStore(snapshot).filter((item) => item.slug !== slug).slice(0, MAX_ITEMS - 1),
    [snapshot, slug],
  );

  if (others.length === 0) {
    return null;
  }

  return (
    <section className="mt-16 bg-[#0b0b0b] p-6 sm:p-10" aria-label="Recently viewed products">
      <h2 className="vl2-serif text-xl text-white sm:text-2xl">Recently viewed</h2>
      <div className="mt-5 flex gap-4 overflow-x-auto pb-2">
        {others.map((item) => (
          <Link
            key={item.slug}
            href={`/products/${item.slug}`}
            className="group w-40 shrink-0 border border-white/10 p-3 transition hover:border-white/25"
          >
            <div className="relative aspect-square overflow-hidden bg-white/5">
              <Image
                src={item.image || "/images/vantalabs.png"}
                alt={item.name}
                fill
                sizes="160px"
                className="object-cover transition duration-300 group-hover:scale-105"
              />
            </div>
            <p className="mt-3 line-clamp-2 text-xs text-white/80">{item.name}</p>
            <p className="mt-1 text-xs text-white/50">{item.price}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
