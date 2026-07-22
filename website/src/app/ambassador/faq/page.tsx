import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { getAmbassadorProgramSettings } from "@/lib/ambassador-settings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Ambassador FAQ",
  description: "Frequently asked questions about the Vanta Labs Ambassador program — commissions, payouts, store credit, and requirements.",
};

export default async function AmbassadorFaqPage() {
  const settings = await getAmbassadorProgramSettings().catch(() => null);
  const posts = settings?.monthlyPostRequirement ?? 3;
  const discount = settings?.ambassadorDiscountPercent ?? 15;
  const creditMultiplier = settings?.storeCreditMultiplierPercent ?? 125;

  const faqs: Array<{ q: string; a: React.ReactNode }> = [
    { q: "How much do I earn?", a: <>You earn 10% commission on every order placed with your referral code, calculated after the customer&apos;s discount.</> },
    { q: "How often will I get paid?", a: <>Commissions clear after a short return window and are paid biweekly once your cleared balance reaches the minimum payout threshold.</> },
    { q: "Can I take my earnings as store credit?", a: <>Yes. Choose store credit in your dashboard and your earnings are worth <strong>{creditMultiplier}%</strong> as non-expiring store credit you can spend on your own orders.</> },
    { q: "Do I get a discount on my own orders?", a: <>Yes — approved ambassadors automatically get <strong>{discount}% off</strong> their own orders when signed in. You do not earn commission on your own orders.</> },
    { q: "Can I use my own referral code?", a: <>No. You cannot use your own referral code on your own orders under any circumstance — you get the ambassador discount instead.</> },
    { q: "What are the posting requirements?", a: <><strong>You must publish at least {posts} promotional posts, videos, or advertisements per month featuring Vanta Labs</strong> to stay active and keep your perks.</> },
    { q: "Do discounts stack?", a: <>Only one percentage discount applies per order (the greatest savings wins) unless an administrator enables specific combinations. Automatic promotions like Buy 3 Get 1 Free are not coupon codes.</> },
    { q: "When don&apos;t I earn commission?", a: <>No commission is paid on cancelled, refunded, charged-back, or fraudulent orders, or on your own purchases.</> },
    { q: "How does the monthly bonus work?", a: <>The top-selling ambassador each month earns a bonus, awarded as cash or store credit at the team&apos;s discretion.</> },
    { q: "Can I be removed from the program?", a: <>Yes — see the Terms &amp; Conditions for the violations and removal policy. Falling below the monthly posting minimum or self-referral/fraud can lead to removal.</> },
  ];

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      <main className="mx-auto max-w-3xl px-6 pb-24 pt-32 lg:px-12">
        <p className="vl2-eyebrow">Ambassador Program</p>
        <h1 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">Frequently Asked Questions</h1>

        <div className="mt-6 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4 text-sm leading-7 text-amber-100">
          <strong>Minimum requirement: publish at least {posts} promotional posts, videos, or advertisements per month featuring Vanta Labs.</strong>
        </div>

        <div className="mt-8 space-y-3">
          {faqs.map((faq, index) => (
            <details key={index} className="group rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <summary className="cursor-pointer list-none text-sm font-semibold text-white">{faq.q}</summary>
              <p className="mt-2 text-sm leading-7 text-white/70">{faq.a}</p>
            </details>
          ))}
        </div>

        <div className="mt-10 flex gap-4 text-sm">
          <Link href="/ambassador" className="text-white/60 underline underline-offset-4 hover:text-white">← Ambassador program</Link>
          <Link href="/ambassador/terms" className="text-white/60 underline underline-offset-4 hover:text-white">Read the Terms →</Link>
        </div>
      </main>
    </div>
  );
}
