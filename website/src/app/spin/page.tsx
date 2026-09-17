import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import SpinWheel, { type WheelPrizeResult, type WheelSlice } from "@/components/spin-wheel";
import { getSpinWheelConfig } from "@/lib/admin-control";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { SPIN_TERMS, describeRedemptionCondition } from "@/lib/spin/disclosure";
import { SPIN_PRIZES } from "@/lib/spin/prize-table";
import { readExistingSpin } from "@/lib/spin/spin-service";
import { verifySpinToken } from "@/lib/spin/spin-token";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Spin to win — Vanta Labs",
  // A prize page has nothing to offer a search engine and a signed link has no
  // business in an index.
  robots: { index: false, follow: false },
};

// ---------------------------------------------------------------------------
// THIS PAGE MINTS NOTHING.
//
// It renders the wheel and, if the visitor has already span, the prize they
// already hold. The draw happens in POST /api/spin, reached only by pressing
// the button — because mail scanners and corporate link rewriters fetch the
// URLs in an email server-side, and a GET that span the wheel would let a
// machine spend the customer's one spin before they ever saw it.
// ---------------------------------------------------------------------------

export default async function SpinPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const config = await getSpinWheelConfig();
  // While the promotion is off the page does not exist. This is the same
  // refusal the route makes, stated twice on purpose: a page that renders a
  // wheel whose endpoint 404s is worse than no page at all.
  if (!config.enabled) notFound();

  const { t } = await searchParams;
  const token = String(t ?? "").trim();
  const verified = token ? await verifySpinToken(token) : null;

  if (!verified || verified.campaignId !== config.campaignId) {
    return <LinkProblem />;
  }

  // A DIFFERENT ACCOUNT SIGNED IN IS A FORWARDED LINK. Say so here rather than
  // letting them press a button that will only refuse them.
  const user = await getAuthenticatedUser();
  const sessionEmail = String(user?.email ?? "").trim().toLowerCase();
  if (sessionEmail && sessionEmail !== verified.email) {
    return <WrongAccount />;
  }

  const existing = await readExistingSpin({
    email: verified.email,
    campaignId: verified.campaignId,
  });

  const slices: WheelSlice[] = SPIN_PRIZES.map((prize) => ({
    id: prize.id,
    wedgeLabel: prize.wedgeLabel,
    label: prize.label,
    minSubtotalCents: prize.minSubtotalCents,
    condition: describeRedemptionCondition(prize),
  }));

  const initialResult: WheelPrizeResult | null = existing
    ? {
        sliceIndex: existing.sliceIndex,
        label: existing.prize.label,
        condition: describeRedemptionCondition(existing.prize),
        minSubtotalCents: existing.prize.minSubtotalCents,
        // The stored instant, so the countdown resumes where it really is
        // rather than restarting at 72 hours on every visit.
        expiresAt: existing.expiresAt,
        alreadySpun: true,
      }
    : null;

  return <SpinWheel slices={slices} terms={SPIN_TERMS} token={token} initialResult={initialResult} />;
}

function LinkProblem() {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-20 text-center">
      <h1 className="text-xl font-semibold">This link is no longer valid</h1>
      <p className="mt-3 text-sm" style={{ color: "var(--foreground-muted)" }}>
        Spin links expire, and each one works only for the campaign it was sent for.
        If you think this one should still work, reply to the email you received and we&apos;ll sort it out.
      </p>
      <Link
        href="/products"
        className="mt-6 inline-block rounded-lg px-5 py-3 text-sm font-semibold"
        style={{ background: "#c7ae5e", color: "#0a0a0a" }}
      >
        Browse the catalogue
      </Link>
    </div>
  );
}

function WrongAccount() {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-20 text-center">
      <h1 className="text-xl font-semibold">This link belongs to a different account</h1>
      <p className="mt-3 text-sm" style={{ color: "var(--foreground-muted)" }}>
        You&apos;re signed in as someone else. Sign out and open the link again, or open the
        link that was sent to the address you&apos;re signed in with — a prize has to be
        attached to the account that will check out with it.
      </p>
      <a
        href="/account"
        className="mt-6 inline-block rounded-lg px-5 py-3 text-sm font-semibold" style={{ background: "#c7ae5e", color: "#0a0a0a" }}
      >
        Go to my account
      </a>
    </div>
  );
}
