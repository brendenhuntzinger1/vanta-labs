"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

// "none" — the fetch succeeded and there is NO partner record. "unknown" — the
// fetch failed, so we do not know. Both used to be flattened into "pending",
// which is how a stranger who never applied was told their application was
// under review.
type PartnerStatus = "pending" | "info_requested" | "rejected" | "disabled" | "approved" | "none" | "unknown" | null;

const STATUS_COPY: Record<Exclude<PartnerStatus, "approved" | null>, { eyebrow: string; title: string; body: string }> = {
  pending: {
    eyebrow: "Application Received",
    title: "Pending Approval",
    body: "Your partner account is currently under review. You will gain access to the affiliate dashboard as soon as your application is approved.",
  },
  info_requested: {
    eyebrow: "Action Needed",
    title: "We Need a Bit More Information",
    body: "Our team has requested additional details before we can approve your application. Please reply to the email we sent, or reach out via the contact page, and we'll pick your review back up right away.",
  },
  rejected: {
    eyebrow: "Application Update",
    title: "Application Not Approved",
    body: "Your ambassador application was not approved at this time. You're welcome to reapply in the future as your audience or content evolves.",
  },
  disabled: {
    eyebrow: "Account Disabled",
    title: "Partner Access Disabled",
    body: "Your partner account has been disabled. If you believe this is a mistake, please contact our support team.",
  },
  none: {
    eyebrow: "Partner Programme",
    title: "No Application on File",
    body: "We don't have a partner application for you yet. If you'd like to join the ambassador programme, you can apply in a couple of minutes.",
  },
  unknown: {
    eyebrow: "Partner Programme",
    title: "We Couldn't Load Your Application",
    body: "Something went wrong reading your partner status. Please refresh, or contact us if it keeps happening — this is a problem on our side, not with your application.",
  },
};

export default function PartnerPendingPage() {
  const router = useRouter();
  const [status, setStatus] = useState<PartnerStatus>(null);
  const [loaded, setLoaded] = useState(false);

  // THIS PAGE USED TO TELL EVERY VISITOR THEIR APPLICATION WAS UNDER REVIEW.
  //
  // `json?.partner?.status ?? "pending"` turned a NULL partner — a signed-out
  // stranger, or a customer who never applied — into "pending", and the .catch
  // did the same on a failed fetch. So three quite different people were shown
  // one screen reading "Application Received / Pending Approval":
  //
  //   someone who never applied   told an application of theirs is in review
  //   an approved ambassador      told they cannot reach the dashboard yet
  //   a failed request            told a falsehood instead of an error
  //
  // The three are now distinguished. An absent record says so and offers the
  // application; a failed read admits it is our fault; and an approved partner
  // is sent to their dashboard, exactly as /partner/dashboard already does.
  useEffect(() => {
    let active = true;

    fetch("/api/partner/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((json) => {
        if (!active) return;
        const partnerStatus = json?.partner?.status;
        setStatus(partnerStatus ? (partnerStatus as PartnerStatus) : "none");
      })
      .catch(() => {
        if (active) setStatus("unknown");
      })
      .finally(() => {
        if (active) setLoaded(true);
      });

    return () => {
      active = false;
    };
  }, []);

  // An approved ambassador has somewhere better to be.
  useEffect(() => {
    if (status === "approved") router.replace("/account/ambassador");
  }, [status, router]);

  const copy = status && status !== "approved" ? STATUS_COPY[status] : STATUS_COPY.pending;

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.08),transparent_56%),linear-gradient(150deg,#050505_0%,#111111_50%,#070707_100%)] px-4 py-12 text-zinc-100 sm:px-6 lg:px-8">
      <div className="vl-panel mx-auto max-w-2xl rounded-[2rem] p-8 text-center" aria-busy={!loaded}>
        <p className="vl-eyebrow text-xs">{copy.eyebrow}</p>
        <h1 className="vl-display mt-3 text-3xl font-semibold text-white sm:text-4xl">{copy.title}</h1>
        <p className="mt-4 text-sm text-zinc-300 sm:text-base">{copy.body}</p>
        {status === "pending" ? (
          <p className="mt-3 text-sm text-zinc-400">
            While waiting, you can still browse products and prepare content for your launch.
          </p>
        ) : null}
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          {status === "none" ? (
            <Link href="/partner" className="vl-btn-primary rounded-full px-6 py-3 text-sm">Apply to the Programme</Link>
          ) : null}
          <Link href="/products" className="vl-btn-secondary rounded-full px-6 py-3 text-sm">Browse Products</Link>
          {status === "info_requested" ? (
            <Link href="/contact" className="vl-focus-ring rounded-full bg-gradient-to-r from-white to-zinc-300 px-6 py-3 text-sm font-semibold text-zinc-950">Contact Us</Link>
          ) : (
            <Link href="/partner" className="vl-focus-ring rounded-full bg-gradient-to-r from-white to-zinc-300 px-6 py-3 text-sm font-semibold text-zinc-950">Back to Partner Program</Link>
          )}
        </div>
      </div>
    </div>
  );
}
