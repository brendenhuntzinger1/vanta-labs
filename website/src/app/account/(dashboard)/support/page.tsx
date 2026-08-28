import Link from "next/link";
import { redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { POINTS_PER_DOLLAR_REDEMPTION } from "@/lib/points-math";

export const dynamic = "force-dynamic";

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "Where is my order? How do I track it?",
    a: "Open Orders, tap any order, and you'll see live tracking with the carrier and a tracking link once it ships. You can also reorder or download an invoice from there.",
  },
  {
    q: "How do points and rewards work?",
    a: `You earn points on every paid order at your membership's earn rate. ${POINTS_PER_DOLLAR_REDEMPTION} points equals $1 off, applied automatically at checkout. See your balance and history under Rewards.`,
  },
  {
    q: "How do I cancel or change my membership?",
    a: "Go to Subscription. You can change your plan any time, or cancel to stop future billing while keeping your benefits until the end of the period you already paid for.",
  },
  {
    q: "Where are the Certificates of Analysis (COAs)?",
    a: "Every batch is third-party tested. Our COA library is being finalized — in the meantime, contact us and we'll send the specific COA you need.",
  },
  {
    q: "What is your return policy?",
    a: "Products are sold for laboratory and research use only. See our Return & Reimbursement Policy for full details, or reach out below and we'll help.",
  },
];

export default async function AccountSupportPage() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect("/account/login");
  }

  const supportEmail = "support@vantalabsresearch.com";
  const mailto = `mailto:${supportEmail}?subject=${encodeURIComponent("Support request")}&body=${encodeURIComponent(`\n\n— Account: ${user.email ?? ""}`)}`;

  return (
    <div className="space-y-5">
      <header className="vl-fade-up">
        <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Account</p>
        <h1 className="vl2-serif mt-1.5 text-3xl text-white sm:text-4xl">Support</h1>
        <p className="mt-2 text-sm text-zinc-400">We&apos;re here to help — most messages get a reply within one business day.</p>
      </header>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <a href={mailto} className="vl-focus-ring group rounded-xl border border-white/10 bg-white/[0.02] p-5 transition-colors duration-200 hover:border-white/25">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/12 bg-white/[0.04] text-cyan-200">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
                <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 7 8.5 6 8.5-6" />
              </svg>
            </div>
            <p className="mt-3 text-sm font-semibold text-white">Email support</p>
            <p className="mt-1 text-xs text-zinc-500">{supportEmail}</p>
          </a>
          <Link href="/contact" className="vl-focus-ring group rounded-xl border border-white/10 bg-white/[0.02] p-5 transition-colors duration-200 hover:border-white/25">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/12 bg-white/[0.04] text-cyan-200">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
                <path d="M4 5h16v11H8l-4 4z" />
              </svg>
            </div>
            <p className="mt-3 text-sm font-semibold text-white">Contact form</p>
            <p className="mt-1 text-xs text-zinc-500">Send us a detailed message</p>
          </Link>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 border-t border-white/10 pt-4 text-xs">
          <Link href="/account/orders" className="rounded-full border border-white/12 bg-white/[0.03] px-3 py-1.5 text-zinc-300 transition hover:border-white/25 hover:text-white">Order help</Link>
          <Link href="/account/subscriptions" className="rounded-full border border-white/12 bg-white/[0.03] px-3 py-1.5 text-zinc-300 transition hover:border-white/25 hover:text-white">Membership &amp; billing</Link>
          <Link href="/coa-library" className="rounded-full border border-white/12 bg-white/[0.03] px-3 py-1.5 text-zinc-300 transition hover:border-white/25 hover:text-white">COAs</Link>
          <Link href="/legal/refund" className="rounded-full border border-white/12 bg-white/[0.03] px-3 py-1.5 text-zinc-300 transition hover:border-white/25 hover:text-white">Returns</Link>
        </div>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Frequently asked</h2>
        <div className="mt-3 divide-y divide-white/10">
          {FAQ.map((item) => (
            <details key={item.q} className="group py-3">
              <summary className="vl-focus-ring flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-zinc-200 transition-colors hover:text-white">
                {item.q}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200 group-open:rotate-180" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </summary>
              <p className="mt-2 text-sm leading-6 text-zinc-400">{item.a}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
