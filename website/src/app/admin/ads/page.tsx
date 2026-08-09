import Link from "next/link";
import { getAdsDashboard, type CreativeRow } from "@/lib/ads/dashboard-data";
import { AdsSectionTabs } from "@/components/ads-section-tabs";
import { AdsTrackingHealth } from "@/components/ads-tracking-health";
import { AdsCampaignsPanel } from "@/components/ads-campaigns-panel";

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
  const d = await getAdsDashboard();
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

      <Panel title="Today" subtitle={d.schemaReady ? "UTC day, site-attributed revenue net of refunds" : "no data source yet"}>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            ["Spend", money(d.today.spend)],
            ["Revenue", money(d.today.revenue)],
            ["Purchases", String(d.today.purchases)],
            ["CPA", d.today.cpa === null ? "—" : money(d.today.cpa)],
            ["ROAS", ratio(d.today.roas)],
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
    <Panel
      title="Tracking health"
      subtitle="checks that were run, not claims about the code — each row says who established it"
    >
      <AdsTrackingHealth />
    </Panel>
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
