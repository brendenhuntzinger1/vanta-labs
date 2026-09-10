import type { InventoryWatchlist } from "@/lib/admin-inventory-watchlist";
import type { WatchlistEntry, WatchlistTier } from "@/lib/inventory-watchlist";

// ---------------------------------------------------------------------------
// The reorder watch list. A server component: it renders and nothing else, so
// there is no client bundle, no state and nothing to get out of sync.
//
// Every row states its own reason in plain words (built in
// inventory-watchlist.ts alongside the rule that produced it), because a screen
// that says "Low stock" without saying why leaves the owner to reverse-engineer
// the threshold. One card list at every width: a watch list is short, and two
// layouts would be two things to keep right.
// ---------------------------------------------------------------------------

const TIER_COPY: Record<WatchlistTier, { label: string; pill: string; border: string }> = {
  out: {
    label: "Out of stock",
    pill: "bg-rose-500/15 text-rose-300",
    border: "border-rose-400/30 bg-rose-500/[0.04]",
  },
  "order-now": {
    label: "Order now",
    pill: "bg-amber-400/15 text-amber-300",
    border: "border-amber-400/30 bg-amber-400/[0.03]",
  },
  "order-soon": {
    label: "Order soon",
    pill: "bg-cyan-400/15 text-cyan-200",
    border: "border-white/10 bg-white/[0.02]",
  },
};

function lineName(entry: WatchlistEntry): string {
  return entry.variantLabel ? `${entry.productName} — ${entry.variantLabel}` : entry.productName;
}

function Row({ entry }: { entry: WatchlistEntry }) {
  const tier = TIER_COPY[entry.tier];

  return (
    <li className={`rounded-xl border p-4 ${tier.border}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-[15rem]">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-zinc-100">{lineName(entry)}</p>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tier.pill}`}>{tier.label}</span>
          </div>
          {/* The whole point of the screen: why this line is here, in a sentence. */}
          <p className="mt-1 text-xs text-zinc-400">{entry.reason}</p>
        </div>

        <div className="flex shrink-0 items-center gap-5 text-right">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-zinc-500">Available</p>
            <p className="tabular-nums text-sm text-zinc-200">{entry.available}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-zinc-500">Order</p>
            <p className="tabular-nums text-sm font-semibold text-cyan-200">
              {entry.suggestedOrderQty > 0 ? entry.suggestedOrderQty : "—"}
            </p>
          </div>
        </div>
      </div>
    </li>
  );
}

export function AdminInventoryWatchlist({ watchlist }: { watchlist: InventoryWatchlist }) {
  const { entries, settings, linesConsidered, unitsSoldInWindow } = watchlist;

  const counts = {
    out: entries.filter((entry) => entry.tier === "out").length,
    now: entries.filter((entry) => entry.tier === "order-now").length,
    soon: entries.filter((entry) => entry.tier === "order-soon").length,
  };
  const unitsToOrder = entries.reduce((sum, entry) => sum + entry.suggestedOrderQty, 0);

  return (
    <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white sm:text-xl">Reorder watch list</h2>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">
            Anything running out within {settings.leadTimeDays + settings.coverTargetDays} days, most urgent first.
            Pace comes from the last {settings.salesWindowDays} days of paid orders; lines with no sales fall back to
            their alert level. Suggested quantities cover your {settings.leadTimeDays}-day supplier lead time plus{" "}
            {settings.coverTargetDays} days of stock, minus anything already on order.
          </p>
        </div>
        {entries.length > 0 ? (
          <div className="shrink-0 text-right">
            <p className="text-[10px] uppercase tracking-wide text-zinc-500">Units to order</p>
            <p className="tabular-nums text-2xl font-semibold text-cyan-200">{unitsToOrder}</p>
          </div>
        ) : null}
      </div>

      {entries.length === 0 ? (
        <p className="mt-4 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.04] p-4 text-sm text-emerald-200">
          Nothing needs ordering. All {linesConsidered} lines are either selling slowly enough to last beyond{" "}
          {settings.leadTimeDays + settings.coverTargetDays} days or sitting above their alert level.
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            {counts.out > 0 ? (
              <span className="rounded-full bg-rose-500/15 px-3 py-1 text-rose-300">{counts.out} out of stock</span>
            ) : null}
            {counts.now > 0 ? (
              <span className="rounded-full bg-amber-400/15 px-3 py-1 text-amber-300">{counts.now} to order now</span>
            ) : null}
            {counts.soon > 0 ? (
              <span className="rounded-full bg-cyan-400/15 px-3 py-1 text-cyan-200">{counts.soon} to order soon</span>
            ) : null}
            <span className="rounded-full bg-white/5 px-3 py-1 text-zinc-400">
              {linesConsidered} lines checked
            </span>
          </div>

          <ul className="mt-4 space-y-2">
            {entries.map((entry) => (
              <Row key={entry.key} entry={entry} />
            ))}
          </ul>
        </>
      )}

      {/* Says out loud when the forecast half has little to work with, rather
          than letting a threshold-driven list look like a sales forecast. */}
      {unitsSoldInWindow < 50 ? (
        <p className="mt-4 text-xs text-zinc-500">
          {unitsSoldInWindow === 0
            ? `No units sold in the last ${settings.salesWindowDays} days, so every line above is judged on its alert level alone.`
            : `Only ${unitsSoldInWindow} units sold in the last ${settings.salesWindowDays} days, so most lines are judged on their alert level rather than a sales forecast. The forecast sharpens as orders come in.`}
        </p>
      ) : null}
    </section>
  );
}
