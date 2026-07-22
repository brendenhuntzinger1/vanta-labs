import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { getAmbassadorProgramSettings } from "@/lib/ambassador-settings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Ambassador Terms & Conditions",
  description: "The rules of the Vanta Labs Ambassador program: commissions, payouts, posting requirements, discounts, and removal policy.",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="vl2-serif text-xl text-white">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-7 text-white/70">{children}</div>
    </section>
  );
}

export default async function AmbassadorTermsPage() {
  const settings = await getAmbassadorProgramSettings().catch(() => null);
  const posts = settings?.monthlyPostRequirement ?? 3;
  const commission = 10;
  const discount = settings?.ambassadorDiscountPercent ?? 15;
  const creditMultiplier = settings?.storeCreditMultiplierPercent ?? 125;

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      <main className="mx-auto max-w-3xl px-6 pb-24 pt-32 lg:px-12">
        <p className="vl2-eyebrow">Ambassador Program</p>
        <h1 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">Terms &amp; Conditions</h1>
        <p className="mt-2 text-xs text-white/40">Please read these terms carefully. By participating you agree to them.</p>

        <div className="mt-6 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4 text-sm leading-7 text-amber-100">
          <strong>Minimum requirement: publish at least {posts} promotional posts, videos, or advertisements per month featuring Vanta Labs</strong> to remain an active ambassador and keep your perks.
        </div>

        <Section title="Benefits">
          <ul className="list-disc space-y-1 pl-5">
            <li><strong>{commission}% commission</strong> on every order placed with your referral code.</li>
            <li><strong>{discount}% off your own orders</strong> (you do not earn commission on your own orders).</li>
            <li>Choose <strong>cash</strong> payouts or <strong>store credit worth {creditMultiplier}%</strong> of your earnings.</li>
            <li>A <strong>monthly bonus</strong> for the top-selling ambassador.</li>
            <li>A real-time dashboard, personal referral link, and marketing resources.</li>
          </ul>
        </Section>

        <Section title="Commission rules">
          <p>Commission is calculated on the order subtotal <strong>after all customer discounts</strong> have been applied, excluding shipping, handling, taxes, and processing fees.</p>
          <p>Orders must meet the minimum qualifying order amount to earn a commission. Commission is <strong>never paid</strong> on cancelled, refunded, charged-back, or fraudulent orders. Commissions flagged for review are held until cleared by an administrator.</p>
        </Section>

        <Section title="Payment schedule">
          <p>Approved commissions are held for a short return window, then become eligible for payout. Payouts are processed on a biweekly basis once your cleared balance reaches the minimum payout threshold shown in your dashboard.</p>
        </Section>

        <Section title="Store credit payout">
          <p>You may choose to receive your earnings as store credit instead of cash. Store credit is worth <strong>{creditMultiplier}%</strong> of the cash amount, <strong>never expires</strong>, and can be spent at checkout on your own orders. Store credit is non-transferable and has no cash value.</p>
        </Section>

        <Section title="Cash payout">
          <p>Cash payouts are sent to your designated payment account on the biweekly schedule. You are responsible for any taxes owed on commissions and bonuses you receive.</p>
        </Section>

        <Section title="Referral rules">
          <p>Your referral code gives your audience a discount and earns you commission on their orders. You <strong>may not use your own referral code</strong> on your own orders under any circumstance. Self-referral, fake orders, and other abuse are prohibited and will void the associated commissions.</p>
        </Section>

        <Section title="Discount rules">
          <p>Only one percentage-based discount applies per order (membership, ambassador, referral, coupon, or promotional discount) — the one giving the greatest savings applies automatically unless an administrator has enabled specific combinations. Automatic promotions such as Buy 3 Get 1 Free are promotional rules, not coupon codes.</p>
        </Section>

        <Section title="Violations">
          <p>The following may result in suspension or removal from the program: falling below the monthly posting minimum; self-referral or fraudulent orders; misrepresenting Vanta Labs or its products; making prohibited medical or human-use claims; or any activity that harms the brand or violates applicable law.</p>
        </Section>

        <Section title="Removal policy">
          <p>Vanta Labs may adjust, suspend, or remove an ambassador at its discretion, including for the violations above. Upon removal, unpaid eligible commissions already earned on valid orders will be honored; pending or flagged commissions may be voided. Program terms, rates, and requirements may change with notice.</p>
        </Section>

        <div className="mt-10 flex gap-4 text-sm">
          <Link href="/ambassador" className="text-white/60 underline underline-offset-4 hover:text-white">← Ambassador program</Link>
          <Link href="/ambassador/faq" className="text-white/60 underline underline-offset-4 hover:text-white">Read the FAQ →</Link>
        </div>

        <div className="mt-8 rounded-xl border border-white/10 bg-white/[0.02] p-5 text-xs leading-6 text-white/45">
          Vanta Labs products are sold for laboratory research use only — not for human or animal consumption. Ambassadors must not make medical, therapeutic, or human-use claims.
        </div>
      </main>
    </div>
  );
}
