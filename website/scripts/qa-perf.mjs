#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PERFORMANCE, MEASURED WITH WHAT THIS MACHINE ACTUALLY HAS.
//
// Lighthouse is NOT installed here and fetching it would be installing a tool
// this environment was told not to add, so this does not pretend to produce a
// Lighthouse score. What it does produce is the same underlying evidence,
// straight from the browser that renders the page:
//
//   LCP          largest-contentful-paint entries (the real element, and when)
//   CLS          layout-shift entries, excluding those following recent input
//   TTFB / DCL   Navigation Timing
//   long tasks   >50ms blocks of the main thread
//   weight       Resource Timing transferSize, by type, with the worst offenders
//   duplicates   the same URL fetched more than once in one page load
//
// It runs against PRODUCTION for the pages a signed-out person can reach — all
// GETs, nothing submitted, nothing created — and against the local harness for
// the ones behind the account wall, which is the only place they can be driven.
//
// Numbers from a datacentre through this session's egress proxy are not a
// customer's numbers. Treat transfer weight, request counts, duplicates and CLS
// as real; treat absolute timings as an upper bound on a fast connection.
// ---------------------------------------------------------------------------

import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const OUT = process.env.PERF_OUT ?? "/tmp/cx-perf";
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const CHROME = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]
  .find((p) => existsSync(p));

const COLLECT = () => new Promise((resolve) => {
  const shifts = [];
  const longTasks = [];
  let lcp = null;
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) lcp = e; })
      .observe({ type: "largest-contentful-paint", buffered: true });
  } catch { /* unsupported */ }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) shifts.push({ v: e.value, t: e.startTime });
    }).observe({ type: "layout-shift", buffered: true });
  } catch { /* unsupported */ }
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(Math.round(e.duration)); })
      .observe({ type: "longtask", buffered: true });
  } catch { /* unsupported */ }

  setTimeout(() => {
    const nav = performance.getEntriesByType("navigation")[0] ?? {};
    const res = performance.getEntriesByType("resource");
    const byType = {};
    const seen = new Map();
    let total = 0;
    for (const r of res) {
      const size = r.transferSize || 0;
      total += size;
      const t = r.initiatorType || "other";
      byType[t] = byType[t] || { n: 0, bytes: 0 };
      byType[t].n++; byType[t].bytes += size;
      seen.set(r.name, (seen.get(r.name) ?? 0) + 1);
    }
    const heaviest = [...res].sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0)).slice(0, 6)
      .map((r) => ({ url: r.name.slice(-88), kb: Math.round((r.transferSize || 0) / 1024), ms: Math.round(r.duration) }));
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([u, n]) => ({ n, url: u.slice(-88) })).slice(0, 8);
    resolve({
      ttfb: Math.round(nav.responseStart ?? 0),
      dcl: Math.round(nav.domContentLoadedEventEnd ?? 0),
      load: Math.round(nav.loadEventEnd ?? 0),
      docKb: Math.round((nav.transferSize || 0) / 1024),
      lcpMs: lcp ? Math.round(lcp.startTime) : null,
      lcpEl: lcp?.element ? (lcp.element.tagName + (lcp.element.className ? "." + String(lcp.element.className).split(/\s+/)[0] : "")) : null,
      cls: Number(shifts.reduce((a, s) => a + s.v, 0).toFixed(4)),
      biggestShift: shifts.length ? Number(Math.max(...shifts.map((s) => s.v)).toFixed(4)) : 0,
      shiftCount: shifts.length,
      longTasks: longTasks.length, longestTaskMs: longTasks.length ? Math.max(...longTasks) : 0,
      requests: res.length, totalKb: Math.round(total / 1024),
      byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, `${v.n} / ${Math.round(v.bytes / 1024)}kb`])),
      heaviest, dupes,
      lazyImgs: document.querySelectorAll('img[loading="lazy"]').length,
      eagerImgs: document.querySelectorAll('img:not([loading="lazy"])').length,
      imgsNoDims: [...document.querySelectorAll("img")].filter((i) => !i.getAttribute("width") && !i.style.aspectRatio && !getComputedStyle(i).aspectRatio.includes("/")).length,
    });
  }, 4000);
});

