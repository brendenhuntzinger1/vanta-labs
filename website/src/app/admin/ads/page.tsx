import Link from "next/link";
import { getAdsDashboard, type CreativeRow } from "@/lib/ads/dashboard-data";
import { TABLE_LIMIT, getSpendDashboard, type SpendDashboard } from "@/lib/ads/spend-dashboard";
import { AdsSectionTabs } from "@/components/ads-section-tabs";
import { AdsTrackingHealth } from "@/components/ads-tracking-health";
import { SnapTrackingHealth } from "@/components/snap-tracking-health";
import { AdsCampaignsPanel } from "@/components/ads-campaigns-panel";
import { AdUrlBuilder } from "@/components/ad-url-builder";
import { getCatalogProducts } from "@/lib/catalog";
import { getSiteUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * The owner advertising dashboard.
 *
 * Built before the data exists, on purpose. Every control that would move money
 * renders in place and disabled, with the specific reason next to it — so the
 * shape of the system is reviewable now, and switching a control on later is a
 * visible, deliberate act rather than a surprise.
 */

const money = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(2)}%`);
const ratio = (n: number | null) => (n === null ? "—" : n.toFixed(2));

function Panel({ title, subtitle, children, action }: {
  title: string; subtitle?: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/[0.07] bg-[#141414] p-5">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-[0.14em] text-white/70">{title}</h2>
          {subtitle ? <p className="mt-1 text-xs text-white/40">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/**
 * ── THE SPEND PANELS ──
 *
 * Read top to bottom the page answers, in order: how much did I spend, what did
 * it earn, which platform is working, which campaign, which ad, and what am I
 * not measuring. Anything that needs a second click is a level of detail below
 * something already on screen.
 *
 * Two rules run through all of it.
 *
 * **Recorded data always beats a configuration hint.** An earlier version checked
 * `feedConfigured` before checking whether any rows existed, so a deployment
 * holding real spend but no API key hid $205 of it behind "no spend feed" while
 * the panel beside it reported a percentage of that same spend. Empty states are
 * for when there is genuinely nothing to show; when rows exist they render, with
 * a warning if they can no longer refresh.
 *
 * **Our numbers and the platforms' numbers never share a column.** `Purchases`
 * is our paid-order count. `Platform` is what the ad platform claims under its
 * own attribution model. They will disagree, and the disagreement is usually the
 * most informative thing on the page — so it is shown, not resolved.
 */

/** Colour only the number that means "this made money". */
function roasClass(roas: number | null): string {
  if (roas === null) return "text-white/40";
  return roas >= 1 ? "text-emerald-300" : "text-red-300";
}

/** The headline. Everything the owner needs before scrolling. */
function Headline({ s }: { s: SpendDashboard }) {
  const cells: [string, string, string?][] = [
    ["Spend", money(s.totals.spend)],
    ["Revenue", money(s.totals.revenue), "attributed, net of refunds"],
    ["ROAS", ratio(s.totals.roas)],
    ["Purchases", String(s.totals.orders), "our paid orders"],
    ["CPA", s.totals.cpa === null ? "—" : money(s.totals.cpa)],
    ["CTR", pct(s.totals.ctr)],
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cells.map(([label, value, note]) => (
        <div key={label} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
          <dt className="text-[10px] uppercase tracking-[0.16em] text-white/35">{label}</dt>
          <dd className={`mt-1 text-xl ${label === "ROAS" ? roasClass(s.totals.roas) : "text-white"}`}>{value}</dd>
          {note ? <dd className="mt-0.5 text-[10px] leading-4 text-white/25">{note}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/** Shared column set for the three ROAS tables, so they read identically. */
type MetricRow = {
  spend: number;
  revenue: number;
  orders: number;
  platformConversions: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cvr: number | null;
  cpa: number | null;
  roas: number | null;
};

function MetricTable<T extends MetricRow>({
  rows, label, name, sub, empty, compact = false,
}: {
  rows: T[];
  label: string;
  name: (row: T) => React.ReactNode;
  sub?: (row: T) => React.ReactNode;
  empty: React.ReactNode;
  /**
   * Drop the diagnostic rates, keeping money and ROAS.
   *
   * For the half-width Winners/Losers panels. At full column count they need
   * ~48rem, so in a two-column grid ROAS — the entire point of the panel —
   * scrolled off the right edge and the reader saw CTR instead. A panel whose
   * headline number is off-screen is not at-a-glance.
   */
  compact?: boolean;
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  const headers = compact
    ? [label, "Spend", "Revenue", "Purch.", "CPA", "ROAS"]
    : [label, "Spend", "Revenue", "Purch.", "Platform", "CTR", "CVR", "CPC", "CPM", "CPA", "ROAS"];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs" style={{ minWidth: compact ? "24rem" : "48rem" }}>
        <thead>
          <tr className="text-[10px] uppercase tracking-[0.14em] text-white/35">
            {headers.map((h) => (
              <th key={h} className="pb-2 pr-4 font-medium whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="text-white/75">
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-white/[0.06]">
              <td className="py-2.5 pr-4 text-white">
                {name(r)}
                {sub ? <span className="block text-[10px] text-white/35">{sub(r)}</span> : null}
              </td>
              <td className="py-2.5 pr-4 whitespace-nowrap">{money(r.spend)}</td>
              <td className="py-2.5 pr-4 whitespace-nowrap">{money(r.revenue)}</td>
              <td className="py-2.5 pr-4">{r.orders}</td>
              {compact ? null : (
                <>
                  {/* The platform's own count, under its own attribution model.
                      Kept visually quieter than ours because ours is what ROAS uses. */}
                  <td className="py-2.5 pr-4 text-white/40">{r.platformConversions ?? "—"}</td>
                  <td className="py-2.5 pr-4 whitespace-nowrap">{pct(r.ctr)}</td>
                  <td className="py-2.5 pr-4 whitespace-nowrap">{pct(r.cvr)}</td>
                  <td className="py-2.5 pr-4 whitespace-nowrap">{r.cpc === null ? "—" : money(r.cpc)}</td>
                  <td className="py-2.5 pr-4 whitespace-nowrap">{r.cpm === null ? "—" : money(r.cpm)}</td>
                </>
              )}
              <td className="py-2.5 pr-4 whitespace-nowrap">{r.cpa === null ? "—" : money(r.cpa)}</td>
              <td className={`py-2.5 pr-4 font-medium ${roasClass(r.roas)}`}>{ratio(r.roas)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The empty state, which is three different problems with three different fixes.
 *
 * ORDER MATTERS. Rows are checked before configuration, so recorded spend is
 * never hidden behind a setup hint — see the note at the top of this section.
 */
function SpendEmptyState({ s }: { s: SpendDashboard }) {
  if (!s.schemaReady) {
    return (
      <Empty>
        Apply <code className="font-mono text-white/60">src/lib/sql/ads-spend-roas.sql</code> to create the spend table
        and ROAS views.
      </Empty>
    );
  }
  if (!s.feedConfigured) {
    return (
      <Empty>
        No spend feed. Set <code className="font-mono text-white/60">WINDSOR_API_KEY</code> and the nightly job will
        pull Meta, TikTok, Reddit and Snapchat spend into{" "}
        <code className="font-mono text-white/60">ad_spend_daily</code>.
      </Empty>
    );
  }
  return (
    <Empty>
      Feed is configured but has pulled nothing yet
      {s.lastIngestedAt ? ` (last run ${s.lastIngestedAt.slice(0, 16).replace("T", " ")} UTC)` : " — it has never run"}.
      No spend on any platform in the last {s.windowDays} days.
    </Empty>
  );
}

/** Rows exist but nothing will refresh them. Showing the numbers without saying
 *  so would present a frozen snapshot as current. */
/**
 * THE WARNING HAD TO BE ABLE TO FIRE FOR THE FAILURE THAT ACTUALLY HAPPENS.
 *
 * This tested one thing: whether WINDSOR_API_KEY is set. That is the failure
 * nobody has — a missing key is noticed on the day it is configured. The one
 * that happens is a key that IS set while the feed has stopped delivering: a
 * revoked ad-account grant, an expired Windsor connection, a plan limit. On
 * 2026-09-06 the live account was returning an account notice instead of data
 * on all four connectors, with the key perfectly present.
 *
 * In that state this panel showed whatever last landed, with no indication that
 * it was old — which is the same figure a genuinely quiet week produces. So it
 * now also states the AGE of the newest row it has.
 *
 * The threshold is derived from the machinery, not picked: the sweep runs every
 * 30 minutes (vercel.json) and the ingest self-limits to one fetch every
 * MIN_HOURS_BETWEEN_RUNS = 6, so anything past a day is several missed windows
 * and cannot be normal. It reports hours, so the operator can see the
 * difference between "an hour late" and "four days dead".
 */
const STALE_AFTER_HOURS = 24;

function StaleFeedNotice({ s }: { s: SpendDashboard }) {
  if (s.platforms.length === 0) return null;

  if (!s.feedConfigured) {
    return (
      <p className="mt-3 rounded-xl border border-[color:var(--accent-gold)]/25 bg-[color:var(--accent-gold)]/[0.05] px-3 py-2 text-[11px] leading-5 text-white/60">
        These figures will not update: <code className="font-mono text-white/80">WINDSOR_API_KEY</code> is unset, so the
        nightly job cannot fetch spend. What is shown is whatever last landed.
      </p>
    );
  }

  const hours = s.lastIngestedAgeHours;
  if (hours === null) {
    return (
      <p className="mt-3 rounded-xl border border-[color:var(--accent-gold)]/25 bg-[color:var(--accent-gold)]/[0.05] px-3 py-2 text-[11px] leading-5 text-white/60">
        The key is configured but no spend has ever landed. Check the sweep&apos;s ad_spend_ingest job.
      </p>
    );
  }

  if (hours < STALE_AFTER_HOURS) return null;

  return (
    <p className="mt-3 rounded-xl border border-[color:var(--accent-gold)]/25 bg-[color:var(--accent-gold)]/[0.05] px-3 py-2 text-[11px] leading-5 text-white/60">
      <strong className="text-white/80">These figures are {hours} hours old.</strong> The key is set, so the feed is
      answering with something the ingest will not accept — a revoked ad-account grant, an expired Windsor connection or
      a plan limit. Spend since then is missing from every number on this page.
    </p>
  );
}

/**
 * The two blind spots, stated as amounts.
 *
 * A ROAS table that quietly covers 40% of spend is worse than one that says
 * which 60% is missing, so both gaps are quantified against the totals they are
 * missing from.
 */
function BlindSpots({ s }: { s: SpendDashboard }) {
  const spendShare = s.totals.spend > 0 ? s.untaggedSpend / s.totals.spend : null;
  const revenueShare = s.totals.revenue > 0 ? s.unattributedRevenueTotal / s.totals.revenue : null;

  if (s.untaggedSpend === 0 && s.unattributedRevenueTotal === 0) {
    return (
      <Empty>
        Nothing is unmeasured: every ad that spent carries a readable{" "}
        <code className="font-mono text-white/60">utm_content</code>, and every attributed order names one.
      </Empty>
    );
  }

  return (
    <div className="space-y-4">
      {s.untaggedSpend > 0 ? (
        <div>
          <p className="text-xs text-white/60">
            <span className="text-white">{money(s.untaggedSpend)}</span>
            {spendShare === null ? null : <> — {pct(spendShare)} of spend</>} cannot be matched to revenue: these ads
            carry no creative tag. Counted in the platform table above; absent from the ad table.
          </p>
          <ul className="mt-2 space-y-1.5 text-xs">
            {s.untagged.slice(0, 6).map((u) => (
              <li key={`${u.platform}:${u.adId}`} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                <span className="min-w-0 truncate text-white/70">
                  <span className="capitalize text-white/50">{u.platform}</span> · {u.adName ?? u.adId}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="font-mono text-[10px] text-white/30">{u.reason.replace(/_/g, " ")}</span>
                  <span className="text-white/80">{money(u.spend)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {s.unattributedRevenueTotal > 0 ? (
        <div>
          <p className="text-xs text-white/60">
            <span className="text-white">{money(s.unattributedRevenueTotal)}</span>
            {revenueShare === null ? null : <> — {pct(revenueShare)} of revenue</>} names a platform but no ad, so it
            counts toward platform ROAS and toward no single creative.
          </p>
          <ul className="mt-2 space-y-1.5 text-xs">
            {s.unattributedRevenue.slice(0, 4).map((u) => (
              <li key={`${u.platform}:${u.utmCampaign ?? ""}`} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                <span className="min-w-0 truncate text-white/70">
                  <span className="capitalize text-white/50">{u.platform}</span>
                  {u.utmCampaign ? ` · ${u.utmCampaign}` : " · no campaign tag"}
                </span>
                <span className="shrink-0 text-white/80">
                  {money(u.revenue)} <span className="text-white/35">({u.orders})</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-white/40">{children}</p>;
}

/** A control that cannot run yet. The reason is part of the button, not a tooltip. */
function LockedButton({ label, reason }: { label: string; reason: string }) {
  return (
    <span className="group relative inline-flex flex-col">
      <button
        type="button"
        disabled
        title={reason}
        className="cursor-not-allowed rounded-lg border border-white/10 bg-white/[0.02] px-3 py-1.5 text-xs text-white/30"
      >
        {label}
      </button>
      <span className="mt-1 max-w-[16rem] text-[10px] leading-4 text-white/25">{reason}</span>
    </span>
  );
}

function CreativeTable({ rows, empty }: { rows: CreativeRow[]; empty: string }) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-xs">
        <thead className="text-white/40">
          <tr>
            {["Creative", "Archetype", "Spend", "Revenue", "Purch.", "CTR", "ATC", "CPA", "ROAS"].map((h) => (
              <th key={h} className="pb-2 font-medium uppercase tracking-[0.1em]">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="text-white/75">
          {rows.map((r) => (
            <tr key={r.creativeId} className="border-t border-white/[0.05]">
              <td className="py-2 pr-3">
                <span className="font-mono text-[11px] text-white/90">{r.creativeId}</span>
                <span className="block max-w-[22rem] truncate text-white/40">{r.hook}</span>
              </td>
              <td className="pr-3">{r.archetype}</td>
              <td className="pr-3">{money(r.spend)}</td>
              <td className="pr-3">{money(r.revenue)}</td>
              <td className="pr-3">{r.purchases}</td>
              <td className="pr-3">{pct(r.metrics.ctr)}</td>
              <td className="pr-3">{pct(r.metrics.atcRate)}</td>
              <td className="pr-3">{r.metrics.cpa === null ? "—" : money(r.metrics.cpa)}</td>
              <td className="pr-3">{ratio(r.metrics.roas)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function AdsDashboardPage() {
  const [d, spend, catalogue] = await Promise.all([
    getAdsDashboard(),
    getSpendDashboard(),
    // The landing-page picker offers real pages, so a tagged URL cannot point at
    // a slug that 404s. Failing softly: the builder still works with the two
    // generic paths if the catalogue cannot be read.
    getCatalogProducts().catch(() => []),
  ]);
  const siteUrl = getSiteUrl();
  const products = catalogue
    .map((p) => ({ slug: String(p.slug ?? ""), name: String(p.name ?? p.slug ?? "") }))
    .filter((p) => p.slug);
  const spendLocked = `TikTok is not connected — ${d.tiktok.missing.length} credential(s) missing and eligibility unconfirmed.`;
  const modeLabel = d.guardrails.frozen ? "FROZEN" : d.guardrails.mode.replace("_", " ").toUpperCase();

  const schemaBanner = !d.schemaReady ? (
    <div className="rounded-2xl border border-[color:var(--accent-gold)]/25 bg-[color:var(--accent-gold)]/[0.05] p-5 text-sm text-white/75">
      <p className="font-medium text-white">The ad schema has not been applied.</p>
      <p className="mt-2 text-xs leading-6 text-white/60">
        <code className="font-mono text-white/80">src/lib/sql/ads-system.sql</code> and{" "}
        <code className="font-mono text-white/80">src/lib/sql/analytics-creative-attribution.sql</code> create the 13 ad
        tables and the three per-creative attribution columns. Until they are applied every panel below is empty because
        there is nothing to read — not because performance is zero. Nothing else depends on them: the pixel, the Events
        API and first-party analytics all work without them.
      </p>
      {d.schemaError ? <p className="mt-2 font-mono text-[11px] text-red-300">{d.schemaError}</p> : null}
    </div>
  ) : null;

  const overview = (
    <>
      {schemaBanner}

      {/* FROM THE SAME SOURCE AS THE THIRTY-DAY PANEL BELOW IT.
          This read `d.today`, which comes from ad_performance_daily — the table
          PR #161 was written to replace, because its creative_id foreign key
          requires a creative designed inside this system and no ad running on
          the four live platforms has one. So the strip showed
          $0.00 / $0.00 / 0 / — / — for ever, directly above a panel reporting
          real money, on a page that promises "an empty panel means no data,
          never a guess". Measured: $573.45 of spend seeded across five days
          including today, and this strip read $0.00. */}
      <Panel title="Today" subtitle={spend.schemaReady ? "site-attributed revenue net of refunds" : "no data source yet"}>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            ["Spend", money(spend.today.spend)],
            ["Revenue", money(spend.today.revenue)],
            ["Purchases", String(spend.today.orders)],
            ["CPA", spend.today.cpa === null ? "—" : money(spend.today.cpa)],
            ["ROAS", ratio(spend.today.roas)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
              <dt className="text-[10px] uppercase tracking-[0.16em] text-white/35">{label}</dt>
              <dd className="mt-1 text-xl text-white">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[11px] leading-5 text-white/30">
          Every figure here is read from recorded data. Nothing on this page is modelled, estimated or filled in — an
          empty panel means no data, never a guess.
        </p>
      </Panel>

      <Panel
        title={`Advertising, last ${spend.windowDays} days`}
        subtitle="spend from the ad platforms · revenue from our own paid orders, last-touch, net of refunds"
      >
        {spend.platforms.length === 0 ? <SpendEmptyState s={spend} /> : <Headline s={spend} />}
        <StaleFeedNotice s={spend} />
        <p className="mt-3 text-[11px] leading-5 text-white/30">
          Revenue and ROAS use this store&apos;s own attributed orders, never the platforms&apos; conversion reporting.
          The two disagree by design — each platform counts under its own attribution model — so the platforms&apos; own
          count sits in its own column below rather than being blended in.
        </p>
      </Panel>

      <Panel
        title="Tag a new ad"
        subtitle="the one step that has to be done by hand — everything above is read from these tags"
      >
        <AdUrlBuilder siteUrl={siteUrl} products={products} />

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="text-[10px] uppercase tracking-[0.16em] text-white/35">The two parts you change</h3>
            <dl className="mt-2 space-y-2 text-[11px] leading-5">
              <div>
                <dt className="text-white/70">Landing page</dt>
                <dd className="text-white/45">
                  The product page the ad opens. Pick the product that ad is selling.
                </dd>
              </div>
              <div>
                <dt className="text-white/70">Ad</dt>
                <dd className="text-white/45">
                  A short name for this one ad, like <code className="font-mono text-white/60">hook_a</code>. Give every
                  ad a different one — that is how you find out which ad made the money.
                </dd>
              </div>
              <div>
                <dt className="text-white/70">Campaign</dt>
                <dd className="text-white/45">Same name on every ad in the campaign.</dd>
              </div>
            </dl>
            <p className="mt-3 text-[11px] leading-5 text-white/30">
              The rest of the link is set for you. Use lowercase letters, numbers,{" "}
              <code className="font-mono">_</code> and <code className="font-mono">-</code> only — spaces and capitals
              break it, and the ad shows up under &ldquo;What is not measured&rdquo; instead of earning a ROAS.
            </p>
          </div>

          <div>
            <h3 className="text-[10px] uppercase tracking-[0.16em] text-white/35">Where to paste it</h3>
            <ul className="mt-2 space-y-1.5 text-[11px] leading-5">
              {[
                ["Meta", "Ads Manager → your ad → Website URL"],
                ["TikTok", "Ad → Destination page → URL"],
                ["Reddit", "Ad → Destination URL"],
                ["Snapchat", "Ad → Attachment → Website URL"],
              ].map(([platform, where]) => (
                <li key={platform} className="flex gap-2">
                  <span className="w-16 shrink-0 text-white/70">{platform}</span>
                  <span className="text-white/45">{where}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 rounded-xl border border-[color:var(--accent-gold)]/25 bg-[color:var(--accent-gold)]/[0.05] px-3 py-2 text-[11px] leading-5 text-white/55">
              <span className="text-white/80">Snapchat only:</span> also type the same ad name into Snapchat&apos;s own
              ad-name box. Snapchat is the one platform that does not tell us the link, so the name is how it gets
              matched.
            </p>
          </div>
        </div>
      </Panel>

      {spend.platforms.length > 0 ? (
        <>
          <Panel title="By platform" subtitle="which channel is working — needs only utm_source, so it works before per-ad tagging does">
            <MetricTable
              rows={spend.platforms}
              label="Platform"
              name={(p) => <span className="capitalize">{p.platform}</span>}
              empty="No spend on any platform in this window."
            />
          </Panel>

          <Panel title="By campaign" subtitle="keyed on utm_campaign from the ad's landing URL, not the platform's campaign name">
            <MetricTable
              rows={spend.campaigns}
              label="Campaign"
              name={(c) => c.utmCampaign}
              sub={(c) => <span className="capitalize">{c.platform}</span>}
              empty={
                <>
                  No campaign carries a <code className="font-mono text-white/60">utm_campaign</code> tag yet.
                </>
              }
            />
          </Panel>

          <div className="grid gap-5 xl:grid-cols-2">
            <Panel title="Winners" subtitle="best ROAS among ads that spent">
              <MetricTable
                rows={spend.winners}
                label="Ad"
                compact
                name={(c) => c.utmContent}
                sub={(c) => (
                  <span className="capitalize">
                    {c.platform}
                    {c.ads > 1 ? ` · ${c.ads} ads` : ""}
                  </span>
                )}
                empty={
                  <>
                    No ad has both spent and carried a <code className="font-mono text-white/60">utm_content</code> tag.
                  </>
                }
              />
            </Panel>

            <Panel title="Losers" subtitle="worst ROAS among ads that spent">
              <MetricTable
                rows={spend.losers}
                label="Ad"
                compact
                name={(c) => c.utmContent}
                sub={(c) => <span className="capitalize">{c.platform}</span>}
                empty="Not enough tagged ads to rank a worst yet."
              />
            </Panel>
          </div>
        </>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Says the real count, and says so only when rows were actually
            dropped — "at most N shown" when N is all of them reads as a
            truncation that did not happen. */}
        <Panel
          title="Every tagged ad"
          subtitle={
            spend.creatives.length >= TABLE_LIMIT
              ? `ranked by ROAS · top ${TABLE_LIMIT} of more`
              : `ranked by ROAS · ${spend.creatives.length} tagged ${spend.creatives.length === 1 ? "ad" : "ads"}`
          }
        >
          <MetricTable
            rows={spend.creatives}
            label="Ad"
            name={(c) => c.utmContent}
            sub={(c) => <span className="capitalize">{c.platform}</span>}
            empty={
              <>
                No ad has both spent and carried a creative tag yet. Tag each ad&apos;s landing URL with{" "}
                <code className="font-mono text-white/60">utm_content</code> and per-ad ROAS appears here.
              </>
            }
          />
        </Panel>

        <Panel title="What is not measured" subtitle="the size of this page's blind spot, stated rather than hidden">
          <BlindSpots s={spend} />
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="Fatigue alerts" subtitle="decline against a creative's own peak, tested">
          <Empty>Needs at least a week of daily data per creative.</Empty>
        </Panel>
        <Panel title="Anomaly alerts" subtitle="today against its own trailing distribution">
          <Empty>Needs a 7-day baseline before it will say anything.</Empty>
        </Panel>
        <Panel title="Data health" subtitle="how much to trust the numbers above">
          <ul className="space-y-2 text-xs">
            {[
              ["TikTok reporting", "never ingested — awaiting TikTok connection"],
              ["Site analytics", d.schemaReady ? "live" : "schema not applied"],
              ["Higgsfield", "disconnected — no access confirmed"],
            ].map(([label, state]) => (
              <li key={label} className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                <span className="text-white/70">{label}</span>
                <span className="font-mono text-[10px] text-[color:var(--accent-gold)]/70">{state}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel title="TikTok connection" subtitle="what is still required before anything can publish">
        <div className="grid gap-4 text-xs sm:grid-cols-2">
          <div>
            <p className="mb-2 text-white/50">Needed to read campaign data</p>
            <ul className="space-y-1 font-mono text-[11px] text-white/60">
              {d.tiktok.missing.length === 0 ? <li className="text-white/35">none</li> : d.tiktok.missing.map((m) => <li key={m}>{m}</li>)}
            </ul>
            {d.tiktok.oneTimeSetup.length > 0 ? (
              <>
                <p className="mb-2 mt-4 text-white/50">Used once, to obtain that token</p>
                <ul className="space-y-1 font-mono text-[11px] text-white/40">
                  {d.tiktok.oneTimeSetup.map((m) => <li key={m}>{m}</li>)}
                </ul>
              </>
            ) : null}
            <p className="mt-3 text-[11px] leading-5 text-white/35">
              None of these are required to run ads. The pixel reports conversions on its own — these only let this
              dashboard read spend and performance back out of TikTok.
            </p>
          </div>
          <div>
            <p className="mb-2 text-white/50">Blocked on (not solvable by config)</p>
            <ul className="space-y-1 text-[11px] leading-5 text-white/60">
              {d.tiktok.blockedOn.map((b) => <li key={b}>· {b}</li>)}
            </ul>
          </div>
        </div>
        <p className="mt-4 text-[11px] text-white/35">
          Everything else runs in simulation. See <Link href="/admin" className="underline underline-offset-2">admin home</Link>.
        </p>
      </Panel>
    </>
  );

  const campaigns = (
    <>
      <Panel title="Campaigns" subtitle="spend, CPM, CTR, CPC and CPA, read from TikTok — never modelled">
        <AdsCampaignsPanel />
      </Panel>

      <Panel title="Experiments" subtitle="one variable at a time, or it teaches nothing">
        {d.experiments.length === 0 ? (
          <Empty>No experiments running.</Empty>
        ) : (
          <ul className="space-y-2 text-xs">
            {d.experiments.map((e) => (
              <li key={e.experimentId} className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                <div>
                  <span className="text-white/85">{e.name}</span>
                  <span className="ml-2 text-white/40">axis: {e.axis}</span>
                </div>
                <span className="font-mono text-white/45">
                  {e.status} · look {e.looksTaken}/{e.plannedLooks}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Controls and guardrails" subtitle="deny by default; ceilings start low and are raised deliberately">
        <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          {[
            ["Mode", modeLabel],
            ["Daily account ceiling", money(d.guardrails.dailyAccountCeiling)],
            ["Campaign ceiling", money(d.guardrails.campaignDailyCeiling)],
            ["Max budget step", `${(d.guardrails.maxBudgetIncreasePct * 100).toFixed(0)}% / ${money(d.guardrails.maxBudgetIncreaseAbsolute)}`],
            ["Min conversions to scale", String(d.guardrails.minConversionsToScale)],
            ["Min days to scale", String(d.guardrails.minDaysToScale)],
            ["Min impressions to kill", String(d.guardrails.minImpressionsToKill)],
            ["Auto-approved", d.guardrails.autoApprovedActions.length ? d.guardrails.autoApprovedActions.join(", ") : "none"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
              <dt className="text-[10px] uppercase tracking-[0.14em] text-white/35">{label}</dt>
              <dd className="mt-1 text-white/80">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex flex-wrap gap-3">
          <LockedButton label="Pause" reason={spendLocked} />
          <LockedButton label="Scale" reason={`${spendLocked} Scaling also needs ${d.guardrails.minConversionsToScale} conversions and ${d.guardrails.minDaysToScale} stable days.`} />
          <LockedButton label="Enable autonomous mode" reason="Requires real campaign history to validate the decision engine first." />
        </div>
      </Panel>
    </>
  );

  const creatives = (
    <>
      <Panel
        title="Generated ads awaiting approval"
        subtitle="every asset is human-reviewed before it can reach an ad account"
        action={<LockedButton label="LAUNCH SELECTED" reason={spendLocked} />}
      >
        {d.pendingApproval.length === 0 ? (
          <Empty>No generated creatives waiting. Concepts appear here once their assets finish rendering.</Empty>
        ) : (
          <ul className="space-y-2">
            {d.pendingApproval.map((c) => (
              <li key={c.creativeId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-xs">
                <div>
                  <span className="font-mono text-white/90">{c.creativeId}</span>
                  <span className="ml-2 text-white/45">{c.hook}</span>
                  <span className="ml-2 rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-white/40">
                    {c.assetsReady}/{c.assetsTotal} assets
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <LockedButton label="Approve" reason="Media pipeline not yet wired to a transport." />
                  <LockedButton label="Reject" reason="Media pipeline not yet wired to a transport." />
                  <LockedButton label="Regenerate" reason="Higgsfield transport not connected to the web runtime." />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Creative library" subtitle={`${d.creatives.length} creative(s) with performance history`}>
          <CreativeTable rows={d.creatives.slice(0, 10)} empty="No Vanta creatives yet." />
        </Panel>

        <Panel
          title="Reference library"
          subtitle={`${d.referenceCount} reference(s) · ${d.patternCount} pattern(s) · ${d.unanalysedReferences} awaiting analysis`}
        >
          {d.references.length === 0 ? (
            <Empty>
              No references yet. Paste TikTok or Reels links with a note — one per line — and they are ingested in bulk.
            </Empty>
          ) : (
            <ul className="space-y-2 text-xs">
              {d.references.slice(0, 8).map((r) => (
                <li key={r.referenceId} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-white/80">{r.company ?? r.sourceUrl ?? r.referenceId}</span>
                    <span className={`font-mono text-[10px] ${r.analysed ? "text-white/35" : "text-[color:var(--accent-gold)]/70"}`}>
                      {r.analysed ? r.platform : "needs analysis"}
                    </span>
                  </div>
                  {r.ownerNote ? <p className="mt-1 text-white/40">{r.ownerNote}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Creative generation" subtitle="briefs balance exploiting known winners against exploring untested territory">
        <Empty>
          No briefs yet. The generator needs evidence before it can exploit anything, and until then every brief
          would be exploration. Higgsfield is disconnected, so nothing can be rendered regardless.
        </Empty>
      </Panel>
    </>
  );

  const performance = (
    <>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Winning creatives" subtitle="ranked by ROAS among creatives that actually spent">
          <CreativeTable rows={d.winners} empty="No creative has spent anything yet." />
        </Panel>
        <Panel title="Losing creatives" subtitle="the money being wasted right now">
          <CreativeTable rows={d.losers} empty="Nothing running, so nothing wasting." />
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Winning patterns" subtitle="attributes associated with better performance — not proven causes">
          <Empty>
            No patterns yet. Attributes become patterns once several independent comparisons point the same way;
            one comparison is an anecdote.
          </Empty>
        </Panel>
        <Panel title="Losing patterns" subtitle="kept permanently — a failed angle is the evidence that stops it being refunded">
          <Empty>Nothing retired yet. Losing creatives stay here forever rather than being deleted.</Empty>
        </Panel>
      </div>

      <Panel title="Attribution" subtitle="platform-reported and first-party, kept apart on purpose">
        <p className="text-xs leading-6 text-white/50">
          TikTok will report more conversions than we can prove, and both figures will be defensible — it counts
          view-through and cross-device using signals we cannot see, while we count only what our consent-gated
          attribution observed end to end. Averaging them would produce a number with no definition, so both are
          stored and the gap is tracked. Our figure is a floor.
        </p>
        <p className="mt-3 text-xs text-white/35">Awaiting TikTok connection — no platform figures to compare yet.</p>
      </Panel>
    </>
  );

  const recommendations = (
    <>
      <Panel title="AI recommendations" subtitle="every one is a recommendation; none execute">
        {d.recommendations.length === 0 ? (
          <Empty>No recommendations. The decision engine needs performance data before it will say anything.</Empty>
        ) : (
          <ul className="space-y-3">
            {d.recommendations.slice(0, 8).map((r) => (
              <li key={r.decisionId} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                <div className="flex items-center gap-2 text-xs">
                  <span className="rounded-full bg-[color:var(--accent-gold)]/15 px-2 py-0.5 font-mono text-[10px] text-[color:var(--accent-gold)]">
                    {r.action}
                  </span>
                  <span className="font-mono text-white/70">{r.creativeId}</span>
                </div>
                <p className="mt-2 text-xs leading-6 text-white/60">{r.rationale}</p>
                {r.unresolvedMetrics.length > 0 ? (
                  <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-white/30">
                    unresolved: {r.unresolvedMetrics.join(", ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="System activity" subtitle="every recommendation, approval and action, append-only">
        <Empty>No activity yet. Nothing in this system has taken an action.</Empty>
      </Panel>
    </>
  );

  const trackingHealth = (
    <>
      <Panel
        title="TikTok tracking health"
        subtitle="checks that were run, not claims about the code — each row says who established it"
      >
        <AdsTrackingHealth />
      </Panel>

      <Panel
        title="Snapchat tracking health"
        subtitle="the check Snapchat's own installation detector cannot perform, because it is never served the pixel"
      >
        <SnapTrackingHealth />
      </Panel>
    </>
  );

  return (
    <main className="mx-auto max-w-7xl space-y-5 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl text-white">Advertising</h1>
          <p className="mt-1 text-xs text-white/40">
            Mode <span className="font-mono text-[color:var(--accent-gold)]">{modeLabel}</span> · nothing on this page can spend money yet
          </p>
        </div>
        <LockedButton label="EMERGENCY STOP" reason="No live campaigns exist. This freezes every action the moment one does." />
      </header>

      <AdsSectionTabs
        sections={[
          { id: "overview", label: "Overview", content: overview },
          { id: "campaigns", label: "Campaigns", content: campaigns },
          { id: "creatives", label: "Creatives", content: creatives },
          { id: "performance", label: "Performance", content: performance },
          { id: "recommendations", label: "Recommendations", content: recommendations },
          { id: "tracking", label: "Tracking Health", content: trackingHealth },
        ]}
      />
    </main>
  );
}
