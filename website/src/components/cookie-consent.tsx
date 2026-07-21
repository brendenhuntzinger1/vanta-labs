"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const STORAGE_KEY = "vl_cookie_consent";

// Lightweight cookie-consent banner. We only use essential cookies plus
// privacy-friendly analytics, so this is an acknowledgement/notice with a link
// to the Cookie Policy — no third-party tracking is loaded either way.
export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!window.localStorage.getItem(STORAGE_KEY)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setVisible(true);
      }
    } catch {
      // If storage is unavailable, don't nag.
    }
  }, []);

  const dismiss = (choice: "accepted" | "declined") => {
    try {
      window.localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      /* no-op */
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-2xl rounded-2xl border border-white/15 bg-[#111]/95 p-4 text-sm text-white/80 shadow-2xl backdrop-blur sm:flex sm:items-center sm:gap-4">
      <p className="flex-1 leading-6">
        We use essential cookies to run the store and privacy-friendly analytics to improve it. See our{" "}
        <Link href="/legal/cookies" className="text-white underline underline-offset-4">Cookie Policy</Link>.
      </p>
      <div className="mt-3 flex gap-2 sm:mt-0">
        <button type="button" onClick={() => dismiss("declined")} className="vl2-btn-secondary vl-focus-ring flex-1 px-4 py-2.5 text-xs sm:flex-none">Decline</button>
        <button type="button" onClick={() => dismiss("accepted")} className="vl2-btn-primary vl-focus-ring flex-1 px-5 py-2.5 text-xs sm:flex-none">Accept</button>
      </div>
    </div>
  );
}
