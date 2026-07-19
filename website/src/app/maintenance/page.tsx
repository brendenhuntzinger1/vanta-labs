import Link from "next/link";

export const dynamic = "force-dynamic";

export default function MaintenancePage() {
  return (
    <main className="vl-page-shell min-h-screen px-4 py-16 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl">
        <section className="vl-panel rounded-[1.9rem] border border-white/20 p-8 text-center sm:p-10">
          <p className="text-[11px] uppercase tracking-[0.3em] text-zinc-500">Vanta Labs</p>
          <h1 className="mt-4 text-3xl font-semibold text-white sm:text-4xl">Scheduled Maintenance In Progress</h1>
          <p className="mt-4 text-sm text-zinc-300 sm:text-base">
            We are making improvements and will be back shortly. Thank you for your patience.
          </p>
          <p className="mt-2 text-xs text-zinc-500">
            If you are an administrator, use secure access to continue managing the store.
          </p>
          <div className="mt-7">
            <Link href="/vault" className="vl-btn-secondary px-5 py-2 text-xs uppercase tracking-[0.2em]">
              Admin Access
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
