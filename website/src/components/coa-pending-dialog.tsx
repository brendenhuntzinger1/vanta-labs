"use client";

import { useId, useRef } from "react";
import type { ReactNode } from "react";

import { COA_SUPPORT_EMAIL, COA_TESTING_PENDING_HEADING, COA_TESTING_PENDING_SHORT } from "@/lib/coa-pending";

// ---------------------------------------------------------------------------
// "VIEW COA" FOR A PRODUCT WHOSE CERTIFICATE HAS NOT COME BACK YET.
//
// The trigger is handed the SAME class list and the same children as the real
// document link on the card, so the two are indistinguishable at rest — that
// is the point. What differs is what happens on tap: a document opens in a
// new tab; this opens a small dialog that says the certificate is on its way
// back from the laboratory and gives the support address for questions.
//
// A native <dialog> opened with showModal(), rather than a hand-rolled
// overlay: the browser supplies the top layer (so the card's own stacking and
// hover transform cannot clip it), the focus trap, Escape-to-close and the
// return of focus to the trigger. There is no React state — the element is
// its own state, and a card that is never tapped costs nothing.
//
// It is rendered on the card as a sibling of the trigger, OUTSIDE the
// card-wide <Link>, for the same reason the document anchor is: an
// interactive element inside an anchor is invalid HTML.
// ---------------------------------------------------------------------------

export function CoaPendingDialog({
  productName,
  className,
  children,
}: {
  productName: string;
  /** The exact class list of the card's real "View COA" link. */
  className: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const mailto = `mailto:${COA_SUPPORT_EMAIL}?subject=${encodeURIComponent(`COA for ${productName}`)}`;

  return (
    <>
      <button type="button" aria-haspopup="dialog" className={className} onClick={() => dialogRef.current?.showModal()}>
        {children}
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={headingId}
        // A click that lands on the element itself landed on the backdrop —
        // the content wrapper below covers every pixel inside the frame.
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
        className="vl-coa-pending-dialog m-auto w-[min(100%-2rem,26rem)] max-w-none rounded-2xl p-0 text-white"
      >
        <div className="p-6 sm:p-7">
          <p className="vl2-eyebrow text-[10px] text-[color:var(--accent-gold)]">Certificate of Analysis</p>
          <h2 id={headingId} className="mt-2 text-xl font-medium leading-snug tracking-[-0.005em] text-white">
            {COA_TESTING_PENDING_HEADING}
          </h2>
          <p className="mt-1 text-sm text-white/50">{productName}</p>
          <p className="mt-4 text-sm leading-relaxed text-[#a3a3a3]">{COA_TESTING_PENDING_SHORT}</p>
          <p className="mt-3 text-sm leading-relaxed text-[#d4d4d4]">
            Questions in the meantime? Email us at{" "}
            <a
              href={`mailto:${COA_SUPPORT_EMAIL}`}
              className="vl-focus-ring text-white underline decoration-white/30 underline-offset-4 transition hover:decoration-white"
            >
              {COA_SUPPORT_EMAIL}
            </a>
            .
          </p>
          <div className="mt-6 grid grid-cols-2 gap-2">
            <a href={mailto} className="vl2-btn-primary vl-focus-ring px-4 py-2.5 text-sm">
              Email us
            </a>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="vl2-btn-secondary vl-focus-ring px-4 py-2.5 text-sm"
            >
              Close
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
