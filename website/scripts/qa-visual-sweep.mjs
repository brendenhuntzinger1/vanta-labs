#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SCREENSHOTS A PERSON CAN ACTUALLY READ, AT EVERY WIDTH THAT MATTERS.
//
// qa-visual-qc.mjs captures FULL-PAGE images and machine-checks them. That is
// the right shape for a probe and the wrong shape for a reviewer: the catalogue
// is 9,600 CSS px tall, so a full-page capture scaled to fit a reading pane is
// a 14x reduction and nothing in it is legible. Every "reviewed the
// screenshots" claim made against those images was really a claim about the
// probes.
//
// So this captures VIEWPORT TILES at deviceScaleFactor 1 — each image is
// exactly what a person at that width sees, at native size, scrolled to a
// position — and it sweeps the widths the other script never ran:
//
//   320   the smallest phone still in use (iPhone SE 1st gen, Android Go)
//   390   iPhone 12-15 class            <- qa-visual-qc.mjs already covers
//   768   iPad portrait / small tablet
//   820   iPad Air portrait
//   1280  small laptop                  <- qa-visual-qc.mjs already covers
//   1440  common desktop
//   1920  large desktop
//
// 320 and 1920 are the ends where layouts break: one runs out of room, the
// other runs out of content and leaves a stranded column of whitespace.
//
// Development-only; refuses anything but the local harness.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  BASE, client, freshContext, createConfirmedCustomer, newEmail, signIn, dismissConsent,
  loadCatalog, CATALOG, addToCartFromPdp,
} from "./qa-cx-matrix.mjs";

const OUT = process.env.VS_OUT ?? "/tmp/cx-sweep";
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "320", width: 320, height: 568, isMobile: true, hasTouch: true },
  { name: "390", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "768", width: 768, height: 1024, isMobile: true, hasTouch: true },
  { name: "820", width: 820, height: 1180, isMobile: true, hasTouch: true },
  { name: "1280", width: 1280, height: 900 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
];

const MAX_TILES = Number(process.env.VS_TILES ?? 4);
const findings = [];
const note = (route, vp, severity, kind, detail) => findings.push({ route, vp, severity, kind, detail });

// Layout facts that only a real width can answer.
const PROBE = () => {
  const vw = window.innerWidth;
  const doc = document.documentElement;
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const describe = (el) => {
    const cls = typeof el.className === "string" && el.className
      ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
    const t = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 34);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}${t ? ` "${t}"` : ""}`;
  };
  const out = {
    overflow: doc.scrollWidth - doc.clientWidth,
    offenders: [], obstructed: [], tiny: [], dead: [], pageHeight: doc.scrollHeight,
    h1: document.querySelector("h1")?.innerText?.trim().slice(0, 60) ?? "",
    navVisible: null, contentWidth: null,
  };
  const all = [...document.querySelectorAll("body *")].filter(visible);
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1) out.offenders.push({ el: describe(el), over: Math.round(r.right - vw) });
  }
  out.offenders = out.offenders.slice(0, 8);

  // Is the primary navigation reachable at this width at all?
  const navish = [...document.querySelectorAll("header a[href], header button, nav a[href], nav button")].filter(visible);
  out.navVisible = navish.length;

  // How much of a wide viewport the content actually uses. A 1920 layout that
  // paints an 1100px column inside 1920 is not broken, but one that paints 700
  // is a phone layout stretched across a monitor.
  const main = document.querySelector("main, #vl-main-content + *, [role=main]") ?? document.body;
  const mr = main.getBoundingClientRect();
  out.contentWidth = Math.round(mr.width);

  const controls = [...document.querySelectorAll("button, a[href], input, select, [role=button]")].filter(visible);
  const scrim = [...document.querySelectorAll('[role=dialog],[aria-modal="true"],[class*="modal-scrim"],[class*="modal-backdrop"]')].find(visible);
  const dialog = scrim ? (scrim.closest('[role=dialog],[aria-modal="true"]') ?? scrim) : null;
  const scope = dialog ? controls.filter((c) => dialog.contains(c) && !/modal-backdrop|modal-scrim/.test(String(c.className))) : controls;
  for (const el of scope) {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) continue;
    if (r.width < 12 || r.height < 12) continue;
    if (el.getAttribute("aria-hidden") === "true" || el.getAttribute("tabindex") === "-1") continue;
    if (el.closest('[aria-hidden="true"],[inert]')) continue;
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
    if (getComputedStyle(hit).pointerEvents === "none") continue;
    out.obstructed.push({ a: describe(el), b: describe(hit) });
    if (out.obstructed.length >= 5) break;
  }
  if (vw <= 480) {
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (!(el.innerText || "").trim()) continue;
      if (r.height >= 24 && r.width >= 24) continue;
      if (/vl-skip-link|vl-staff-shortcut/.test(String(el.className))) continue;
      const inline = getComputedStyle(el).display.startsWith("inline")
        && el.parentElement && (el.parentElement.innerText || "").trim().length > (el.innerText || "").trim().length + 12;
      if (inline) continue;
      out.tiny.push({ el: describe(el), w: Math.round(r.width), h: Math.round(r.height) });
    }
    out.tiny = out.tiny.slice(0, 6);
  }
  for (const img of document.querySelectorAll("img")) {
    if (!visible(img)) continue;
    if (img.complete && img.naturalWidth === 0) out.dead.push((img.currentSrc || img.src || "").slice(0, 120));
  }
  out.dead = out.dead.slice(0, 6);
  return out;
};

async function shoot(page, route, vpName, label, tiles) {
  const probe = await page.evaluate(PROBE).catch(() => ({}));
  const vh = page.viewportSize().height;
  const total = probe.pageHeight ?? vh;
  const n = Math.max(1, Math.min(tiles, Math.ceil(total / vh)));
  for (let i = 0; i < n; i++) {
    const y = Math.round((i * (total - vh)) / Math.max(1, n - 1)) || (i === 0 ? 0 : 0);
    await page.evaluate((top) => window.scrollTo(0, top), n === 1 ? 0 : y);
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${OUT}/${label}__${vpName}__t${i + 1}.png` });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return probe;
}

