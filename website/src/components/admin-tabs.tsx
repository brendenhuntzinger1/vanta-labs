"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type AdminTab = {
  label: string;
  href: string;
  match: (pathname: string) => boolean;
};

const tabs: AdminTab[] = [
  {
    label: "Live Sales & Visitors",
    href: "/admin",
    match: (pathname) => pathname === "/admin",
  },
  {
    label: "Products",
    href: "/admin/products",
    match: (pathname) => pathname.startsWith("/admin/products"),
  },
  {
    label: "Orders",
    href: "/admin/orders",
    match: (pathname) => pathname.startsWith("/admin/orders"),
  },
  {
    label: "Payments",
    href: "/admin/payments",
    match: (pathname) => pathname.startsWith("/admin/payments"),
  },
  {
    label: "Fulfillment",
    href: "/admin/fulfillment",
    match: (pathname) => pathname.startsWith("/admin/fulfillment"),
  },
  {
    label: "3PL Payouts",
    href: "/admin/payouts",
    match: (pathname) => pathname.startsWith("/admin/payouts"),
  },
  {
    label: "Revenue",
    href: "/admin/revenue",
    match: (pathname) => pathname.startsWith("/admin/revenue"),
  },
  {
    label: "Ambassadors",
    href: "/admin/partners",
    match: (pathname) => pathname.startsWith("/admin/partners"),
  },
  {
    label: "Coupons",
    href: "/admin/coupons",
    match: (pathname) => pathname.startsWith("/admin/coupons"),
  },
  {
    label: "Promotions",
    href: "/admin/promotions",
    match: (pathname) => pathname.startsWith("/admin/promotions"),
  },
  {
    label: "Inventory",
    href: "/admin/inventory",
    match: (pathname) => pathname.startsWith("/admin/inventory"),
  },
  {
    label: "Customers",
    href: "/admin/customers",
    match: (pathname) => pathname.startsWith("/admin/customers"),
  },
  {
    label: "Audit Log",
    href: "/admin/audit-log",
    match: (pathname) => pathname.startsWith("/admin/audit-log"),
  },
  {
    label: "Team",
    href: "/admin/team",
    match: (pathname) => pathname.startsWith("/admin/team"),
  },
  {
    label: "Reconciliation",
    href: "/admin/reconciliation",
    match: (pathname) => pathname.startsWith("/admin/reconciliation"),
  },
  {
    label: "Membership",
    href: "/admin/membership",
    match: (pathname) => pathname.startsWith("/admin/membership"),
  },
  {
    label: "Cart Recovery",
    href: "/admin/cart-recovery",
    match: (pathname) => pathname.startsWith("/admin/cart-recovery"),
  },
  {
    label: "Settings",
    href: "/admin/settings",
    match: (pathname) => pathname.startsWith("/admin/settings"),
  },
  {
    label: "Policies",
    href: "/admin/policies",
    match: (pathname) => pathname.startsWith("/admin/policies"),
  },
  {
    label: "Content",
    href: "/admin/content",
    match: (pathname) => pathname.startsWith("/admin/content"),
  },
  {
    label: "My Account",
    href: "/admin/account",
    match: (pathname) => pathname.startsWith("/admin/account"),
  },
];

export function AdminTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Admin sections" className="vl-panel mx-auto mb-6 max-w-7xl rounded-2xl p-2">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <Link
          href="/"
          className="inline-flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:border-white/25 hover:text-white"
        >
          ← Back to Website
        </Link>
        <span className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Admin</span>
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {tabs.map((tab) => {
          const active = tab.match(pathname);

          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                className={active
                  ? "block rounded-xl border border-cyan-300/40 bg-cyan-400/15 px-4 py-3 text-sm font-semibold text-cyan-100"
                  : "block rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-300 transition hover:border-white/25 hover:text-white"}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
