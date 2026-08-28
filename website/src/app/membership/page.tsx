import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getActiveMembershipTiers } from "@/lib/membership";
import { getBulkSavingsControlConfig } from "@/lib/admin-control";
import { DEFAULT_BULK_SAVINGS_CONFIG } from "@/lib/bulk-savings";
import { MembershipLanding } from "@/components/membership-landing";

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  path: "/membership",
  title: "Membership",
  description:
    "Join Vanta Labs membership for member pricing, priority processing, and exclusive access. Annual and monthly plans available.",
});

export default async function MembershipPage() {
  // "No tiers configured" and "the tier query failed" are different problems
  // with opposite fixes, and swallowing the error into [] made them render
  // identically as "coming soon" -- so an outage on the membership page looked
  // like a deliberate pre-launch state, indefinitely, with nothing logged.
  const [tierResult, user, bulkSavings] = await Promise.all([
    getActiveMembershipTiers().then(
      (data) => ({ ok: true as const, data }),
      (error: unknown) => {
        console.error("Unable to load membership tiers", error);
        return { ok: false as const, data: [] };
      },
    ),
    getAuthenticatedUser(),
    // The bulk-savings panel advertises thresholds and percentages that checkout
    // enforces from this same config, so the page reads it rather than keeping a
    // second hand-written copy. Non-fatal on purpose: the coded default is what
    // getBulkSavingsControlConfig itself falls back to field by field, so a
    // control-table outage shows the standard programme rather than taking the
    // whole membership page down.
    getBulkSavingsControlConfig().catch((error: unknown) => {
      console.error("Unable to load bulk savings config", error);
      return DEFAULT_BULK_SAVINGS_CONFIG;
    }),
  ]);

  const isSignedInCustomer = Boolean(user && detectRoleFromUser(user) === "customer");

  return (
    <div className="vl2-galaxy min-h-screen text-white">
      <SiteHeaderV2 />
      {/* Every other route wraps its content in a main landmark; this one did
          not, so "skip to content" and screen-reader landmark navigation had
          nothing to jump to. */}
      <main>
        <MembershipLanding
          tiers={tierResult.data}
          isSignedInCustomer={isSignedInCustomer}
          loadFailed={!tierResult.ok}
          bulkSavings={bulkSavings}
        />
      </main>
    </div>
  );
}
