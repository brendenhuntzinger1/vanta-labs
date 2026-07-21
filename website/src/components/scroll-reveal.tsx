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
  const [revealed, setRevealed] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;

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
