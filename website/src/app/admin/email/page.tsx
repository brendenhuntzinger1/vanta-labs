import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { getEmailDashboard, loadSubscriberDirectory } from "@/lib/admin-email";
import { loadAutomations } from "@/lib/email/automations";
import { loadAutomationStats, parseStatsRange, emptyAutomationStatsReport } from "@/lib/email/automation-stats";
import { LifecycleFunnelTable } from "@/components/lifecycle-funnel-table";
import { emptyLifecycleFunnel, getLifecycleFunnel } from "@/lib/email/lifecycle-funnel-report";
import { funnelWindowFor } from "@/lib/email/lifecycle-funnel";
import { funnelWindowLinks } from "@/lib/email/lifecycle-funnel-links";
import { OFFER_CATALOG } from "@/lib/offers/customer-offers";
import { getEmailAdminSettings } from "@/lib/email/settings";
import { CAMPAIGN_SEGMENTS } from "@/lib/email/audience";
import { AdminEmailClient } from "@/components/admin-email-client";
import { AdminSendLedger } from "@/components/admin-send-ledger";
import { emptySendLedger, loadSendLedger } from "@/lib/email/send-ledger";
import { supabaseAdmin } from "@/lib/supabase-server";
import AdminWheelPanel from "@/components/admin-wheel-panel";
import { getSpinWheelConfig } from "@/lib/admin-control";
import { SPIN_PRIZES, SPIN_TTL_DAYS } from "@/lib/spin/prize-table";
import { getSpinCampaignResults, listSpinCampaignIds } from "@/lib/spin/spin-results";

export const dynamic = "force-dynamic";

/**
 * The products a campaign gift may hand out.
 *
 * Only what is genuinely purchasable, and the filters are the same four
 * getCatalogProductsBySlugs applies — because a gift naming anything else
 * resolves to nothing at the till, and quoteOrder's exact-slug match has no
 * fallback to notice. The operator picks from this list rather than typing a
 * slug, which is what stops the class of bug that shipped a percentage and no
 * vial for weeks after a rename.
 *
 * Non-fatal: a failed read shows an empty product list, so the catalogue gifts
 * and the percentage-only custom gifts still work.
 */
async function loadGiftProducts(): Promise<Array<{ slug: string; name: string }>> {
  try {
    const { data } = await supabaseAdmin
      .from("products")
      .select("slug, name")
      .eq("is_active", true)
      .eq("is_enabled", true)
      .eq("is_published", true)
      .eq("is_archived", false)
      .order("name");
    return (data ?? [])
      .map((row) => ({ slug: String(row.slug ?? ""), name: String(row.name ?? row.slug ?? "") }))
      .filter((row) => row.slug);
  } catch {
    return [];
  }
}

/**
 * Live stock for each prize's product, read the way quoteOrder reads it.
 *
 * The gift resolves to the DEFAULT DOSE when the offer carries no variant, and
 * that is where the stock actually lives — every prize product's parent row
 * reads zero. Counting the parent would report every prize as out of stock and
 * the warning would be ignored within a day.
 *
 * null means untracked, which is unlimited as far as the storefront is
 * concerned. A failed read returns an empty map and the panel prints nothing
 * rather than a zero it cannot stand behind.
 */
async function loadPrizeStock(): Promise<Record<string, number | null>> {
  const slugs = Array.from(new Set(
    SPIN_PRIZES.map((prize) => (prize.reward.kind === "free_product" ? prize.reward.productSlug : null)).filter((s): s is string => Boolean(s)),
  ));
  if (slugs.length === 0) return {};
  try {
    const { data: products } = await supabaseAdmin.from("products").select("id, slug").in("slug", slugs);
    const byId = new Map<string, string>();
    for (const row of (products ?? []) as Array<{ id: string; slug: string }>) byId.set(row.id, row.slug);
    if (byId.size === 0) return {};
    const { data: doses } = await supabaseAdmin
      .from("product_doses")
      .select("product_id, inventory_quantity, track_inventory, is_default, position")
      .in("product_id", Array.from(byId.keys()));
    const chosen = new Map<string, { position: number; qty: number | null }>();
    for (const row of (doses ?? []) as Array<{ product_id: string; inventory_quantity: number | null; track_inventory: boolean | null; is_default: boolean | null; position: number | null }>) {
      const slug = byId.get(row.product_id);
      if (!slug) continue;
      // Default first, else lowest position — the same choice quoteOrder makes.
      const rank = row.is_default ? -1 : Number(row.position ?? 999);
      const current = chosen.get(slug);
      if (current && current.position <= rank) continue;
      chosen.set(slug, { position: rank, qty: row.track_inventory === true ? Math.max(0, Number(row.inventory_quantity ?? 0)) : null });
    }
    const out: Record<string, number | null> = {};
    for (const [slug, value] of chosen) out[slug] = value.qty;
    return out;
  } catch {
    return {};
  }
}

async function loadCategories(): Promise<string[]> {
  try {
    const { data } = await supabaseAdmin.from("products").select("category").not("category", "is", null);
    const categories = new Set((data ?? []).map((row) => String(row.category ?? "")).filter(Boolean));
    return Array.from(categories).sort();
  } catch {
    return [];
  }
}

