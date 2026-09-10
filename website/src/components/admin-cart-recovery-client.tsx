"use client";

import { useMemo, useState } from "react";
import type { AbandonedCartRow, CartRecoveryStats, RecoveryTrendPoint } from "@/lib/admin-cart-recovery";
import type { CartRecoveryConfig } from "@/lib/admin-control";
import type { GiftableProduct } from "@/lib/admin-cart-recovery";
import { formatDisplayDate } from "@/lib/format-date";
import {
  DEFAULT_RECOVERY_TIERS,
  MAX_GIFT_ITEMS_PER_STAGE,
  TIER_ABSOLUTE_FLOOR_CENTS,
  representativeCartCents,
  tierEconomics,
  validateRecoveryTiers,
  type RecoveryGiftItem,
  type RecoveryTier,
} from "@/lib/cart-recovery-tiers";

const STAGE_LABELS: Record<string, string> = {
  t30m: "1 h reminder",
  t12h: "12 h reminder",
  t24h: "24 h details",
  t72h: "72 h last note",
};

/** One figure in a band's money strip. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-zinc-500">{label}</p>
      {value ? <p className="font-medium text-zinc-200">{value}</p> : null}
    </div>
  );
}

/**
 * Choose the products in one stage's gift.
 *
 * A DROPDOWN OF LIVE PRODUCTS, NEVER A TYPED SLUG. quoteOrder resolves a gift
 * with an exact slug match and no fallback, so a mistyped or retired slug does
 * not fail loudly — the free line is silently never added and the customer gets
 * an email promising a product they never receive. Picking from the catalogue
 * is what makes that unspellable.
 */
