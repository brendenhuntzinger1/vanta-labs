"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

type CheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; code: string; current?: boolean }
  | { status: "unavailable"; error: string };

function linkBase(referralLink: string): string {
  // ".../r/CODE" -> ".../r/"
  return referralLink.replace(/\/r\/[^/]*$/, "/r/") || referralLink;
}

export function ReferralCodeManager({
  initialCode,
  referralLink,
  lastChangedAt,
}: {
  initialCode: string;
  referralLink: string;
  lastChangedAt?: string | null;
}) {
  const [code, setCode] = useState(initialCode);
  const [link, setLink] = useState(referralLink);
  const base = useMemo(() => linkBase(referralLink), [referralLink]);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [check, setCheck] = useState<CheckState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const qrWrapRef = useRef<HTMLDivElement>(null);

  const copy = useCallback(async (value: string, which: "code" | "link") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }, []);

  // Debounced availability check against the rate-limited server endpoint.
  useEffect(() => {
    if (!editing) return;
    const value = draft.trim();
    // All state updates happen inside the debounce (async), never synchronously
    // in the effect body — avoids cascading renders.
    const t = setTimeout(async () => {
      if (!value) {
        setCheck({ status: "idle" });
        return;
      }
      setCheck({ status: "checking" });
      try {
        const res = await fetch(`/api/partner/referral-code/check?code=${encodeURIComponent(value)}`);
        const json = (await res.json()) as { available?: boolean; code?: string; error?: string; current?: boolean };
        if (json.available) {
          setCheck({ status: "available", code: String(json.code ?? ""), current: json.current });
        } else {
          setCheck({ status: "unavailable", error: json.error ?? "That code can't be used." });
        }
      } catch {
        setCheck({ status: "unavailable", error: "Couldn't check availability — try again." });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [draft, editing]);

  const previewCode = check.status === "available" ? check.code : "";
  const canSave = check.status === "available" && !check.current && !saving;

  const save = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/partner/referral-code", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: draft.trim() }),
      });
      const json = (await res.json()) as { success?: boolean; code?: string; error?: string };
      if (!res.ok || !json.success || !json.code) {
        setMessage(json.error ?? "Couldn't update your code.");
        return;
      }
      setCode(json.code);
      setLink(`${base}${json.code}`);
      setEditing(false);
      setDraft("");
      setCheck({ status: "idle" });
      setMessage("Referral code updated. Your old link now redirects here.");
    } catch {
      setMessage("Couldn't update your code — please try again.");
    } finally {
      setSaving(false);
    }
  }, [base, canSave, draft]);

  const downloadQr = useCallback(() => {
    const svg = qrWrapRef.current?.querySelector("svg");
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 512;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 512, 512);
      ctx.drawImage(img, 32, 32, 448, 448);
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `referral-${code}.png`;
      a.click();
    };
    img.src = `data:image/svg+xml;base64,${btoa(xml)}`;
  }, [code]);

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-[0.25em] text-zinc-500">Your Referral Code</p>
        {lastChangedAt ? (
          <p className="text-[11px] text-zinc-500">Last changed {new Date(lastChangedAt).toLocaleDateString("en-US")}</p>
        ) : null}
      </div>

      <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-2xl tracking-wide text-white">{code}</p>
          <p className="mt-2 truncate text-sm text-zinc-300">{link}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => copy(code, "code")} className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-zinc-200 hover:border-white/30">
              {copied === "code" ? "Copied!" : "Copy code"}
            </button>
            <button type="button" onClick={() => copy(link, "link")} className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-zinc-200 hover:border-white/30">
              {copied === "link" ? "Copied!" : "Copy link"}
            </button>
            <button type="button" onClick={() => { setEditing((v) => !v); setMessage(null); setDraft(""); setCheck({ status: "idle" }); }} className="rounded-md border border-emerald-400/30 px-3 py-1.5 text-xs text-emerald-200 hover:border-emerald-400/60">
              {editing ? "Cancel" : "Change code"}
            </button>
          </div>
        </div>

        <div className="flex flex-col items-center gap-2">
          <div ref={qrWrapRef} className="rounded-lg bg-white p-2">
            <QRCodeSVG value={link} size={96} />
          </div>
          <button type="button" onClick={downloadQr} className="text-[11px] text-zinc-400 hover:text-zinc-200">Download QR</button>
        </div>
      </div>

      {editing ? (
        <div className="mt-4 border-t border-white/10 pt-4">
          <label className="text-xs text-zinc-400">
            New referral code
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. SUMMER-2026"
              maxLength={40}
              autoCapitalize="characters"
              className="mt-1 w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-white/40"
            />
          </label>

          <div className="mt-2 min-h-[20px] text-xs">
            {check.status === "checking" ? <span className="text-zinc-500">Checking…</span> : null}
            {check.status === "available" && !check.current ? (
              <span className="text-emerald-300">✓ Available — will become <span className="font-mono">{previewCode}</span> → <span className="text-zinc-400">{base}{previewCode}</span></span>
            ) : null}
            {check.status === "available" && check.current ? <span className="text-zinc-500">That&apos;s already your current code.</span> : null}
            {check.status === "unavailable" ? <span className="text-rose-300">{check.error}</span> : null}
          </div>

          <button type="button" onClick={save} disabled={!canSave} className="mt-3 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-black disabled:opacity-40">
            {saving ? "Saving…" : "Save new code"}
          </button>
        </div>
      ) : null}

      {message ? <p className="mt-3 text-xs text-emerald-300">{message}</p> : null}
    </section>
  );
}
