#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE LAST LOOK BEFORE THE MERGE — WITH EYES, NOT WITH STATUS CODES.
//
// Every other browser script here asks whether the shop WORKS. This one asks
// whether it LOOKS FINISHED, which is a different question and the one a
// customer answers first. A page can return 200, price correctly and add to the
// basket while a heading wraps into a button, a modal sits half off-screen, or
// the phone layout scrolls sideways.
//
// SO IT MEASURES PRESENTATION AND IT KEEPS THE PICTURE. Every route is walked
// at 390x844 and 1280x900, screenshotted full-page, and probed for the failures
// that are invisible to an assertion about text:
//
//   - sideways scroll, and WHICH element causes it
//   - anything rendered outside the viewport's left/right edge
//   - overlapping interactive controls (a button under a button)
//   - tap targets under 44px on the phone
//   - images that resolved to nothing, and placeholders
//   - text clipped by its own container
//   - headings and body text at sizes nothing else on the page uses
//
// AND IT WATCHES THE WIRE. Console errors, unhandled rejections, failed
// requests, React hydration mismatches and the same request fired more than
// twice are all recorded per route, because those are the defects that never
// show up in a screenshot.
//
// HARNESS ARTIFACTS ARE NAMED, NOT COUNTED. This harness points
// NEXT_PUBLIC_SUPABASE_URL at a local TLS proxy, so next/image's remotePatterns
// — narrowed deliberately against SSRF — refuse the real storage host and every
// product photo 400s. That is the guard working. Production serves the same
// images 200. Anything matching a known artifact is reported separately and
// never counted as a site defect.
//
// Development-only; refuses anything but the local harness.
//
//   node scripts/qa-visual-qc.mjs
//   VQ_ROUTES=/,/products node scripts/qa-visual-qc.mjs      # a subset
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  BASE, DESKTOP, PHONE, client, q, freshContext, createConfirmedCustomer, newEmail,
  signIn, dismissConsent, loadCatalog, CATALOG,
} from "./qa-cx-matrix.mjs";

