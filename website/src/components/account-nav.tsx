"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

const TABS = [
  { href: "/account", label: "Orders" },
  { href: "/account/addresses", label: "Addresses" },
  { href: "/account/wishlist", label: "Wishlist" },
  { href: "/account/settings", label: "Settings" },
];

export function AccountNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await fetch("/api/auth/session", { method: "DELETE" });
    } finally {
      router.push("/");
      router.refresh();
    }
  };

  return (
    <nav aria-label="Account sections" className="vl-panel mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl p-2">
      <ul className="flex flex-wrap gap-2">
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                className={active
                  ? "block rounded-xl border border-cyan-300/40 bg-cyan-400/15 px-4 py-2.5 text-sm font-semibold text-cyan-100"
                  : "block rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-300 transition hover:border-white/25 hover:text-white"}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={signingOut}
        className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-60"
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </nav>
  );
}
