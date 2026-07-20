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
];

export function AdminTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Admin sections" className="vl-panel mx-auto mb-6 max-w-7xl rounded-2xl p-2">
      <ul className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
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
