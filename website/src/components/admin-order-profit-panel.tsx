import { AdminOrderShippingCostForm } from "@/components/admin-order-shipping-cost-form";

// Server component. The one interactive element -- the manual shipping cost
// entry -- is its own client component, so this panel still does not ship to
// the browser.

export interface OrderProfitView {
  grossRevenue: number;
  merchandiseRevenue: number;
  shippingCharged: number;
  additionalRevenue: number;
  /** Store credit + points redeemed, already deducted from grossRevenue. */
  creditRedeemed: number;
  taxCountedAsProfit: boolean;
  cogs: number;
  shippingCost: number;
  shippingCostIsEstimate: boolean;
  shippingCostSource: string | null;
  shippingProfit: number;
  processingFee: number;
  commission: number;
  refund: number;
  taxCollected: number;
  profit: number;
  /** `null` when revenue is <= 0 — a margin has no meaning there. Renders "n/a". */
  marginPercent: number | null;
  profitStatus: "estimated" | "finalized";
  processingFeeIsEstimate: boolean;
  hasEstimatedCost: boolean;
}

export interface ShippingCostAuditView {
  id: string;
  estimatedCostCents: number | null;
  exactCostCents: number | null;
  differenceCents: number | null;
  source: string;
  finalizedNetProfitCents: number | null;
  createdAt: string;
}

function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function centsMoney(c: number | null): string {
  return c == null ? "—" : money(c / 100);
}

function Line({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-zinc-300">{label}</dt>
      <dd className="tabular-nums text-zinc-100">{money(amount)}</dd>
    </div>
  );
}

function ExpenseRow({ label, amount, muted }: { label: string; amount: number; muted?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-zinc-400">− {label}</dt>
      <dd className={`tabular-nums ${muted ? "text-zinc-400" : "text-rose-300"}`}>{money(-amount)}</dd>
    </div>
  );
}

