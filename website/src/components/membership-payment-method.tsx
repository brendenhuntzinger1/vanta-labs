"use client";

// Deliberate integration point, not a fake card form: real card fields
// must come from the eventual payment processor's own hosted SDK (Stripe
// Elements or equivalent) to stay PCI-compliant, and which SDK to embed
// isn't knowable until a processor is chosen. Everything else in the
// membership signup flow (tier selection, billing-terms disclosure, the
// required agreement checkbox, and the server-side subscription record)
// is fully wired and real - this is the one deliberately deferred piece.
export function MembershipPaymentMethodPlaceholder() {
  return (
    <div className="rounded-2xl border border-dashed border-white/20 bg-white/[0.03] p-5">
      <p className="text-sm font-semibold text-white">Payment method</p>
      <p className="mt-2 text-sm leading-6 text-white/60">
        Card collection isn&apos;t connected yet — Vanta Labs hasn&apos;t finished setting up a payment
        processor. Your membership request will be saved, and billing will begin automatically as soon
        as that&apos;s connected. In the meantime, contact support if you&apos;d like your membership
        activated manually.
      </p>
    </div>
  );
}
