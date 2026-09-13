import type { Metadata } from "next";
import { verifyAttestationHandoff } from "@/lib/email/attestation-handoff";
import { emailGrantAllowsPath } from "@/lib/email/link-grant";
import { AttestationForm } from "@/components/attestation-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirm to continue",
  description: "Confirm the two statements required to view the Vanta Labs research catalogue.",
  robots: { index: false, follow: false },
};

/**
 * THE STEP THAT USED TO BE A DEAD END.
 *
 * A lapsed customer who never made the 21+ and research-use representations
 * clicked a genuine win-back, holding a real minted gift, and met "Sign in to
 * continue" — for an account they may not even have. The gift was real, the
 * message was real, and the journey stopped there. Production on 2026-09-12:
 * forty of a hundred and fifty-two accounts carry no attestation, and three of
 * twelve paid customers have no account at all.
 *
 * This page is what those clicks reach instead. It is NOT a way around the
 * gate — nobody is waved past anything. It asks for the same two statements the
 * sign-in form asks for, says plainly why, and keeps hold of the offer while
 * the customer answers.
 *
 * IT DISCLOSES NOTHING ABOUT THE ADDRESS. It does not say whether an account
 * exists, whether one is already attested, or anything else a holder of a
 * forwarded link could learn from it. The page renders the same for every valid
 * handoff; POST /api/attest decides what happens next and is the only thing
 * that knows.
 *
 * AN INVALID HANDOFF GETS THE SIGN-IN ROUTE, not an error page. Expired,
 * tampered, forged, or pointed somewhere the grant may not go — one answer for
 * all of them, and it is a way forward rather than a dead end of a different
 * shape.
 */
export default async function AttestPage({
  searchParams,
}: {
  searchParams: Promise<{ h?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.h) ? params.h[0] : params.h;
  const handoff = await verifyAttestationHandoff(raw ?? null, { allows: emailGrantAllowsPath });

  return (
    <div className="vl-auth-shell relative min-h-screen overflow-hidden text-white">
      <main className="relative mx-auto flex w-full max-w-2xl flex-col justify-center px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-14 sm:px-6">
        <p className="text-[0.8125rem] font-semibold uppercase tracking-[0.34em] text-white">Vanta Labs</p>
        <p className="mt-1.5 text-[10px] uppercase tracking-[0.3em] text-[color:var(--accent-gold)]/75">Research Peptides</p>

        {handoff ? (
          <>
            <h1 className="vl2-serif mt-10 text-[2rem] leading-[1.12] tracking-[-0.015em] text-white sm:text-[2.5rem]">
              Two things before you continue
            </h1>
            <p className="mt-5 max-w-prose text-[0.9375rem] leading-7 text-white/60">
              Everything we sell is supplied strictly for laboratory research. Before we can
              show you the catalogue, we need the same two confirmations everyone here gives.
            </p>
            {handoff.offerToken ? (
              <p className="mt-4 max-w-prose rounded-lg border border-[color:var(--accent-gold)]/25 bg-[var(--accent-gold-soft)] px-4 py-3 text-[0.875rem] leading-6 text-[color:var(--accent-gold)]">
                Your gift is saved and will be waiting in your cart — confirming below does not use it up.
              </p>
            ) : null}
            <AttestationForm handoff={raw ?? ""} />
          </>
        ) : (
          <>
            <h1 className="vl2-serif mt-10 text-[2rem] leading-[1.12] tracking-[-0.015em] text-white sm:text-[2.5rem]">
              This link has expired
            </h1>
            <p className="mt-5 max-w-prose text-[0.9375rem] leading-7 text-white/60">
              Links in our emails are good for one hour. Open the most recent message we sent
              you, or sign in and everything saved to your account will still be there.
            </p>
            <a
              href="/account/login"
              className="mt-8 inline-flex w-full items-center justify-center rounded-lg bg-[color:var(--accent-gold)] px-6 py-3.5 text-[0.9375rem] font-semibold text-black transition hover:opacity-90 sm:w-auto"
            >
              Sign in
            </a>
          </>
        )}

        <p className="mt-12 text-[11px] uppercase tracking-[0.2em] text-white/25">
          For laboratory research use only
        </p>
      </main>
    </div>
  );
}
