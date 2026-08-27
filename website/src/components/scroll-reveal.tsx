"use client";

import { useEffect, useRef, useState } from "react";

export function ScrollReveal({
  children,
  delayMs = 0,
  className = "",
}: {
  children: React.ReactNode;
  delayMs?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // START VISIBLE, ON BOTH SIDES.
  //
  // This was `typeof IntersectionObserver === "undefined"`, which is TRUE on
  // the server and FALSE in every real browser — so the server rendered
  // data-revealed="true" and the client hydrated data-revealed={false} on every
  // reveal on the page. React reported a hydration mismatch on every page load
  // ("some attributes ... didn't match ... This won't be patched up") and, since
  // `.vl-reveal` is opacity:0 until the attribute says otherwise, a re-render of
  // the subtree could blank content the visitor was already reading.
  //
  // Agreeing on `true` fixes the mismatch AND keeps the content visible without
  // JavaScript, which the old code only achieved by accident of the server
  // branch. The animation is then armed below, on the client only.
  const [revealed, setRevealed] = useState(true);

  useEffect(() => {
    const node = ref.current;
    // No IntersectionObserver (very old browser): leave it visible forever.
    if (!node || typeof IntersectionObserver === "undefined") return;

    // Anything already on screen at mount stays visible. Hiding it now to
    // animate it back in is the flicker this component exists to avoid — and
    // the visitor is already looking at it.
    const rect = node.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) return;

    // Below the fold: hide it now (off-screen, so nothing flashes) and let the
    // observer bring it in on scroll.
    setRevealed(false);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            window.setTimeout(() => setRevealed(true), delayMs);
            observer.disconnect();
          }
        }
      },
      // threshold 0 fires as soon as ANY part of the element enters the
      // viewport. A tall above-the-fold section (e.g. the top of the
      // Membership page) never reaches the old 15% threshold until you
      // scroll, which made that content appear only after scrolling.
      { threshold: 0, rootMargin: "0px 0px -5% 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [delayMs]);

  return (
    <div ref={ref} data-revealed={revealed} className={`vl-reveal ${className}`}>
      {children}
    </div>
  );
}
