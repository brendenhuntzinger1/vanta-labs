import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import SpinWheel, { type WheelPrizeOdds, type WheelPrizeResult, type WheelSlice } from "@/components/spin-wheel";
import { SpinWrongAccount } from "@/components/spin-wrong-account";
import { getSpinWheelConfig } from "@/lib/admin-control";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { SPIN_TERMS, describeExactCondition, describeRedemptionCondition, spinOdds } from "@/lib/spin/disclosure";
import { SPIN_PRIZES } from "@/lib/spin/prize-table";
import { availableDoseRungs } from "@/lib/spin/spin-dose";
import { readExistingSpin } from "@/lib/spin/spin-service";
import { signSpinToken, verifySpinToken } from "@/lib/spin/spin-token";

export const dynamic = "force-dynamic";

/**
 * The wedges drawn in gold.
 *
 * Purely visual, and kept here rather than in the prize table because it is a
 * statement about the LOOK of the wheel, not about what the till honours — the
 * two must never be confused, and a "premium" flag inside SPIN_PRIZES would
 * eventually be read as one.
 */
// Shared with the invitation's preview — see lib/spin/wheel-geometry.ts.
import { PREMIUM_PRIZE_IDS } from "@/lib/spin/wheel-geometry";

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
  const supplied = String(t ?? "").trim();
  const verified = supplied ? await verifySpinToken(supplied) : null;
  // A token for a PREVIOUS campaign is genuine and useless: the campaign is
  // inside the signature, so it cannot be forged, but honouring it would let
  // somebody spin a promotion they were never mailed.
  const mailed = verified && verified.campaignId === config.campaignId ? verified : null;

  const user = await getAuthenticatedUser();
  const sessionEmail = String(user?.email ?? "").trim().toLowerCase();

  // A DIFFERENT ACCOUNT SIGNED IN IS A FORWARDED LINK. Say so here rather than
  // letting them press a button that will only refuse them. Only a link that
  // is otherwise good raises this: a stale or forged one grants nothing, so
  // there is nothing for the two identities to disagree about.
  if (mailed && sessionEmail && sessionEmail !== mailed.email) {
    // The token, so the button can come straight back here once the session is
    // gone — see spin-wrong-account.tsx.
    return <SpinWrongAccount spinHref={`/spin?t=${encodeURIComponent(supplied)}`} />;
  }

  // THE STOREFRONT'S OWN WAY IN.
  //
  // The wheel began as the thing a win-back email linked to, so the only way
  // to reach it was a token minted at click time for a VERIFIED recipient. It
  // is now the store's acquisition offer as well, and the invitation that
  // carries it opens on a product page rather than in an inbox — where there
  // is no email click to verify anybody.
  //
  // A SESSION IS THE SAME CALIBRE OF PROOF, and the route already says so: the
  // wrong-account refusal above treats a signed-in address as the STRONGER
  // claim and refuses the token when the two disagree. Signing the session's
  // own address is therefore not a new trust, it is the one already in use —
  // and it is the only address this branch will ever sign, so nobody can mint
  // a spin for anyone but themselves.
  //
  // Nothing downstream changes shape. One spin per address per campaign still
  // comes from the offer row's unique index, not from how the visitor arrived,
  // so a shopper who spins from the storefront and then opens their email
  // finds the prize they already hold rather than a second draw.
  const token = mailed ? supplied : sessionEmail ? await signSpinToken(sessionEmail, config.campaignId) : null;
  const email = mailed ? mailed.email : sessionEmail;
  // No usable link and no session, or a secret this deploy cannot sign with.
  if (!token || !email) return <LinkProblem />;

  const existing = await readExistingSpin({
    email,
    campaignId: config.campaignId,
  });

  // THE WHEEL and THE PRIZE LIST are different lengths on purpose: sixteen
  // wedges, fewer distinct prizes, because one reward sits on two wedges.
  const slices: WheelSlice[] = SPIN_PRIZES.map((prize) => ({
    id: prize.id,
    wedgeLabel: prize.wedgeLabel,
    label: prize.label,
    minSubtotalCents: prize.minSubtotalCents,
    condition: describeRedemptionCondition(prize),
    // The figure, kept on the page under "Full terms" rather than removed.
    exactCondition: describeExactCondition(prize),
    // The two wedges worth over $100 are filled gold, so the jackpot is
    // visible before anyone reads a label.
    premium: PREMIUM_PRIZE_IDS.has(prize.id),
  }));

  // One row per PRIZE with its real odds — a reward on two wedges is one row
  // at "2 in 16", not two rows each claiming "1 in 16".
  const prizes: WheelPrizeOdds[] = spinOdds().map((entry) => ({
    id: entry.prize.id,
    label: entry.prize.label,
    condition: describeRedemptionCondition(entry.prize),
    exactCondition: describeExactCondition(entry.prize),
    wedges: entry.wedges,
    outOf: entry.outOf,
    premium: PREMIUM_PRIZE_IDS.has(entry.prize.id),
  }));

  // THE SIZES THIS WINNER CAN STILL TAKE, resolved against the live catalogue
  // rather than the prize table. A rung whose strength has been retired is not
  // offered at all: showing it greyed out would be advertising something the
  // till is going to refuse.
  const doseRungs = existing ? await availableDoseRungs(existing.prize) : [];
  const chosenDose = existing?.variantId
    ? doseRungs.find((rung) => rung.variantId === existing.variantId)?.label ?? null
    : null;

  const initialResult: WheelPrizeResult | null = existing
    ? {
        sliceIndex: existing.sliceIndex,
        label: existing.prize.label,
        condition: describeRedemptionCondition(existing.prize),
        // THE ROW, NOT THE TABLE. `slices` above may say $90 because that is
        // the entry rung every visitor sees before spinning; this winner may
        // have chosen the 30mg and owe $170. The till enforces the row, so the
        // panel must quote the row or the wheel advertises a condition
        // checkout will refuse.
        minSubtotalCents: existing.minSubtotalCents,
        // The stored instant, so the countdown resumes where it really is
        // rather than restarting at 72 hours on every visit.
        expiresAt: existing.expiresAt,
        alreadySpun: true,
        // Already spent on an order. The panel says so instead of offering a
        // countdown and a "Start shopping" button for a reward that is gone.
        redeemed: existing.redeemed,
        doses: doseRungs.map((rung) => ({ label: rung.label, minSubtotalCents: rung.minSubtotalCents })),
        chosenDose,
      }
    : null;

  return <SpinWheel slices={slices} prizes={prizes} terms={SPIN_TERMS} token={token} initialResult={initialResult} />;
}

function LinkProblem() {
  return (
    // A `main`, for the same reason the wheel itself is one: this is the whole
    // page when a link has expired, and a page with no main landmark is a page
    // a screen-reader visitor cannot jump into.
    <main className="mx-auto w-full max-w-md px-4 py-20 text-center">
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
    </main>
  );
}