const OUT = process.env.VQ_OUT ?? "/tmp/cx-visual";
const SHOTS = `${OUT}/shots`;
for (const d of [OUT, SHOTS]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

// KNOWN HARNESS ARTIFACTS. Each one is a thing this environment does that the
// shop does not, with the reason it is not a defect. Nothing else is excused.
const ARTIFACTS = [
  { re: /\/_next\/image\?/, why: "next/image remotePatterns derive from NEXT_PUBLIC_SUPABASE_URL (anti-SSRF); this harness points it at a local proxy, so the optimizer refuses the real storage host. Production serves these 200." },
  { re: /127\.0\.0\.1:54443|127\.0\.0\.1:54321/, why: "the local gotrue/PostgREST TLS proxy, which does not exist in production" },
  { re: /ERR_CERT|self.signed certificate|SSL certificate/i, why: "the harness's self-signed TLS certificate" },
  { re: /favicon\.ico/, why: "favicon is served from the CDN in production" },
  // A CRAWLER IS NOT A CUSTOMER, and the difference shows up here. The App
  // Router prefetches every link in view as `?_rsc=...`; this crawl screenshots
  // and moves on after 1.5s, so those prefetches are cancelled mid-flight and
  // report ERR_ABORTED. Same for the hero video, whose stream is cut when the
  // context closes — it serves 200 and answers a range request 206. Only
  // ERR_ABORTED is excused; a 4xx or 5xx on the same URL is still a defect.
  // ERR_ABORTED IS A CANCELLATION, NOT A FAILURE. This crawl screenshots a
  // route and navigates on after ~1.5s, which cancels every request still in
  // flight: App Router `?_rsc=` prefetches for each link in view, the hero
  // video's stream, the cart provider's offer and eligibility reads. A
  // customer who stays on the page for longer than a second and a half sees
  // none of it. A request that genuinely fails answers 4xx/5xx and is caught
  // by the rules below.
  { re: /ERR_ABORTED/, why: "a request cancelled when this crawl navigated on after 1.5s — not a failed load" },
  // 106 COLD PAGE LOADS FROM ONE IP IN A FEW MINUTES IS NOT A SHOPPING
  // SESSION. /api/catalog/promotions/eligibility is rate limited to 10 per 10
  // minutes per IP, deliberately (AUTH-4: it takes an arbitrary email and was
  // usable as an existence oracle). A real shopper fires it ONCE per hard page
  // load and the App Router keeps the provider mounted across soft
  // navigations, so a session costs one or two. This crawl reloads every route
  // twice over. The shared-IP case is real and is reported to the owner rather
  // than counted here.
  { re: /(429|Too Many Requests).*promotions\/eligibility|promotions\/eligibility.*429/, why: "this crawl's own request rate against a deliberate 10-per-10-minute per-IP limit; a shopper fires it once per hard load" },
  // Chromium reports a failed subresource twice: once as a network event with
  // the URL, once as a bare console line without it. The network event above
  // is what gets classified; counting the console echo again would double
  // every artifact.
  { re: /^error: Failed to load resource: the server responded with a status of (400|429)\b/, why: "the console echo of a network failure already classified above" },
];
const artifactFor = (s) => ARTIFACTS.find((a) => a.re.test(String(s)))?.why ?? null;

const findings = [];
const note = (route, device, severity, kind, detail) =>
  findings.push({ route, device, severity, kind, detail });

// ---------------------------------------------------------------------------
// The measurements. All of this runs in the page.
// ---------------------------------------------------------------------------
const PROBE = () => {
  const vw = window.innerWidth;
  const doc = document.documentElement;
  const out = {
    horizontalScroll: doc.scrollWidth - doc.clientWidth,
    offenders: [], outside: [], overlaps: [], smallTargets: [], snugTargets: [],
    deadImages: [], placeholders: [], clipped: [], fontScale: {},
    emptyHeadings: 0, title: document.title, h1: "",
  };
  const h1 = document.querySelector("h1");
  out.h1 = h1 ? (h1.innerText || "").trim().slice(0, 80) : "";

  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
    const txt = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ` "${txt}"` : ""}`;
  };

  const all = [...document.querySelectorAll("body *")].filter(visible);

  // WHAT IS ACTUALLY PUSHING THE PAGE SIDEWAYS. A bare scrollWidth figure sends
  // you hunting; the element that owns the overflow ends the hunt.
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1) out.offenders.push({ el: describe(el), right: Math.round(r.right), over: Math.round(r.right - vw) });
    if (r.left < -1 && getComputedStyle(el).position !== "fixed") out.outside.push({ el: describe(el), left: Math.round(r.left) });
  }
  out.offenders = out.offenders.slice(0, 12);
  out.outside = out.outside.slice(0, 12);

  // A CONTROL THE CUSTOMER CANNOT ACTUALLY CLICK.
  //
  // This used to flag any two overlapping interactives, which reported every
  // product card on the site: the wishlist heart is deliberately positioned
  // over the card's link, sits above it, and works. Overlap is a design
  // decision; being UNDERNEATH something unrelated is the defect. So ask the
  // browser who receives the click at the control's own centre.
  const controls = [...document.querySelectorAll("button, a[href], input, select, [role=button]")].filter(visible);

  // A CONTROL BEHIND AN OPEN MODAL IS NOT OBSTRUCTED, IT IS DISMISSED. When a
  // dialog is up, only what is inside it is reachable, and that is the point of
  // a dialog. Without this every link on /products reported itself as covered
  // by the offer modal's backdrop.
  // The DIALOG is the modal, not its backdrop. Matching the backdrop made it
  // the scope root — and since an element contains itself, the backdrop was
  // then tested and duly found to be "covered" by the dialog sitting on top of
  // it, which is the entire point of a backdrop.
  const scrim = [...document.querySelectorAll('[role=dialog], [aria-modal="true"], [class*="modal-scrim"], [class*="modal-backdrop"]')].find(visible);
  const dialog = scrim ? (scrim.closest('[role=dialog], [aria-modal="true"]') ?? scrim.querySelector('[role=dialog], [aria-modal="true"]') ?? scrim) : null;
  const scope = dialog
    ? controls.filter((c) => dialog.contains(c) && !/modal-backdrop|modal-scrim/.test(String(c.className)))
    : controls;

  for (const el of scope) {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) continue;   // off-screen is scrolling, not obstruction
    // A COLLAPSED CONTROL IS NOT A BROKEN ONE. The header search renders as an
    // 8px-wide input with aria-hidden and tabindex=-1 until its icon is
    // pressed; reporting the icon as covering it described the closed state as
    // a defect.
    if (r.width < 12 || r.height < 12) continue;
    if (el.getAttribute("aria-hidden") === "true" || el.getAttribute("tabindex") === "-1") continue;
    if (el.closest('[aria-hidden="true"], [inert]')) continue;
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
    // A label, or an overlay that forwards the click, is fine.
    if (hit.closest("label")?.control === el) continue;
    if (getComputedStyle(hit).pointerEvents === "none") continue;
    out.overlaps.push({ a: describe(el), b: describe(hit) });
    if (out.overlaps.length >= 8) break;
  }

  // TAP TARGETS, AGAINST THE STANDARD THAT ACTUALLY APPLIES.
  //
  // WCAG 2.2 AA (2.5.8 Target Size Minimum) is 24x24 CSS px. The familiar 44px
  // is iOS HIG / WCAG AAA — a good bar, not a conformance one. Grading
  // everything against 44 reported the site footer, whose links are 24px BY
  // DECISION and say so in their own comment citing 2.5.8, as a defect on
  // every page. So the two are separated: under 24 fails AA and is a defect;
  // 24 to 43 is below the platform guideline and is recorded as information.
  if (vw <= 480) {
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (!(el.innerText || "").trim()) continue;
      if (r.height >= 44 || r.width >= 44) continue;
      // 2.5.8 EXEMPTS AN INLINE TARGET IN A SENTENCE, whose height is set by
      // the surrounding line-height rather than by any decision about the
      // control. A "Terms" link mid-paragraph is that case; a button is not.
      const inlineInProse = getComputedStyle(el).display.startsWith("inline")
        && el.parentElement && (el.parentElement.innerText || "").trim().length > (el.innerText || "").trim().length + 12;
      const entry = { el: describe(el), w: Math.round(r.width), h: Math.round(r.height) };
      if ((r.height < 24 || r.width < 24) && !inlineInProse) out.smallTargets.push(entry);
      else out.snugTargets.push(entry);
    }
    out.smallTargets = out.smallTargets.slice(0, 10);
    out.snugTargets = out.snugTargets.slice(0, 10);
  }

  // IMAGES: broken, and deliberately blank.
  for (const img of document.querySelectorAll("img")) {
    if (!visible(img)) continue;
    const src = img.currentSrc || img.src || "";
    if (img.complete && img.naturalWidth === 0) out.deadImages.push({ src: src.slice(0, 160), alt: img.alt || "" });
    if (/placeholder|no-image|fallback/i.test(src)) out.placeholders.push({ src: src.slice(0, 120), alt: img.alt || "" });
  }
  out.deadImages = out.deadImages.slice(0, 12);

  // TEXT CUT OFF BY ITS OWN BOX. overflow hidden plus content taller/wider than
  // the box is the shape of a clipped heading.
  for (const el of all) {
    if (el.children.length) continue;
    const t = (el.innerText || "").trim();
    if (t.length < 4) continue;
    const s = getComputedStyle(el);
    if (s.overflow === "visible" && s.overflowX === "visible" && s.overflowY === "visible") continue;
    if (s.textOverflow === "ellipsis" || s.whiteSpace === "nowrap") continue; // deliberate truncation
    if (el.scrollHeight > el.clientHeight + 3 || el.scrollWidth > el.clientWidth + 3) {
      out.clipped.push({ el: describe(el), scroll: `${el.scrollWidth}x${el.scrollHeight}`, box: `${el.clientWidth}x${el.clientHeight}` });
    }
  }
  out.clipped = out.clipped.slice(0, 10);

  // TYPOGRAPHY SPREAD. A page using eleven different body sizes is a page that
  // was assembled, not designed.
  for (const el of all) {
    if (el.children.length) continue;
    if (!(el.innerText || "").trim()) continue;
    const px = Math.round(parseFloat(getComputedStyle(el).fontSize));
    out.fontScale[px] = (out.fontScale[px] ?? 0) + 1;
  }

  out.emptyHeadings = [...document.querySelectorAll("h1,h2,h3")].filter((h) => visible(h) && !(h.innerText || "").trim()).length;
  return out;
};

// ---------------------------------------------------------------------------
async function walk(page, route, device, label, expect404 = false) {
  const console_ = [];
  const failed = [];
  const counts = new Map();
  const onConsole = (m) => { if (["error", "warning"].includes(m.type())) console_.push(`${m.type()}: ${m.text().slice(0, 240)}`); };
  const onPageError = (e) => console_.push(`pageerror: ${String(e).slice(0, 240)}`);
  const onFailed = (r) => failed.push(`${r.failure()?.errorText ?? "failed"} ${r.url().slice(0, 160)}`);
  const onResponse = (r) => {
    const u = r.url();
    counts.set(u, (counts.get(u) ?? 0) + 1);
    if (r.status() >= 400) failed.push(`HTTP ${r.status()} ${u.slice(0, 160)}`);
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onFailed);
  page.on("response", onResponse);

  let status = 0;
  try {
    const res = await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    status = res?.status() ?? 0;
    await page.waitForTimeout(1500);
  } catch (error) {
    note(route, device, "MAJOR", "navigation", String(error).slice(0, 200));
  }

  const probe = await page.evaluate(PROBE).catch((e) => ({ error: String(e) }));
  const slug = `${label}-${device}`.replace(/[^a-z0-9.-]+/gi, "_");
  const shot = `${SHOTS}/${slug}.png`;
  try { await page.screenshot({ path: shot, fullPage: true }); } catch { /* a page mid-navigation */ }

  page.off("console", onConsole); page.off("pageerror", onPageError);
  page.off("requestfailed", onFailed); page.off("response", onResponse);

  // ---- grade it -----------------------------------------------------------
  const vw = device === "phone" ? PHONE.width : DESKTOP.width;
  if (probe.horizontalScroll > 2) {
    note(route, device, device === "phone" ? "MAJOR" : "MINOR", "sideways scroll",
      `${probe.horizontalScroll}px past ${vw}px · ${probe.offenders.slice(0, 3).map((o) => `${o.el} (+${o.over})`).join(" | ") || "no single offender"}`);
  }
  // THE SKIP LINK IS SUPPOSED TO BE OFF-SCREEN AND CLIPPED. It is parked at
  // -9999px in a 1x1 box and only becomes visible on focus — that IS the
  // pattern, and reporting it on all 106 loads buried everything else.
  const notSkipLink = (rows) => (rows ?? []).filter((r) => !/vl-skip-link/.test(r.el ?? ""));
  probe.outside = notSkipLink(probe.outside);
  probe.clipped = notSkipLink(probe.clipped);
  const notByDesign = (rows) => notSkipLink(rows)
    // The /vault staff shortcut is a deliberately discreet 39x24 mark at 15%
    // opacity that steps aside for every customer CTA bar (globals.css).
    .filter((t) => !/vl-staff-shortcut/.test(t.el ?? ""));
  probe.smallTargets = notByDesign(probe.smallTargets);
  probe.snugTargets = notByDesign(probe.snugTargets);
  if (probe.outside?.length) note(route, device, "MINOR", "off-screen left", probe.outside.slice(0, 3).map((o) => `${o.el} @${o.left}`).join(" | "));
  if (probe.overlaps?.length) note(route, device, "MAJOR", "control obstructed", probe.overlaps.slice(0, 3).map((o) => `${o.a} is covered at its centre by ${o.b}`).join(" | "));
  if (probe.smallTargets?.length) note(route, device, "MINOR", "tap target under WCAG 2.2 AA (24px)", probe.smallTargets.slice(0, 4).map((t) => `${t.el} ${t.w}x${t.h}`).join(" | "));
  if (probe.snugTargets?.length) note(route, device, "INFO", "tap target under the 44px guideline (meets AA)", probe.snugTargets.slice(0, 4).map((t) => `${t.el} ${t.w}x${t.h}`).join(" | "));
  if (probe.clipped?.length) note(route, device, "MINOR", "clipped text", probe.clipped.slice(0, 3).map((c) => `${c.el} ${c.scroll} in ${c.box}`).join(" | "));
  if (probe.emptyHeadings) note(route, device, "MINOR", "empty heading", `${probe.emptyHeadings} visible heading(s) with no text`);
  if (probe.placeholders?.length) note(route, device, "INFO", "placeholder image", probe.placeholders.slice(0, 3).map((p) => p.alt || p.src).join(" | "));

  for (const img of probe.deadImages ?? []) {
    const why = artifactFor(img.src);
    note(route, device, why ? "ARTIFACT" : "MAJOR", "image resolved to nothing", `${img.alt || "(no alt)"} ${img.src}${why ? ` — ${why}` : ""}`);
  }
  for (const line of console_) {
    if (expect404 && /status of 404/.test(line)) continue;
    const why = artifactFor(line);
    const hydration = /hydrat|did not match|server rendered HTML/i.test(line);
    note(route, device, why ? "ARTIFACT" : hydration ? "MAJOR" : "MINOR",
      hydration ? "hydration" : "console", `${line}${why ? ` — ${why}` : ""}`);
  }
  for (const line of failed) {
    // The not-found probe is SUPPOSED to 404, and so is its console echo.
    if (expect404 && /\b404\b/.test(line)) continue;
    const why = artifactFor(line);
    note(route, device, why ? "ARTIFACT" : "MAJOR", "failed request", `${line}${why ? ` — ${why}` : ""}`);
  }
  for (const [url, n] of counts) {
    if (n <= 2 || /\.(png|jpg|jpeg|webp|svg|woff2?|css|js)(\?|$)/i.test(url)) continue;
    // THREE COMPONENTS ASKING THE SAME QUESTION AT MOUNT IS NOT A LOOP.
    //
    // /cart mounts the cart page, the cart drawer and the spin prize bar, and
    // each reads /api/offer/status for itself with `cache: "no-store"` — a
    // prize won on another device has to be visible immediately, so none of
    // them may read a cache. The count is bounded by the number of components
    // and does not grow; a genuine render loop would climb without limit.
    // Worth collapsing behind one shared read, but that is a refactor of the
    // reward-display path across three files and it is recorded for the owner
    // rather than done on the eve of a release.
    const bounded = /\/api\/offer\/status$/.test(url) && n <= 3;
    note(route, device, bounded ? "INFO" : "MINOR", bounded ? "bounded duplicate read" : "repeated request",
      `${n}× ${url.slice(0, 150)}${bounded ? " — one per mounted component (cart page, drawer, prize bar), not a loop" : ""}`);
  }

  const sizes = Object.entries(probe.fontScale ?? {}).filter(([, n]) => n >= 3).map(([px]) => Number(px)).sort((a, b) => a - b);
  if (sizes.length > 9) note(route, device, "INFO", "type scale", `${sizes.length} text sizes in use: ${sizes.join(", ")}`);

  return { route, device, status, shot, h1: probe.h1, title: probe.title, sizes };
}

// ---------------------------------------------------------------------------
async function main() {
  await client.connect();
  await loadCatalog();
  const catalog = CATALOG;

  const email = await createConfirmedCustomer(newEmail("visual"));
  const rows = [];

  const routesFor = () => {
    if (process.env.VQ_ROUTES) return process.env.VQ_ROUTES.split(",").map((r) => ({ path: r.trim(), label: r.trim() }));
    const base = [
      { path: "/", label: "home" },
      { path: "/products", label: "catalog" },
      { path: "/products?category=Blends", label: "catalog-filtered" },
      { path: "/cart", label: "cart-empty" },
      { path: "/coa-library", label: "coa-library" },
      { path: "/research", label: "research" },
      { path: "/sms", label: "sms" },
      { path: "/legal/privacy", label: "privacy" },
      { path: "/legal/terms", label: "terms" },
      { path: "/contact", label: "contact" },
      { path: "/ambassador", label: "ambassador" },
      { path: "/wholesale", label: "wholesale" },
      { path: "/account", label: "account" },
      { path: "/account/orders", label: "account-orders" },
      { path: "/account/rewards", label: "account-rewards" },
      { path: "/account/wishlist", label: "account-wishlist" },
      { path: "/account/settings", label: "account-settings" },
      { path: "/spin", label: "spin" },
      // Deliberate: the 404 page has to look like the rest of the shop too.
      { path: "/this-route-does-not-exist", label: "not-found", expect404: true },
    ];
    for (const p of catalog) base.push({ path: `/products/${p.slug}`, label: `pdp-${p.slug}` });
    return base;
  };
  const routes = routesFor();

  for (const device of ["phone", "desktop"]) {
    const ctx = await freshContext({ viewport: device === "phone" ? PHONE : DESKTOP });
    const page = await ctx.newPage();
    await signIn(page, email);
    await dismissConsent(page);
    for (const r of routes) rows.push(await walk(page, r.path, device, r.label, r.expect404 === true));
    await ctx.close();
  }

  // ---- report -------------------------------------------------------------
  const order = { MAJOR: 0, MINOR: 1, INFO: 2, ARTIFACT: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.route.localeCompare(b.route));
  const count = (s) => findings.filter((f) => f.severity === s).length;

  const lines = [
    "# Visual QC crawl — the last look before the merge",
    "",
    `Routes walked: **${routes.length}** × 2 devices (390x844, 1280x900) = **${rows.length}** page loads.`,
    `Screenshots: \`${SHOTS}\``,
    "",
    `| Severity | Count |`, `|---|---|`,
    `| MAJOR | ${count("MAJOR")} |`,
    `| MINOR | ${count("MINOR")} |`,
    `| INFO | ${count("INFO")} |`,
    `| HARNESS ARTIFACT (not a site defect) | ${count("ARTIFACT")} |`,
    "",
  ];
  for (const sev of ["MAJOR", "MINOR", "INFO", "ARTIFACT"]) {
    const rowsOf = findings.filter((f) => f.severity === sev);
    if (!rowsOf.length) continue;
    lines.push(`## ${sev}`, "", "| Route | Device | Kind | Detail |", "|---|---|---|---|");
    for (const f of rowsOf) lines.push(`| \`${f.route}\` | ${f.device} | ${f.kind} | ${String(f.detail).replace(/\|/g, "\\|").slice(0, 300)} |`);
    lines.push("");
  }
  lines.push("## Every page loaded", "", "| Route | Device | HTTP | h1 | Screenshot |", "|---|---|---|---|---|");
  for (const r of rows) lines.push(`| \`${r.route}\` | ${r.device} | ${r.status} | ${(r.h1 || "—").replace(/\|/g, "\\|")} | \`${r.shot.split("/").pop()}\` |`);

  writeFileSync(`${OUT}/visual-qc.md`, lines.join("\n"));
  writeFileSync(`${OUT}/findings.json`, JSON.stringify({ findings, rows }, null, 2));
  console.log(`\nMAJOR ${count("MAJOR")}  MINOR ${count("MINOR")}  INFO ${count("INFO")}  ARTIFACT ${count("ARTIFACT")}`);
  console.log(`report: ${OUT}/visual-qc.md`);
  await client.end();
  process.exit(count("MAJOR") ? 1 : 0);
}

main().catch(async (error) => { console.error(error); try { await client.end(); } catch { /* */ } process.exit(2); });