function GiftPicker({
  label, items, products, onChange,
}: {
  label: string;
  items: RecoveryGiftItem[];
  products: GiftableProduct[];
  onChange: (items: RecoveryGiftItem[]) => void;
}) {
  const chosen = new Set(items.map((item) => item.slug));
  return (
    <div>
      <p className="text-xs text-zinc-400">{label}</p>
      <div className="mt-1 space-y-1.5">
        {items.map((item, i) => (
          <div key={`${item.slug}-${i}`} className="flex items-center gap-2">
            <select
              className="vl-input flex-1 px-2 py-1.5 text-xs"
              value={item.slug}
              onChange={(e) => onChange(items.map((entry, j) => (j === i ? { ...entry, slug: e.target.value } : entry)))}
            >
              {products.map((product) => (
                <option key={product.slug} value={product.slug} className="bg-zinc-900" disabled={chosen.has(product.slug) && product.slug !== item.slug}>
                  {product.name}
                </option>
              ))}
            </select>
            <input
              type="number" min={1} max={5}
              className="vl-input w-16 px-2 py-1.5 text-xs"
              value={item.quantity}
              onChange={(e) => onChange(items.map((entry, j) => (j === i ? { ...entry, quantity: Math.round(Number(e.target.value)) } : entry)))}
            />
            <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-[11px] text-zinc-500 hover:text-red-300">
              ✕
            </button>
          </div>
        ))}
        {items.length < MAX_GIFT_ITEMS_PER_STAGE && products.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              const next = products.find((product) => !chosen.has(product.slug));
              if (next) onChange([...items, { slug: next.slug, quantity: 1 }]);
            }}
            className="text-[11px] text-cyan-300/80 underline-offset-2 hover:underline"
          >
            + add product
          </button>
        ) : null}
        {items.length === 0 ? <p className="text-[11px] text-zinc-600">No gift at this stage.</p> : null}
      </div>
    </div>
  );
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function TrendChart({ title, points }: { title: string; points: RecoveryTrendPoint[] }) {
  const max = useMemo(() => Math.max(...points.map((p) => p.abandoned), 1), [points]);

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">{title}</p>
      {points.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">No data yet.</p>
      ) : (
        <div className="mt-4 grid grid-flow-col auto-cols-fr gap-1.5 overflow-x-auto">
          {points.map((point) => {
            const abandonedHeight = Math.max(6, Math.round((point.abandoned / max) * 100));
            const recoveredHeight = Math.max(0, Math.round((point.recovered / max) * 100));
            return (
              <div key={point.date} className="flex min-w-[20px] flex-col items-center gap-1">
                <div className="relative flex h-24 w-full items-end rounded-sm bg-white/5 p-0.5">
                  <div className="w-full rounded-sm bg-white/40" style={{ height: `${abandonedHeight}%` }} />
                  <div className="absolute bottom-0.5 w-full rounded-sm bg-emerald-400" style={{ height: `${recoveredHeight}%` }} />
                </div>
                <p className="text-[9px] text-zinc-600">{point.date.slice(5)}</p>
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-2 flex gap-4 text-[10px] text-zinc-500">
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-white/40" /> Abandoned</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-400" /> Recovered</span>
      </div>
    </div>
  );
}

export function AdminCartRecoveryClient({
  initialCarts,
  initialStats,
  initialWeeklyTrend,
  initialMonthlyTrend,
  initialConfig,
  giftProducts,
  postageCents,
  productCostRatio,
}: {
  initialCarts: AbandonedCartRow[];
  initialStats: CartRecoveryStats;
  initialWeeklyTrend: RecoveryTrendPoint[];
  /** Live products a band may gift, with their REAL per-dose cost. */
  giftProducts: GiftableProduct[];
  /** What a shipment actually costs. Fixed, so it falls hardest on small carts. */
  postageCents: number;
  /** Product COGS as a share of revenue, from the live blended margin. */
  productCostRatio: number;
  initialMonthlyTrend: RecoveryTrendPoint[];
  initialConfig: CartRecoveryConfig;
}) {
  const [carts] = useState(initialCarts);
  const [stats] = useState(initialStats);
  const [config, setConfig] = useState(initialConfig);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);

  const resend = async (cartId: string, stage: "t30m" | "t12h" | "t24h" | "t72h") => {
    setBusyId(`${cartId}:${stage}`);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/cart-recovery/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cartId, stage }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      setMessage(result.success ? "Recovery email sent." : (result.error ?? "Unable to send that email."));
    } catch {
      setMessage("Unable to send that email right now.");
    } finally {
      setBusyId(null);
    }
  };

  // THE BANDS, EDITED LOCALLY AND VALIDATED BEFORE THEY ARE SENT.
  const [tiers, setTiers] = useState<RecoveryTier[]>(initialConfig.tiers ?? DEFAULT_RECOVERY_TIERS);
  const [tierError, setTierError] = useState<string | null>(null);

  const updateTier = (index: number, change: (tier: RecoveryTier) => RecoveryTier) => {
    setTiers((prev) => prev.map((tier, i) => (i === index ? change(tier) : tier)));
  };

  const costBySlug = useMemo(
    () => new Map(giftProducts.flatMap((p) => (p.costCents === null ? [] : [[p.slug, p.costCents] as const]))),
    [giftProducts],
  );

  // The same inputs the tests assert against, so the number on screen is the
  // number that was signed off.
  const economicsInputs = useMemo(() => ({
    productCostRatio,
    postageCents,
    giftCostCents: Object.fromEntries(costBySlug),
    giftRetailCents: Object.fromEntries(giftProducts.map((p) => [p.slug, p.priceCents])),
  }), [costBySlug, giftProducts, postageCents, productCostRatio]);

  const saveConfig = async () => {
    // Refused here as well as at the API, so the operator sees the reason
    // beside the field rather than after a round trip.
    const verdict = validateRecoveryTiers(tiers, new Set(giftProducts.map((p) => p.slug)));
    if (!verdict.ok) {
      setTierError(verdict.error);
      return;
    }
    setTierError(null);
    setSavingConfig(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/cart-recovery/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, tiers: verdict.tiers }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (result.success) {
        // Adopt what was actually stored: the API sorts the bands, so keeping
        // the local order would show something the sweep does not use.
        setTiers(verdict.tiers);
        setMessage("Settings saved.");
      } else {
        setMessage(result.error ?? "Unable to save settings.");
      }
    } catch {
      setMessage("Unable to save settings right now.");
    } finally {
      setSavingConfig(false);
    }
  };

  return (
    <div className="space-y-6">
      {message ? <p className="vl-panel rounded-xl p-3 text-sm text-zinc-200">{message}</p> : null}

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Overview</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Total Abandoned</p>
            <p className="mt-2 text-2xl font-semibold text-white">{stats.totalAbandoned}</p>
          </div>
          {/* THE NUMBER THE PROGRAMME CAN ACTUALLY TAKE CREDIT FOR, first and
              on its own, because the looser one beside it read as this for
              months. On 2026-09-10 the tile below said ten; none of the ten
              could be credited to a recovery email. */}
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Recovered By Email</p>
            <p className="mt-2 text-2xl font-semibold text-white">{stats.attributedRecovered}</p>
            <p className="mt-1 text-[11px] text-zinc-500">clicked a reminder, then bought</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Closed After A Reminder</p>
            <p className="mt-2 text-2xl font-semibold text-white">{stats.totalRecovered}</p>
            <p className="mt-1 text-[11px] text-zinc-500">
              any purchase in the window{stats.recoveredOrderCount !== stats.totalRecovered ? ` · ${stats.recoveredOrderCount} order${stats.recoveredOrderCount === 1 ? "" : "s"}` : ""}
            </p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Recovery Rate</p>
            <p className="mt-2 text-2xl font-semibold text-white">{stats.recoveryPercent}%</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Avg Recovery Time</p>
            <p className="mt-2 text-2xl font-semibold text-white">{stats.averageRecoveryTimeHours !== null ? `${stats.averageRecoveryTimeHours}h` : "—"}</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Potential Lost Revenue</p>
            <p className="mt-2 text-2xl font-semibold text-white">{money(stats.potentialLostRevenueCents)}</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Revenue Recovered</p>
            <p className="mt-2 text-2xl font-semibold text-white">{money(stats.revenueRecoveredCents)}</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Open / Click Rate</p>
            <p className="mt-2 text-2xl font-semibold text-white">{stats.openRatePercent}% / {stats.clickRatePercent}%</p>
            {/* Opens are inflated at the top by Apple Mail Privacy Protection
                and missing at the bottom where images are blocked. The click
                rate is the one worth optimising against. */}
            <p className="mt-1 text-[11px] text-zinc-500">clicks are the reliable half</p>
          </div>
          {stats.internalCartsExcluded > 0 ? (
            <div className="vl-panel-soft rounded-xl p-4">
              <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Internal Excluded</p>
              <p className="mt-2 text-2xl font-semibold text-white">{stats.internalCartsExcluded}</p>
              <p className="mt-1 text-[11px] text-zinc-500">our own carts, left out of every figure here</p>
            </div>
          ) : null}
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Coupon Redemption Rate</p>
            <p className="mt-2 text-2xl font-semibold text-white">{stats.couponRedemptionRatePercent}%</p>
            {stats.stages.length > 0 ? (
              <dl className="mt-3 space-y-1 border-t border-white/10 pt-2 text-[11px] text-zinc-400" data-testid="cart-recovery-stage-funnel">
                {stats.stages.map((row) => (
                  <div key={row.stage} className="flex justify-between gap-2">
                    <dt>{STAGE_LABELS[row.stage] ?? row.stage}</dt>
                    <dd className="text-zinc-200">{row.sent} sent · {row.opened} opened · {row.clicked} clicked</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        </div>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Recovery Performance</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <TrendChart title="Last 7 Days" points={initialWeeklyTrend} />
          <TrendChart title="Last 30 Days" points={initialMonthlyTrend} />
        </div>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Email Sequence Settings</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={config.t30mEnabled} onChange={(e) => setConfig((prev) => ({ ...prev, t30mEnabled: e.target.checked }))} />
            30 min reminder
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={config.t12hEnabled} onChange={(e) => setConfig((prev) => ({ ...prev, t12hEnabled: e.target.checked }))} />
            12 hr reminder
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={config.t24hEnabled} onChange={(e) => setConfig((prev) => ({ ...prev, t24hEnabled: e.target.checked }))} />
            24 hr + coupon
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={config.t72hEnabled} onChange={(e) => setConfig((prev) => ({ ...prev, t72hEnabled: e.target.checked }))} />
            72 hr final reminder
          </label>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-zinc-400">
            Discount (%)
            <input
              type="number"
              step="0.5"
              value={config.discountPercent}
              onChange={(e) => setConfig((prev) => ({ ...prev, discountPercent: Number(e.target.value) }))}
              className="vl-input mt-1 w-full px-2 py-1.5"
            />
          </label>
          <label className="text-xs text-zinc-400">
            Coupon expiration (hours)
            <input
              type="number"
              value={config.couponExpirationHours}
              onChange={(e) => setConfig((prev) => ({ ...prev, couponExpirationHours: Number(e.target.value) }))}
              className="vl-input mt-1 w-full px-2 py-1.5"
            />
          </label>
        </div>
        <button type="button" onClick={saveConfig} disabled={savingConfig} className="vl-btn-primary vl-focus-ring mt-4 px-5 py-2.5 text-sm disabled:opacity-60">
          {savingConfig ? "Saving…" : "Save settings"}
        </button>
      </section>


      {/* ------------------------------------------------------------------
          WHAT EACH CART SIZE IS OFFERED, AND WHAT IT COSTS.

          The band table is the commercial decision in this whole programme,
          so it is edited here rather than in code — and every row shows the
          money as it is typed. Costs are the real per-dose figures and the
          real average postage, so the margin on screen is the margin.

          Placed under the schedule because the two answer different
          questions: the schedule is WHEN a shopper is written to, this is
          WHAT they are offered.
      ------------------------------------------------------------------ */}
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">Offer by cart size</h2>
          <p className="text-xs text-zinc-500">
            Postage {money(postageCents)} · product cost {(productCostRatio * 100).toFixed(1)}% of revenue
          </p>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-zinc-400">
          Bigger carts hold most of the money, so they get a bigger gift. A gift buys far more perceived
          value per dollar than a discount does, which is why the largest and smallest bands carry no
          percentage at all.
        </p>

        {tierError ? (
          <p data-testid="tier-error" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
            {tierError}
          </p>
        ) : null}

        <div className="mt-4 space-y-3">
          {tiers.map((tier, index) => {
            const cart = representativeCartCents(tiers, index);
            const economics = tierEconomics(tier, cart, economicsInputs);
            const next = tiers[index + 1];
            const range = next
              ? `${money(tier.minCents)} – ${money(next.minCents - 1)}`
              : `${money(tier.minCents)} and up`;
            const unknownCost = [...tier.stage3, ...tier.stage4.gifts]
              .some((item) => costBySlug.get(item.slug) === undefined);
            return (
              <div key={`${tier.minCents}-${index}`} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-zinc-400">
                      Carts from
                      <input
                        type="number" min={35} step={1}
                        data-testid={`tier-min-${index}`}
                        value={Math.round(tier.minCents / 100)}
                        onChange={(e) => updateTier(index, (prev) => ({ ...prev, minCents: Math.round(Number(e.target.value) * 100) }))}
                        className="vl-input ml-2 w-24 px-2 py-1.5"
                      />
                    </label>
                    <span className="text-xs text-zinc-500">{range}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTiers((prev) => prev.filter((_, i) => i !== index))}
                    className="text-[11px] text-zinc-500 underline-offset-2 hover:text-red-300 hover:underline"
                  >
                    Remove band
                  </button>
                </div>

                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <GiftPicker
                    label="24-hour gift"
                    items={tier.stage3}
                    products={giftProducts}
                    onChange={(items) => updateTier(index, (prev) => ({ ...prev, stage3: items }))}
                  />
                  <div className="space-y-2">
                    <GiftPicker
                      label="72-hour gift"
                      items={tier.stage4.gifts}
                      products={giftProducts}
                      onChange={(items) => updateTier(index, (prev) => ({ ...prev, stage4: { ...prev.stage4, gifts: items } }))}
                    />
                    <label className="block text-xs text-zinc-400">
                      72-hour discount (%) — 0 for none
                      <input
                        type="number" min={0} max={100} step={1}
                        data-testid={`tier-percent-${index}`}
                        value={tier.stage4.percent}
                        onChange={(e) => updateTier(index, (prev) => ({ ...prev, stage4: { ...prev.stage4, percent: Math.round(Number(e.target.value)) } }))}
                        className="vl-input mt-1 w-full px-2 py-1.5"
                      />
                    </label>
                  </div>
                </div>

                {/* THE MONEY, AS IT IS TYPED. Same function the tests assert
                    against, so what is on screen is what was signed off. */}
                <div data-testid={`tier-economics-${index}`} className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[11px] sm:grid-cols-5">
                  <Figure label={`On a ${money(cart)} cart`} value="" />
                  <Figure label="72h offer costs" value={money(economics.incentiveCents)} />
                  <Figure label="They see" value={money(economics.perceivedValueCents)} />
                  <Figure label="Net margin" value={`${economics.netMarginPercent.toFixed(1)}%`} />
                  <Figure label="of contribution" value={`${economics.incentiveShareOfContributionPercent.toFixed(1)}%`} />
                </div>
                {unknownCost ? (
                  <p className="mt-2 text-[11px] text-amber-300/90">
                    One of these products has no per-vial cost recorded, so the figures above understate what this band costs.
                    Set it under Admin → Products.
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setTiers((prev) => [...prev, {
              minCents: (prev[prev.length - 1]?.minCents ?? 3_500) * 2,
              stage3: [],
              stage4: { gifts: [], percent: 10 },
            }])}
            className="vl-btn-secondary vl-focus-ring px-4 py-2 text-sm"
          >
            Add band
          </button>
          <button type="button" onClick={saveConfig} disabled={savingConfig} className="vl-btn-primary vl-focus-ring px-5 py-2.5 text-sm disabled:opacity-60">
            {savingConfig ? "Saving…" : "Save offer bands"}
          </button>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
          Nothing is gifted under {money(TIER_ABSOLUTE_FLOOR_CENTS)} whatever these bands say, one gift goes to an
          address per 30 days, one sequence per address per week, and a customer who bought in the last 30 days is
          offered nothing at all. Those limits are not editable — they are what stops the ladder being farmed.
        </p>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Abandoned Carts</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="pb-2 pr-4">Email</th>
                <th className="pb-2 pr-4">Cart Value</th>
                <th className="pb-2 pr-4">Abandoned</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Stages Sent</th>
                <th className="pb-2 pr-4">Resend</th>
              </tr>
            </thead>
            <tbody>
              {carts.map((cart) => (
                <tr key={cart.id} className="border-t border-white/10">
                  <td className="py-2 pr-4 text-zinc-200">{cart.email}</td>
                  <td className="py-2 pr-4 text-zinc-200">{money(cart.cartValueCents)}</td>
                  <td className="py-2 pr-4 text-zinc-400">{formatDisplayDate(cart.firstSeenAt, "datetime") ?? "—"}</td>
                  <td className="py-2 pr-4 text-zinc-400">{cart.status}</td>
                  <td className="py-2 pr-4 text-zinc-400">{cart.stagesSent.join(", ") || "—"}</td>
                  <td className="py-2 pr-4">
                    <div className="flex flex-wrap gap-1.5">
                      {(["t30m", "t12h", "t24h", "t72h"] as const).map((stage) => (
                        <button
                          key={stage}
                          type="button"
                          onClick={() => resend(cart.id, stage)}
                          disabled={busyId === `${cart.id}:${stage}` || cart.status !== "active"}
                          className="vl-btn-secondary px-2 py-1 text-[10px] disabled:opacity-50"
                        >
                          {stage}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {carts.length === 0 ? (
                <tr><td colSpan={6} className="py-6 text-center text-sm text-zinc-500">No abandoned carts yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