async function measure(page, label, url) {
  let status = 0;
  try {
    // `load` waits for every last resource, and a page with a looping hero
    // video or a long-lived connection may never fire it — this script hung for
    // 45 minutes on exactly that. domcontentloaded plus a fixed settle window
    // is bounded and measures the same thing.
    const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    status = r?.status() ?? 0;
    await page.waitForTimeout(2500);
  } catch (e) { return { label, url, error: String(e).slice(0, 120) }; }
  const m = await page.evaluate(COLLECT);
  return { label, url, status, ...m };
}

async function main() {
  const rows = [];
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });

  // PRODUCTION — public pages only, GET only, nothing submitted.
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    for (const [label, path] of [
      ["prod login (the first screen of every visit)", "/account/login"],
      ["prod /sms", "/sms"], ["prod privacy", "/legal/privacy"],
      ["prod terms", "/legal/terms"], ["prod contact", "/contact"],
    ]) rows.push(await measure(page, label, `https://www.vantalabsresearch.com${path}`));
    await ctx.close();
  }

  // HARNESS — everything behind the wall.
  if (process.env.PERF_HARNESS !== "0") {
    const m = await import("./qa-cx-matrix.mjs");
    await m.client.connect();
    await m.loadCatalog();
    const sellable = m.CATALOG.find((p) => p.stock_status !== "Out of Stock");
    const email = await m.createConfirmedCustomer(m.newEmail("perf"));
    const ctx = await m.freshContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await m.signIn(page, email);
    await m.dismissConsent(page);
    await m.addToCartFromPdp(page, sellable.slug);
    for (const [label, path] of [
      ["harness home", "/"], ["harness catalogue (34 products)", "/products"],
      ["harness PDP", `/products/${sellable.slug}`], ["harness cart", "/cart"],
      ["harness checkout", "/checkout"], ["harness spin", "/spin"], ["harness account", "/account"],
    ]) rows.push(await measure(page, label, `${m.BASE}${path}`));
    await ctx.close();
    await m.client.end();
  }
  await browser.close();

  const kb = (n) => (n == null ? "—" : `${n} kB`);
  const lines = [
    "# Performance — measured, not scored",
    "",
    "**Lighthouse is not installed in this environment and was not fetched.** These are",
    "the underlying browser measurements instead. Transfer weight, request counts,",
    "duplicate requests and CLS are real. Absolute timings come from a datacentre",
    "through a proxy and are an upper bound on a fast connection, not a customer's.",
    "",
    "| Page | HTTP | TTFB | LCP | CLS | Long tasks | Requests | Weight |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => r.error
      ? `| ${r.label} | ERROR | | | | | | ${r.error} |`
      : `| ${r.label} | ${r.status} | ${r.ttfb}ms | ${r.lcpMs ?? "—"}ms${r.lcpEl ? ` (${r.lcpEl})` : ""} | **${r.cls}** | ${r.longTasks} (max ${r.longestTaskMs}ms) | ${r.requests} | ${kb(r.totalKb)} |`),
    "",
    "## Per page",
    "",
  ];
  for (const r of rows) {
    if (r.error) { lines.push(`### ${r.label}`, "", `ERROR: ${r.error}`, ""); continue; }
    lines.push(`### ${r.label}`, "",
      `- by type: ${Object.entries(r.byType).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
      `- images: ${r.eagerImgs} eager, ${r.lazyImgs} lazy, ${r.imgsNoDims} without intrinsic dimensions`,
      `- layout shift: total ${r.cls}, largest single ${r.biggestShift}, ${r.shiftCount} shifts`,
      `- heaviest: ${r.heaviest.map((h) => `${h.kb}kB ${h.url}`).join(" · ") || "none"}`,
      `- duplicate requests: ${r.dupes.length ? r.dupes.map((d) => `${d.n}× ${d.url}`).join(" · ") : "none"}`,
      "");
  }
  writeFileSync(`${OUT}/perf.md`, lines.join("\n"));
  writeFileSync(`${OUT}/perf.json`, JSON.stringify(rows, null, 2));
  console.log(lines.slice(6, 6 + rows.length + 3).join("\n"));
  console.log(`\nreport: ${OUT}/perf.md`);
}
main().catch((e) => { console.error(e); process.exit(2); });