export default async function AdminEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const canManage = canManageEmailCampaigns(session.role);
  // The automations panel's reporting window (?range=7d|30d|90d|all). Sends,
  // clicks, orders and gifts are all measured inside the same window.
  const params = await searchParams;
  const funnelWindow = funnelWindowFor(params.window);
  const statsRange = parseStatsRange(Array.isArray(params.range) ? params.range[0] : params.range);

  // Every load is independently fault-tolerant: a campaign system that can't
  // render because one query failed is worse than one showing partial data.
  const emptyDirectory = { rows: [], counts: { subscribed: 0, unsubscribed: 0, bounced: 0, complained: 0 }, truncated: false };
  const [dashboard, automations, automationStats, emailSettings, categories, giftProducts, subscriberDirectory, sendLedger, funnel] = canManage
    ? await Promise.all([
        getEmailDashboard().catch(() => ({ subscribers: 0, campaigns: [], totals: { sent: 0, opened: 0, clicked: 0, orders: 0, revenue: 0 } })),
        loadAutomations().catch(() => []),
        // loadAutomationStats never rejects — an operator locked out of editing
        // their copy because a reporting query failed is a worse outcome than
        // one looking at zeroes — and it never hides a failure either: a read
        // that fails comes back ok:false and the panel says so instead of
        // showing zeroes. The catch stays for symmetry with the rest of this list.
        loadAutomationStats(statsRange).catch((error: unknown) =>
          emptyAutomationStatsReport(statsRange, error instanceof Error ? error.message : String(error))),
        getEmailAdminSettings().catch(() => null),
        loadCategories(),
        loadGiftProducts(),
        loadSubscriberDirectory(),
        // Never rejects on its own; the catch keeps one failed read from taking
        // the whole page down, exactly like every other load in this list.
        loadSendLedger().catch((error: unknown) =>
          emptySendLedger(error instanceof Error ? error.message : String(error))),
        getLifecycleFunnel(funnelWindow).catch((error: unknown) => emptyLifecycleFunnel(funnelWindow, error instanceof Error ? error.message : String(error))),
      ])
    : [{ subscribers: 0, campaigns: [], totals: { sent: 0, opened: 0, clicked: 0, orders: 0, revenue: 0 } }, [], emptyAutomationStatsReport(statsRange), null, [], [], emptyDirectory, emptySendLedger(), emptyLifecycleFunnel(funnelWindow)];

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.1),transparent_52%),linear-gradient(145deg,#04060f_0%,#0b1324_50%,#060911_100%)] px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Admin Portal</p>
          <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Email Marketing</h1>
          <p className="mt-3 max-w-3xl text-sm text-zinc-400 sm:text-base">
            Compose a campaign, pick who receives it, and send. Only customers who opted into marketing are ever
            included, and anyone who unsubscribes is removed automatically — order receipts and shipping notices
            are unaffected either way.
          </p>
        </section>

        {canManage ? (
          <AdminEmailClient
            dashboard={dashboard}
            automations={automations}
            automationStats={automationStats}
            offerChoices={Object.entries(OFFER_CATALOG).map(([key, value]) => ({ key, label: value.label }))}
            segments={CAMPAIGN_SEGMENTS}
            giftProducts={giftProducts}
            categories={categories}
            postalAddressSet={Boolean(emailSettings?.marketingPostalAddress)}
            emailReady={emailSettings?.ready ?? false}
            emailEnabled={emailSettings?.enabled ?? false}
            subscriberDirectory={subscriberDirectory}
          />
        ) : (
          <section className="vl-panel rounded-[1.8rem] p-6">
            <p className="text-sm text-zinc-400">Your role does not have permission to manage email campaigns.</p>
          </section>
        )}
        {canManage ? <WheelPanelSection /> : null}
        {canManage ? <LifecycleFunnelTable report={funnel} windows={funnelWindowLinks("/admin/email", params, funnelWindow.key)} /> : null}

        {/* Below the composer, because it answers a question about mail that has
            already gone out rather than mail about to. */}
        {canManage ? <AdminSendLedger ledger={sendLedger} /> : null}
      </div>
    </div>
  );
}

/**
 * The wheel panel, loaded in its own async component.
 *
 * Separate from the page's Promise.all so a slow results read delays the wheel
 * card and nothing else — the composer above it is what the operator opens this
 * screen for.
 */
async function WheelPanelSection() {
  const config = await getSpinWheelConfig();
  const [results, knownCampaignIds, stockBySlug] = await Promise.all([
    getSpinCampaignResults(config.campaignId),
    listSpinCampaignIds(),
    loadPrizeStock(),
  ]);
  return (
    <AdminWheelPanel
      enabled={config.enabled}
      campaignId={config.campaignId}
      results={results}
      knownCampaignIds={knownCampaignIds}
      stockBySlug={stockBySlug}
      ttlDays={SPIN_TTL_DAYS}
      prizes={SPIN_PRIZES.map((prize) => ({
        id: prize.id,
        label: prize.label,
        wedgeLabel: prize.wedgeLabel,
        minSubtotalCents: prize.minSubtotalCents,
        rewardKind: prize.reward.kind,
        productSlug: prize.reward.kind === "free_product" ? prize.reward.productSlug : null,
        percent: prize.reward.kind === "percent" ? prize.reward.percent : null,
        maxDiscountCents: prize.maxDiscountCents ?? null,
      }))}
    />
  );
}