export function AdminOrderProfitPanel({
  profit,
  audit,
  orderId,
}: {
  profit: OrderProfitView;
  audit: ShippingCostAuditView[];
  /** Needed only by the manual cost form below, which PATCHes this order. */
  orderId: string;
}) {
  const estimated = profit.profitStatus === "estimated";



  return (
    <details open className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-300">Order profit</span>
        <span className="flex items-center gap-2">
          <span className={`tabular-nums text-base font-semibold ${profit.profit >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{money(profit.profit)}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              estimated ? "bg-amber-400/15 text-amber-300" : "bg-emerald-400/15 text-emerald-300"
            }`}
          >
            {estimated ? "Estimated" : "Final"}
          </span>
        </span>
      </summary>

      {/* Flat, in reading order: what came in, what went out, what is left.
          The old layout nested revenue sub-rows under a gross total and put
          shipping profit inside the expense block, which meant working out
          whether an order made money required following an indent. */}
      <dl className="mt-4 space-y-1.5 text-sm">
        <Line label="Merchandise revenue" amount={profit.merchandiseRevenue} />
        {profit.shippingCharged > 0 ? <Line label="Shipping collected" amount={profit.shippingCharged} /> : null}
        {profit.additionalRevenue > 0 ? (
          <Line label="Shipping protection & fees" amount={profit.additionalRevenue} />
        ) : null}
        {/* Non-cash tender. Above the Net profit line, and NEGATIVE, because it
            is a reduction of what was collected rather than a cost that was
            paid out — without it the revenue lines above simply do not add up
            to the total on any order a member settled with credit. */}
        {profit.creditRedeemed > 0 ? (
          <Line label="Store credit & points redeemed" amount={-profit.creditRedeemed} />
        ) : null}

        <div className="!mt-3 border-t border-white/10 pt-2" />

        <ExpenseRow label="Product cost" amount={profit.cogs} />
        {/* Postage is the one expense that is genuinely unknown before the label
            is bought. Saying "Pending label purchase" is honest; showing an
            estimate as though it were the charge is what makes a margin look
            better than it is. */}
        <div className="flex justify-between">
          <dt className="text-zinc-400">− Actual shipping</dt>
          <dd className={`tabular-nums ${profit.shippingCostIsEstimate ? "text-amber-300" : "text-rose-300"}`}>
            {profit.shippingCostIsEstimate ? "Pending label purchase" : money(-profit.shippingCost)}
          </dd>
        </div>
        {/* ALWAYS modelled from the configured rate — Veyra reports no settled
            per-transaction fee back to this application. Saying so on the line
            is the difference between a profit figure the owner can trust and one
            that quietly presents a guess as a bank statement. */}
        <ExpenseRow
          label={profit.processingFeeIsEstimate ? "Payment processing (estimated)" : "Payment processing"}
          amount={profit.processingFee}
        />
        {profit.commission > 0 ? <ExpenseRow label="Ambassador commission" amount={profit.commission} /> : null}
        {profit.refund > 0 ? <ExpenseRow label="Refunds" amount={profit.refund} /> : null}

        <div className="!mt-2 flex justify-between border-t border-white/10 pt-2 text-base font-semibold">
          <dt className={profit.profit >= 0 ? "text-emerald-300" : "text-rose-300"}>Net profit</dt>
          <dd className={`tabular-nums ${profit.profit >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
            {money(profit.profit)}{" "}
            <span className="text-xs font-normal text-zinc-500">
              {/* "0.0%" beside a real dollar loss reads as "broke even", and the
                  arithmetic that would replace it (two negatives divided) reads
                  as a healthy margin. Neither is said. */}
              ({profit.marginPercent === null ? "margin n/a" : `${profit.marginPercent.toFixed(1)}%`})
            </span>
          </dd>
        </div>

        {/* Shipping margin, stated once, where it can be read at a glance. */}
        {profit.shippingCharged > 0 && !profit.shippingCostIsEstimate ? (
          <div className="!mt-3 flex justify-between border-t border-white/5 pt-2">
            <dt className="text-zinc-500">Shipping margin</dt>
            <dd className={`tabular-nums ${profit.shippingProfit >= 0 ? "text-emerald-300/80" : "text-rose-300/80"}`}>
              {money(profit.shippingProfit)}
            </dd>
          </div>
        ) : null}

        {/* Below the total, deliberately. Sales tax is money held for a state,
            not revenue, and anything above the Net profit line reads as ours. */}
        {profit.taxCollected > 0 ? (
          <div className="flex justify-between">
            <dt className="text-zinc-500">Sales tax collected (remitted — not profit)</dt>
            <dd className="text-zinc-500 tabular-nums">{money(profit.taxCollected)}</dd>
          </div>
        ) : null}
      </dl>

      {estimated ? (
        <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-300/90">
          {profit.shippingCostIsEstimate ? "⚠ Exact shipping cost pending — profit uses the estimated shipping cost and will finalize once the label cost is recorded." : ""}
          {profit.hasEstimatedCost ? " Some items had no cost recorded at checkout, so their COGS is estimated at the worst-case assumption." : ""}
        </p>
      ) : null}

      {/* MANUAL ENTRY IS OFFERED ONLY WHERE THE MEASUREMENT NEVER ARRIVES.
          This form was once on every order, and was removed for a good reason:
          Shippo reports settled postage on the transaction_created webhook, and
          a figure typed next to a measured one silently outranks it. That
          reasoning still holds and is why the condition below is
          `shippingCostIsEstimate` rather than "always".

          What it missed is the class of order the repair sweep itself gives up
          on -- a label adopted from the Shippo dashboard whose rate carries no
          readable amount. For those the sweep raises
          shipping_cost_manual_entry_required, which says "no automatic repair
          is possible. Enter the cost by hand in Admin -> Orders", and until now
          this screen had no such control: the profit stayed estimated for ever
          and the instruction pointed nowhere. Shippo is still the only source
          for postage Shippo can report. */}
      {profit.shippingCostIsEstimate ? <AdminOrderShippingCostForm orderId={orderId} /> : null}

      {audit.length > 0 ? (
        <details className="mt-4 border-t border-white/10 pt-3">
          <summary className="cursor-pointer text-[11px] uppercase tracking-[0.18em] text-zinc-500">Shipping cost history ({audit.length})</summary>
          <ul className="mt-2 space-y-1.5 text-[11px] text-zinc-400">
            {audit.map((entry) => (
              <li key={entry.id} className="flex flex-wrap justify-between gap-2">
                <span>
                  {new Date(entry.createdAt).toLocaleString()} · <span className="text-zinc-500">{entry.source}</span>
                </span>
                <span className="tabular-nums">
                  est {centsMoney(entry.estimatedCostCents)} → exact {centsMoney(entry.exactCostCents)}
                  {entry.differenceCents != null ? ` (${entry.differenceCents >= 0 ? "+" : "−"}${centsMoney(Math.abs(entry.differenceCents))})` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </details>
  );
}
