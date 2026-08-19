"use client";

import { useEffect, useState } from "react";

// -----------------------------------------------------------------------------
// A page that can describe itself, for the one browser nobody can attach a
// debugger to.
//
// The entry flow behaves correctly in Safari and Chrome and incorrectly in the
// TikTok in-app browser. That difference is the whole signal, and it cannot be
// chased from a desktop: an in-app webview has no console, no dev tools, and no
// way to inspect which deployment it was handed. So the page reports on itself.
//
// Open any URL with ?debug_entry=1 INSIDE the app in question and this panel
// shows what that browser is actually running — which build, which URL, which
// user agent, whether storage works, and whether anything threw. If the build
// id here differs from the one Safari reports, the problem is delivery, not
// React, and no amount of component work will fix it.
//
// Deliberately inert: it renders only when explicitly asked for, reports only
// what is already public, and touches nothing. Safe to leave in place, trivial
// to remove — delete this file and its one line in the root layout.
// -----------------------------------------------------------------------------

type Row = { k: string; v: string };

export function EntryDiagnostics() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Query string only, read at runtime, so nothing is server-rendered and no
    // ordinary visitor can stumble into it.
    let on = false;
    try {
      on = new URLSearchParams(window.location.search).get("debug_entry") === "1";
    } catch {
      on = false;
    }
    if (!on) return;

    // Storage in an embedded webview is not guaranteed. Anything here can
    // throw — that is precisely what we want to find out, so each is probed
    // separately rather than assumed.
    const probe = (fn: () => string) => {
      try {
        return fn();
      } catch (error) {
        return `THREW: ${error instanceof Error ? error.name : String(error)}`;
      }
    };

    const collected: Row[] = [
      { k: "build", v: process.env.NEXT_PUBLIC_BUILD_ID ?? "unknown" },
      { k: "built at", v: process.env.NEXT_PUBLIC_BUILD_TIME ?? "unknown" },
      { k: "href", v: window.location.href },
      { k: "host", v: window.location.host },
      { k: "path", v: window.location.pathname },
      { k: "query", v: window.location.search || "(none)" },
      { k: "hash", v: window.location.hash || "(none)" },
      { k: "referrer", v: document.referrer || "(none)" },
      { k: "user agent", v: navigator.userAgent },
      {
        k: "viewport",
        v: `${window.innerWidth}x${window.innerHeight} · visual ${Math.round(window.visualViewport?.width ?? 0)}x${Math.round(window.visualViewport?.height ?? 0)} · dpr ${window.devicePixelRatio}`,
      },
      {
        k: "safe area",
        v: (() => {
          const s = getComputedStyle(document.documentElement);
          const read = (n: string) => s.getPropertyValue(n).trim() || "0px";
          return `top ${read("--sa-top")} bottom ${read("--sa-bottom")}`;
        })(),
      },
      { k: "age attr", v: document.documentElement.getAttribute("data-age-verified") ?? "(absent)" },
      {
        k: "gate on screen",
        v: (() => {
          const g = document.querySelector("[data-age-gate]");
          if (!g) return "no gate element";
          const r = g.getBoundingClientRect();
          return `${getComputedStyle(g).display !== "none" ? "yes" : "no"} · ${Math.round(r.width)}x${Math.round(r.height)} at y=${Math.round(r.top)}`;
        })(),
      },
      {
        k: "entry buttons",
        v: (() => {
          const btns = [...document.querySelectorAll("[data-age-gate] button")].filter((b) =>
            /guest|sign in|create account/i.test(b.textContent ?? ""),
          );
          if (!btns.length) return "none found";
          // Off the bottom of the viewport = a tap can never reach it. This is
          // the failure an in-app browser's own toolbar produces.
          return btns
            .map((b) => {
              const r = b.getBoundingClientRect();
              const below = r.bottom > window.innerHeight;
              return `${(b.textContent ?? "").trim().slice(0, 18)}: y=${Math.round(r.top)}-${Math.round(r.bottom)}${below ? " OFF-SCREEN" : ""}${(b as HTMLButtonElement).disabled ? " disabled" : ""}`;
            })
            .join(" | ");
        })(),
      },
      { k: "localStorage", v: probe(() => { window.localStorage.setItem("__vl", "1"); window.localStorage.removeItem("__vl"); return "writable"; }) },
      { k: "sessionStorage", v: probe(() => { window.sessionStorage.setItem("__vl", "1"); window.sessionStorage.removeItem("__vl"); return "writable"; }) },
      { k: "cookies", v: probe(() => (navigator.cookieEnabled ? "enabled" : "DISABLED")) },
      { k: "age keys stored", v: probe(() => {
        const ls = Object.keys(window.localStorage).filter((k) => /age|verif|gate/i.test(k));
        const ss = Object.keys(window.sessionStorage).filter((k) => /age|verif|gate/i.test(k));
        const ck = document.cookie.split(";").map((c) => c.trim()).filter((c) => /age|verif|gate/i.test(c));
        return [...ls, ...ss, ...ck].join(", ") || "none";
      }) },
      { k: "video element", v: (() => {
        const v = document.querySelector("video");
        if (!v) return "none on this page";
        const cs = getComputedStyle(v);
        return `opacity ${cs.opacity} · ${v.paused ? "paused" : "playing"} · readyState ${v.readyState} · error ${v.error?.code ?? "none"}`;
      })() },
    ];
    // Handed to the next frame rather than set straight from the effect body:
    // the measurements above want a painted layout, and setting state
    // synchronously here would cascade a render before that.
    const raf = requestAnimationFrame(() => setRows(collected));

    const errs: string[] = [];
    const onErr = (e: ErrorEvent) => errs.push(`${e.message}`.slice(0, 90));
    const onRej = (e: PromiseRejectionEvent) => errs.push(`unhandled: ${String(e.reason).slice(0, 90)}`);
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    const t = setInterval(() => {
      setRows((prev) =>
        prev
          ? [...prev.filter((r) => r.k !== "errors"), { k: "errors", v: errs.length ? errs.slice(0, 3).join(" || ") : "none so far" }]
          : prev,
      );
    }, 1500);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
      clearInterval(t);
    };
  }, []);

  if (!rows) return null;

  const asText = rows.map((r) => `${r.k}: ${r.v}`).join("\n");

  return (
    <div
      // Exempt from the gate's hide rule, and above the gate itself, so it is
      // readable no matter what state the entry flow is in.
      data-entry-diagnostics="true"
      style={{
        position: "fixed",
        inset: "auto 0 0 0",
        zIndex: 2147483647,
        maxHeight: "62vh",
        overflowY: "auto",
        background: "#000",
        color: "#0f0",
        font: "11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
        padding: "10px 12px calc(10px + env(safe-area-inset-bottom))",
        borderTop: "2px solid #0f0",
        WebkitUserSelect: "text",
        userSelect: "text",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
        <strong style={{ color: "#fff" }}>VANTA ENTRY DIAGNOSTICS</strong>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(asText).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
          style={{ background: "#0f0", color: "#000", border: 0, padding: "3px 9px", fontWeight: 700, borderRadius: 4 }}
        >
          {copied ? "COPIED" : "COPY"}
        </button>
      </div>
      {rows.map((r) => (
        <div key={r.k} style={{ wordBreak: "break-all", marginBottom: 2 }}>
          <span style={{ color: "#888" }}>{r.k}:</span> {r.v}
        </div>
      ))}
      <div style={{ color: "#888", marginTop: 6 }}>
        If COPY does nothing, select this text and copy it by hand.
      </div>
    </div>
  );
}
