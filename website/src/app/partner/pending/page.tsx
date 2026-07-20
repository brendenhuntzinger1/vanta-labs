"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type PartnerStatus = "pending" | "info_requested" | "rejected" | "disabled" | "approved" | null;

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
};

export default function PartnerPendingPage() {
  const [status, setStatus] = useState<PartnerStatus>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;

    fetch("/api/partner/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((json) => {
        if (!active) return;
        setStatus(json?.partner?.status ?? "pending");
      })
      .catch(() => {
        if (active) setStatus("pending");
      })
      .finally(() => {
        if (active) setLoaded(true);
      });

    return () => {
      active = false;
    };
  }, []);

  const copy = status && status !== "approved" ? STATUS_COPY[status] : STATUS_COPY.pending;

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.08),transparent_56%),linear-gradient(150deg,#050505_0%,#111111_50%,#070707_100%)] px-4 py-12 text-zinc-100 sm:px-6 lg:px-8">
      <div className="vl-panel mx-auto max-w-2xl rounded-[2rem] p-8 text-center" aria-busy={!loaded}>
        <p className="vl-eyebrow text-xs">{copy.eyebrow}</p>
        <h1 className="vl-display mt-3 text-3xl font-semibold text-white sm:text-4xl">{copy.title}</h1>
        <p className="mt-4 text-sm text-zinc-300 sm:text-base">{copy.body}</p>
        {status === "pending" ? (
          <p className="mt-3 text-sm text-zinc-500">
            While waiting, you can still browse products and prepare content for your launch.
          </p>
        ) : null}
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
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
