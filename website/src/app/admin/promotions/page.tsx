import { redirect } from "next/navigation";
import { AdminPromotionsClient } from "@/components/admin-promotions-client";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { getHomepageControlConfig } from "@/lib/admin-control";
import { getPromotionRules } from "@/lib/promotion-rules";
import { DEFAULT_PROMOTION_RULES } from "@/lib/promotion-engine";

export const dynamic = "force-dynamic";

export default async function AdminPromotionsPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const canManage = canManageSettings(session.role);
  const config = canManage ? await getHomepageControlConfig().catch(() => ({})) : {};
  const rules = canManage ? await getPromotionRules().catch(() => DEFAULT_PROMOTION_RULES) : DEFAULT_PROMOTION_RULES;

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.1),transparent_52%),linear-gradient(145deg,#04060f_0%,#0b1324_50%,#060911_100%)] px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Admin Portal</p>
          <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Promotions</h1>
          <p className="mt-3 max-w-3xl text-sm text-zinc-400 sm:text-base">
            Turn store-wide promotions on or off. Changes go live instantly across the site — no coupon code needed.
          </p>
        </section>

        {canManage ? (
          <AdminPromotionsClient initialBuy3Get1Enabled={Boolean((config as { promoBuy3Get1Enabled?: boolean }).promoBuy3Get1Enabled)} initialRules={rules} />
        ) : (
          <section className="vl-panel rounded-2xl p-6 text-sm text-zinc-300">
            Your role ({session.role.replace("_", " ")}) does not have permission to manage promotions. Ask a manager or
            super admin for access.
          </section>
        )}
      </div>
    </div>
  );
}
