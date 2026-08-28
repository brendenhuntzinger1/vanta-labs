"use client";

import { useState } from "react";

// ---------------------------------------------------------------------------
// THE BUTTON THAT CLOSES AN ALERT.
//
// Small on purpose: the row it sits in is a server component, and the only
// interactive thing on /admin/status is this. Resolving is a WRITE, so it goes
// through the authenticated API route rather than a server action embedded in a
// read-only status page.
//
// It resolves the whole GROUP — every unresolved row of this type — because
// that is the unit the operator is looking at. Forty-four repetitions of one
// warning are one problem, and clearing them one at a time is not a workflow.
//
// A full reload rather than router.refresh(): the critical badge lives in the
// admin LAYOUT, above this page, and reloading is the only thing that is
// guaranteed to recount it. The page already tells the operator "Refresh to
// re-check", so this is the action it describes.
// ---------------------------------------------------------------------------

export function AdminAlertResolveButton({
  type,
  severity,
  alertIds,
  occurrences,
}: {
  type: string;
  severity: string;
  alertIds: string[];
  occurrences: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/alerts/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The GROUP, named the same way the page grouped it: type AND
        // severity. That clears the repetitions which arrived after this page
        // was rendered — sending only the ids would leave a storm looking
        // half-cleared — while never reaching a critical that shares the type
        // name with the warning being dismissed. `alertIds` rides along for the
        // audit log, so what the operator actually SAW is on the record.
        body: JSON.stringify({ type, severity, alertIds }),
      });
      const payload = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !payload.success) {
        setError(payload.error ?? "Could not resolve this alert.");
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resolve this alert.");
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => void resolve()}
        disabled={busy}
        className="rounded-md border border-white/15 px-2 py-0.5 text-[11px] text-zinc-300 transition hover:border-white/30 hover:text-white disabled:opacity-50"
      >
        {busy ? "Resolving…" : occurrences > 1 ? `Resolve all ${occurrences}` : "Resolve"}
      </button>
      {error ? <span className="text-[11px] text-rose-300">{error}</span> : null}
    </span>
  );
}
