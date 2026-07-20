import { redirect } from "next/navigation";
import { AdminCouponsClient } from "@/components/admin-coupons-client";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageCoupons } from "@/lib/admin-roles";
import { listAdminCoupons } from "@/lib/admin-coupons";

export const dynamic = "force-dynamic";

export default async function AdminCouponsPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const canManage = canManageCoupons(session.role);
  const coupons = canManage ? await listAdminCoupons() : [];

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.1),transparent_52%),linear-gradient(145deg,#04060f_0%,#0b1324_50%,#060911_100%)] px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Admin Portal</p>
          <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Coupons</h1>
          <p className="mt-3 max-w-3xl text-sm text-zinc-400 sm:text-base">
            Create and manage discount codes. Applied automatically at checkout when a shopper enters a valid,
            active code — mutually exclusive with referral codes and the Buy 3 Get 1 Free promotion.
          </p>
        </section>

        {canManage ? (
          <AdminCouponsClient initialCoupons={coupons} />
        ) : (
          <section className="vl-panel rounded-2xl p-6 text-sm text-zinc-300">
            Your role ({session.role.replace("_", " ")}) does not have permission to manage coupons. Ask a manager or
            super admin for access.
          </section>
        )}
      </div>
    </div>
  );
}
