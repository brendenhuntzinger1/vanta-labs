"use client";

import { useState } from "react";

// ---------------------------------------------------------------------------
// "SIGN OUT AND OPEN THE LINK AGAIN" NEEDS A WAY TO SIGN OUT.
//
// A forwarded spin link opened by a different account gets a screen telling
// them to sign out — and the only button on it went to /account, which is
// further INTO the account they need to leave. The instruction was sound and
// unfollowable in one tap.
//
// The link is kept in state so the same button can finish the job: sign out,
// then return to this exact spin URL, which now resolves as the anonymous
// visitor the token was signed for.
// ---------------------------------------------------------------------------

const GOLD = "#c7ae5e";

export function SpinWrongAccount({ spinHref }: { spinHref: string }) {
  const [working, setWorking] = useState(false);

  async function signOutAndReturn() {
    if (working) return;
    setWorking(true);
    try {
      await fetch("/api/auth/session", { method: "DELETE", credentials: "same-origin" });
    } catch {
      // Even a failed revocation should not strand them on a dead end — the
      // navigation below still gives the page a chance to re-evaluate.
    }
    // A full navigation rather than a router push: the session cookie changed,
    // and every guard on the way to this page reads it on the server.
    window.location.href = spinHref;
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-20 text-center">
      <h1 className="text-xl font-semibold">This link belongs to a different account</h1>
      <p className="mt-3 text-sm" style={{ color: "var(--foreground-muted)" }}>
        You&apos;re signed in as someone else. A prize has to be attached to the account that
        will check out with it, so this link will not open under this one.
      </p>
      <button
        type="button"
        onClick={signOutAndReturn}
        disabled={working}
        className="mt-6 inline-block rounded-lg px-5 py-3 text-sm font-semibold disabled:opacity-60"
        style={{ background: GOLD, color: "#0a0a0a" }}
      >
        {working ? "Signing out…" : "Sign out and open the link"}
      </button>
      <p className="mt-4 text-xs" style={{ color: "var(--foreground-muted)" }}>
        Or open the link that was sent to the address you&apos;re signed in with.
      </p>
    </div>
  );
}