function grade(route, vpName, probe) {
  const w = Number(vpName);
  if ((probe.overflow ?? 0) > 2) {
    note(route, vpName, "MAJOR", "sideways scroll",
      `${probe.overflow}px past ${w} · ${(probe.offenders ?? []).slice(0, 3).map((o) => `${o.el} (+${o.over})`).join(" | ") || "no single offender"}`);
  }
  if ((probe.obstructed ?? []).length) {
    note(route, vpName, "MAJOR", "control obstructed",
      probe.obstructed.slice(0, 3).map((o) => `${o.a} covered by ${o.b}`).join(" | "));
  }
  if ((probe.tiny ?? []).length) {
    note(route, vpName, "MINOR", "tap target under WCAG 2.2 AA (24px)",
      probe.tiny.map((t) => `${t.el} ${t.w}x${t.h}`).join(" | "));
  }
  if ((probe.dead ?? []).length) note(route, vpName, "INFO", "image resolved to nothing", probe.dead.slice(0, 3).join(" | "));
  if (!probe.navVisible) note(route, vpName, "MAJOR", "no navigation", "no visible header/nav control at this width");
  if (w >= 1440 && probe.contentWidth && probe.contentWidth < w * 0.5) {
    note(route, vpName, "INFO", "narrow content column", `main is ${probe.contentWidth}px inside ${w}px`);
  }
}

async function main() {
  await client.connect();
  await loadCatalog();
  const sellable = CATALOG.find((p) => p.stock_status !== "Out of Stock");
  const oos = CATALOG.find((p) => p.stock_status === "Out of Stock");
  const multi = CATALOG.find((p) => (p.doses ?? []).length > 3);

  const CORE = [
    ["home", "/"], ["catalog", "/products"],
    ["pdp-single", `/products/${sellable.slug}`],
    ["pdp-multi", `/products/${multi?.slug ?? sellable.slug}`],
    ["pdp-oos", `/products/${oos?.slug ?? sellable.slug}`],
    ["cart", "/cart"], ["checkout", "/checkout"], ["spin", "/spin"],
    ["account", "/account"], ["account-orders", "/account/orders"],
    ["account-rewards", "/account/rewards"], ["sms", "/sms"],
    ["privacy", "/legal/privacy"], ["coa", "/coa-library"],
  ];

  const email = await createConfirmedCustomer(newEmail("sweep"));
  for (const vp of VIEWPORTS) {
    const ctx = await freshContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await signIn(page, email);
    await dismissConsent(page);
    // A basket, so /cart and /checkout are not empty states at every width.
    await addToCartFromPdp(page, sellable.slug);
    for (const [label, route] of CORE) {
      try {
        await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(1400);
      } catch (error) { note(route, vp.name, "MAJOR", "navigation", String(error).slice(0, 140)); continue; }
      const probe = await shoot(page, route, vp.name, label, vp.name === "390" || vp.name === "1280" ? MAX_TILES : 1);
      grade(route, vp.name, probe);
    }
    await ctx.close();
  }

  // Every live product, at phone width, top of page: the width where a long
  // name wraps and a missing photograph is most obvious.
  {
    const ctx = await freshContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await signIn(page, email);
    await dismissConsent(page);
    for (const p of CATALOG) {
      await page.goto(`${BASE}/products/${p.slug}`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(1100);
      await page.screenshot({ path: `${OUT}/zz-pdp-${p.slug}__390__t1.png` });
    }
    await ctx.close();
  }

  const order = { MAJOR: 0, MINOR: 1, INFO: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.route.localeCompare(b.route));
  const count = (s) => findings.filter((f) => f.severity === s).length;
  const lines = [
    "# Responsive sweep — 320 / 390 / 768 / 820 / 1280 / 1440 / 1920",
    "", `MAJOR ${count("MAJOR")}   MINOR ${count("MINOR")}   INFO ${count("INFO")}`, "",
    "| Route | Width | Severity | Kind | Detail |", "|---|---|---|---|---|",
    ...findings.map((f) => `| \`${f.route}\` | ${f.vp} | ${f.severity} | ${f.kind} | ${String(f.detail).replace(/\|/g, "\\|").slice(0, 240)} |`),
  ];
  writeFileSync(`${OUT}/sweep.md`, lines.join("\n"));
  writeFileSync(`${OUT}/sweep.json`, JSON.stringify(findings, null, 2));
  console.log(`MAJOR ${count("MAJOR")}  MINOR ${count("MINOR")}  INFO ${count("INFO")}`);
  console.log(`report: ${OUT}/sweep.md`);
  await client.end();
  process.exit(0);
}
main().catch(async (e) => { console.error(e); try { await client.end(); } catch {} process.exit(2); });
