import Link from "next/link";

export default function PartnerPendingPage() {
  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.08),transparent_56%),linear-gradient(150deg,#050505_0%,#111111_50%,#070707_100%)] px-4 py-12 text-zinc-100 sm:px-6 lg:px-8">
      <div className="vl-panel mx-auto max-w-2xl rounded-[2rem] p-8 text-center">
        <p className="text-xs uppercase tracking-[0.34em] text-zinc-300">Application Received</p>
        <h1 className="mt-3 text-3xl font-semibold text-white sm:text-4xl">Pending Approval</h1>
        <p className="mt-4 text-sm text-zinc-300 sm:text-base">
          Your partner account is currently under review. You will gain access to the affiliate dashboard as soon as your application is approved.
        </p>
        <p className="mt-3 text-sm text-zinc-500">
          While waiting, you can still browse products and prepare content for your launch.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/products" className="vl-btn-secondary rounded-full px-6 py-3 text-sm">Browse Products</Link>
          <Link href="/partner" className="vl-focus-ring rounded-full bg-gradient-to-r from-white to-zinc-300 px-6 py-3 text-sm font-semibold text-zinc-950">Back to Partner Program</Link>
        </div>
      </div>
    </div>
  );
}
