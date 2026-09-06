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
  // COLLAPSED BY DEFAULT. Expanded, this panel covers the bottom of the screen
  // — which is exactly where the gate's entry buttons are. Left open it would
  // block the very flow it exists to observe.
  const [open, setOpen] = useState(false);

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
      { k: "localStorage", v: probe(() => { window.localStorage.setItem("__vl", "1"); window.localStorage.removeItem("__vl"); return "writable"; }) },
      { k: "sessionStorage", v: probe(() => { window.sessionStorage.setItem("__vl", "1"); window.sessionStorage.removeItem("__vl"); return "writable"; }) },
      { k: "cookies", v: probe(() => (navigator.cookieEnabled ? "enabled" : "DISABLED")) },
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

    // ---------------------------------------------------------------------
    // THE EVENT LOG.
    //
    // The failure being chased opens Apple's own fullscreen player, which
    // covers the page — so a snapshot taken afterwards shows nothing. What is
    // needed is a record written AS IT HAPPENS and still readable once the
    // player is dismissed. Everything below appends to one timestamped log,
    // mirrored into sessionStorage so it also survives a reload.
    // ---------------------------------------------------------------------
    const t0 = Date.now();
    const LOG_KEY = "__vl_entry_log";
    const log: string[] = (() => {
      try {
        return JSON.parse(window.sessionStorage.getItem(LOG_KEY) ?? "[]");
      } catch {
        return [];
      }
    })();
    const note = (what: string) => {
      log.push(`+${String(Date.now() - t0).padStart(5)}ms ${what}`);
      try {
        window.sessionStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-40)));
      } catch {
        /* storage may be unavailable; the in-memory log still works */
      }
    };
    note("diagnostics armed");

    // Does a <video> ever exist, and when? This is the crux: the hero is not
    // mounted until entry, so a video appearing earlier means the running code
    // is not the build that was deployed.
    const describeVideo = (v: HTMLVideoElement) => {
      const cs = getComputedStyle(v);
      const r = v.getBoundingClientRect();
      return `src=${(v.currentSrc || v.src || "?").split("/").pop()} ${cs.display}/${cs.visibility} ${Math.round(r.width)}x${Math.round(r.height)} paused=${v.paused} ready=${v.readyState} inline=${v.playsInline}`;
    };
    const domWatcher = new MutationObserver((records) => {
      for (const rec of records) {
        rec.addedNodes.forEach((n) => {
          if (n instanceof HTMLVideoElement) note(`VIDEO ADDED — ${describeVideo(n)}`);
          else if (n instanceof HTMLElement) {
            n.querySelectorAll?.("video").forEach((v) => note(`VIDEO ADDED (nested) — ${describeVideo(v as HTMLVideoElement)}`));
          }
        });
        rec.removedNodes.forEach((n) => {
          if (n instanceof HTMLVideoElement) note("video removed");
        });
      }
    });
    domWatcher.observe(document.body, { childList: true, subtree: true });

    // Media and fullscreen events, captured on the way down so they are seen
    // wherever they fire. webkitbeginfullscreen is the one that matters: it is
    // iOS announcing it is taking over with its own player.
    const mediaEvents = [
      "webkitbeginfullscreen", "webkitendfullscreen",
      "play", "playing", "pause", "loadedmetadata", "error", "stalled",
    ];
    const onMedia = (e: Event) => {
      const target = e.target;
      note(`${e.type.toUpperCase()}${target instanceof HTMLVideoElement ? ` — ${describeVideo(target)}` : ""}`);
    };
    for (const ev of mediaEvents) document.addEventListener(ev, onMedia, true);
    const onFsChange = () => note(`fullscreenchange — element=${document.fullscreenElement?.tagName ?? "none"}`);
    document.addEventListener("fullscreenchange", onFsChange, true);

    // Every play() call, with whether it happened inside a gesture handler.
    let inGesture = false;
    const markGesture = () => {
      inGesture = true;
      setTimeout(() => { inGesture = false; }, 0);
    };
    for (const ev of ["pointerdown", "touchstart", "touchend", "click"]) {
      document.addEventListener(ev, markGesture, true);
    }
    const proto = HTMLMediaElement.prototype;
    const realPlay = proto.play;
    proto.play = function patchedPlay(this: HTMLMediaElement, ...args: unknown[]) {
      note(`play() CALLED — inGesture=${inGesture} ${this instanceof HTMLVideoElement ? describeVideo(this) : ""}`);
      return realPlay.apply(this, args as never);
    };

    // Navigation away is worth knowing about too — it would mean the browser
    // really did go somewhere, rather than presenting a player over the page.
    window.addEventListener("pagehide", () => note(`pagehide — url ${location.href}`), true);

    const errs: string[] = [];
    const onErr = (e: ErrorEvent) => { errs.push(`${e.message}`.slice(0, 90)); note(`JS ERROR ${e.message.slice(0, 60)}`); };
    const onRej = (e: PromiseRejectionEvent) => { errs.push(`unhandled: ${String(e.reason).slice(0, 90)}`); note("unhandled rejection"); };
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    const t = setInterval(() => {
      setRows((prev) =>
        prev
          ? [
              ...prev.filter((r) => r.k !== "errors" && r.k !== "EVENT LOG" && r.k !== "videos now"),
              { k: "videos now", v: String(document.querySelectorAll("video").length) },
              { k: "errors", v: errs.length ? errs.slice(0, 3).join(" || ") : "none so far" },
              { k: "EVENT LOG", v: log.length ? log.slice(-14).join("\n") : "(nothing yet)" },
            ]
          : prev,
      );
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      domWatcher.disconnect();
      for (const ev of mediaEvents) document.removeEventListener(ev, onMedia, true);
      document.removeEventListener("fullscreenchange", onFsChange, true);
      for (const ev of ["pointerdown", "touchstart", "touchend", "click"]) {
        document.removeEventListener(ev, markGesture, true);
      }
      proto.play = realPlay;
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
        maxHeight: open ? "62vh" : "auto",
        overflowY: open ? "auto" : "hidden",
        background: "#000",
        color: "#0f0",
        font: "11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
        padding: "10px 12px calc(10px + env(safe-area-inset-bottom))",
        borderTop: "2px solid #0f0",
        WebkitUserSelect: "text",
        userSelect: "text",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: open ? 6 : 0, alignItems: "center" }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{ background: "transparent", color: "#fff", border: 0, font: "inherit", fontWeight: 700, padding: "4px 0" }}
        >
          {open ? "▼ HIDE" : "▲ SHOW"} VANTA DIAGNOSTICS
        </button>
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
      {open ? rows.map((r) => (
        <div key={r.k} style={{ wordBreak: "break-all", marginBottom: 2, whiteSpace: r.k === "EVENT LOG" ? "pre-wrap" : "normal" }}>
          <span style={{ color: r.k === "EVENT LOG" ? "#ff0" : "#888" }}>{r.k}:</span> {r.v}
        </div>
      )) : null}
      {open ? (
        <div style={{ color: "#888", marginTop: 6 }}>
          If COPY does nothing, select this text and copy it by hand.
        </div>
      ) : null}
    </div>
  );
}
