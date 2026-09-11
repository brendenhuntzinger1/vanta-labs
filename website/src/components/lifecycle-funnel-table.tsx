import type { LifecycleFunnelResult } from "@/lib/email/lifecycle-funnel-report";
import type { LifecycleFunnelRow } from "@/lib/email/lifecycle-funnel";

/**
 * THE FUNNEL, THE WAY THE MONEY IS MADE, FOR AN OPERATOR.
 *
 * Two numbers per engagement cell: the human count first, the raw count in
 * muted text. Two numbers per order cell: strict first, benchmark-style beside
 * it. The floor and target on the cart rows are Klaviyo's published
 * abandoned-cart figures, per delivered email; "too few to read" appears until
 * a row has enough delivered sends for its rate to mean anything.
 */

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const pct = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);

function benchmarkLine(row: LifecycleFunnelRow): string | null {
  if (!row.benchmark) return null;
  const b = row.benchmark;
  return `floor: open ${pct(b.floor.openAny)}, click ${pct(b.floor.clickAny)}, order ${pct(b.floor.placedOrder)} · target: click ${pct(b.target.clickAny)}, order ${pct(b.target.placedOrder)}`;
}

export function LifecycleFunnelTable({ report, title = "Lifecycle funnel" }: { report: LifecycleFunnelResult; title?: string }) {
  return (
    <section className="vl-panel rounded-2xl p-5 sm:p-6" data-testid="lifecycle-funnel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <p className="text-[11px] text-zinc-500">last {report.windowDays} days · real customers only · rates per delivered send where delivery is known</p>
      </div>
      {!report.ok ? (
        <p className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
          Funnel unavailable: {report.error ?? "a reporting query failed."}
        </p>
      ) : report.rows.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-400">No lifecycle sends in this window.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
              <tr>
                <th className="pb-2 pr-3">Flow</th>
                <th className="pb-2 pr-3">Eligible</th>
                <th className="pb-2 pr-3">Sent</th>
                <th className="pb-2 pr-3">Delivered</th>
                <th className="pb-2 pr-3">Bounced</th>
                <th className="pb-2 pr-3">Open<br /><span className="normal-case tracking-normal text-zinc-600">human · any</span></th>
                <th className="pb-2 pr-3">Click<br /><span className="normal-case tracking-normal text-zinc-600">human · any</span></th>
                <th className="pb-2 pr-3">Restored</th>
                <th className="pb-2 pr-3">Checkout</th>
                <th className="pb-2 pr-3">Paid<br /><span className="normal-case tracking-normal text-zinc-600">strict · 5-day</span></th>
                <th className="pb-2 pr-3">Self-serve</th>
                <th className="pb-2 pr-3">Revenue</th>
                <th className="pb-2 pr-3">Gross profit</th>
                <th className="pb-2">Read?</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-zinc-200">
              {report.rows.map((row) => {
                const total = row.stage === "all";
                return (
                  <tr key={`${row.flow}|${row.stage}`} className={total ? "bg-white/[0.03] font-medium" : ""} data-flow={row.flow} data-stage={row.stage}>
                    <td className="py-2 pr-3">
                      <div>{row.label}</div>
                      {benchmarkLine(row) && total ? <div className="mt-0.5 text-[10px] text-zinc-500">{benchmarkLine(row)}</div> : null}
                    </td>
                    <td className="py-2 pr-3">{row.eligible === null ? "—" : row.eligible}</td>
                    <td className="py-2 pr-3">{row.sent}{row.attempted > row.sent ? <span className="text-zinc-500"> / {row.attempted} tried</span> : null}</td>
                    <td className="py-2 pr-3">{row.delivered}{row.deliveryUnknown > 0 ? <span className="text-zinc-500"> (+{row.deliveryUnknown} unknown)</span> : null}</td>
                    <td className="py-2 pr-3">{row.bounced}</td>
                    <td className="py-2 pr-3">{row.openedHuman} <span className="text-zinc-500">· {row.openedAny}</span><div className="text-[10px] text-zinc-500">{pct(row.rates.openHuman)} · {pct(row.rates.openAny)}</div></td>
                    <td className="py-2 pr-3">{row.clickedHuman} <span className="text-zinc-500">· {row.clickedAny}</span><div className="text-[10px] text-zinc-500">{pct(row.rates.clickHuman)} · {pct(row.rates.clickAny)}</div></td>
                    <td className="py-2 pr-3">{row.flow === "cart_recovery" ? row.restored : "—"}</td>
                    <td className="py-2 pr-3">{row.flow === "cart_recovery" ? row.checkoutAfterRestore : "—"}</td>
                    <td className="py-2 pr-3">{row.paidStrict} <span className="text-zinc-500">· {row.paidBenchmark}</span><div className="text-[10px] text-zinc-500">{pct(row.rates.paidStrict)} · {pct(row.rates.paidBenchmark)}</div></td>
                    <td className="py-2 pr-3">{row.selfServeInWindow}</td>
                    <td className="py-2 pr-3">{money(row.revenueCents)}</td>
                    <td className="py-2 pr-3">{money(row.grossProfitCents)}<div className="text-[10px] text-zinc-500">cogs {money(row.cogsCents)} · incentives {money(row.incentiveCents)}</div></td>
                    <td className="py-2">{row.readable ? "yes" : <span className="text-zinc-500">too few ({row.denominator})</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {report.notes.length > 0 ? (
        <ul className="mt-3 space-y-1 text-[11px] text-zinc-500">
          {report.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      ) : null}
      <p className="mt-3 text-[11px] text-zinc-500">
        Human opens and clicks exclude fetches inside the first minute (opens) or ten seconds (clicks) after the send and known link scanners. Strict paid orders are those the store itself credited to the send; the 5-day figure is the industry definition (any open or click, then an order within five days) and is shown only so published benchmarks can be compared. Self-serve orders came within five days of a send nobody opened.
      </p>
    </section>
  );
}
