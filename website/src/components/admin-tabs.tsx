"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { EMPTY_WORK_QUEUE, type WorkQueueSummary } from "@/lib/admin-work-queue";
import { ADMIN_NAV_GROUPS, ADMIN_TABS, type AdminTab } from "@/lib/admin-nav-config";

// ---------------------------------------------------------------------------
// ADMIN NAVIGATION.
//
// Twenty-six destinations, which is not itself the problem — Shopify has a
// comparable number once you open Settings. The problem was that they were
// rendered as one flat, unlabelled, uncounted grid:
//
//   * On a 390x844 phone the nav measured 754px — 89% of the first screen.
//     The page <h1> started at y=940 and the Ready-to-Fulfill queue at y=2554,
//     so an operator scrolled three full screens past navigation to reach the
//     first order. Measured in the browser harness, not estimated.
//   * No tab carried a count, so "what needs doing" could not be answered
//     without opening Fulfillment and reading the queue.
//
// Both are fixed here and nowhere else: the destinations are grouped by the
// question they answer, the two that hold work carry live counts, and on small
// screens the whole thing collapses to a single row that names where you are.
// ---------------------------------------------------------------------------

function badgeValue(tab: AdminTab, work: WorkQueueSummary): number {
  if (tab.badge === "work") return work.needsFulfillment;
  if (tab.badge === "critical") return work.openCriticalAlerts;
  return 0;
}

function TabLink({ tab, active, work }: { tab: AdminTab; active: boolean; work: WorkQueueSummary }) {
  const count = badgeValue(tab, work);
  const critical = tab.badge === "critical";

  return (
    <Link
      href={tab.href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-sm transition ${
        active
          ? "border-cyan-300/40 bg-cyan-400/15 font-semibold text-cyan-100"
          : "border-white/10 bg-white/[0.03] text-zinc-300 hover:border-white/25 hover:text-white"
      }`}
    >
      <span className="truncate">{tab.label}</span>
      {count > 0 ? (
        <span
          // The count is the point of the tab, so it is announced, not just drawn.
          aria-label={critical ? `${count} unresolved critical alerts` : `${count} orders waiting`}
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${
            critical ? "bg-rose-400/20 text-rose-200" : "bg-amber-400/20 text-amber-200"
          }`}
        >
          {count > 999 ? "999+" : count}
        </span>
      ) : null}
    </Link>
  );
}

export function AdminTabs({ work = EMPTY_WORK_QUEUE }: { work?: WorkQueueSummary }) {
  const pathname = usePathname();
  // Collapsed on phones and tablets; the desktop layout always shows the full
  // nav, so this state only governs small screens.
  const [open, setOpen] = useState(false);

  const currentLabel =
    ADMIN_TABS.find((tab) => tab.match(pathname))?.label ?? "Admin";

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

      {/*
        Small screens: one row that says where you are and how much work is
        waiting, and opens the full menu on demand. This is what takes the nav
        from 754px of an 844px screen down to a single control.
      */}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="admin-nav-panel"
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 text-sm text-zinc-200 transition hover:border-white/25 lg:hidden"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="text-zinc-500">☰</span>
          <span className="truncate font-semibold text-white">{currentLabel}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {work.totalActionable > 0 ? (
            <span
              aria-label={`${work.totalActionable} items need attention`}
              className="rounded-full bg-amber-400/20 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-amber-200"
            >
              {work.totalActionable > 999 ? "999+" : work.totalActionable}
            </span>
          ) : null}
          <span aria-hidden="true" className="text-zinc-500">{open ? "▲" : "▼"}</span>
        </span>
      </button>

      <div id="admin-nav-panel" className={`${open ? "mt-2 block" : "hidden"} lg:mt-0 lg:block`}>
        <div className="grid gap-3 lg:grid-cols-4 xl:grid-cols-7">
          {ADMIN_NAV_GROUPS.map((group) => (
            <div key={group.title}>
              <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                {group.title}
              </p>
              <ul className="grid gap-1.5">
                {group.tabs.map((tab) => (
                  <li key={tab.href}>
                    <TabLink tab={tab} active={tab.match(pathname)} work={work} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </nav>
  );
}
