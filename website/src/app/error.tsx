"use client";

// Root error boundary for the public site. Catches any unexpected render
// failure on a page that doesn't have its own error boundary and shows a
// friendly, recoverable screen instead of a raw crash.
import { useEffect } from "react";
import Link from "next/link";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Page error:", error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0b0b0b] px-6 text-white">
      <div className="w-full max-w-md text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/50">Something went wrong</p>
        <h1 className="vl2-serif mt-3 text-3xl">We hit a snag</h1>
        <p className="mt-3 text-sm leading-6 text-white/60">
          This page ran into an unexpected problem. Please try again — if it
          keeps happening, head back to the homepage.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <button type="button" onClick={reset} className="vl2-btn-primary vl-focus-ring px-6 py-3">
            Try again
          </button>
          <Link href="/" className="vl2-btn-secondary vl-focus-ring px-6 py-3">
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
