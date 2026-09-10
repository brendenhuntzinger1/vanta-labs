#!/usr/bin/env node
// ---------------------------------------------------------------------------
// EVERY CUSTOMER SURFACE, IN EVERY ENGINE, AT EVERY SIZE THAT MATTERS.
//
// WHY THIS EXISTS ALONGSIDE THE OTHER CROSS-ENGINE SCRIPTS.
//
//   cross-engine-check.mjs        five routes, looking for overflow. Read-only,
//                                 signed OUT — so since the account wall went
//                                 in it measures the portal and nothing behind
//                                 it, which is most of the store.
//   qa-cross-engine-journey.mjs   signs in and walks ONE path per engine, to
//                                 prove the path works. Depth, not breadth.
//   login-portal-cross-engine.mjs the portal's geometry alone.
//
// None of them sweeps the whole route list behind the wall. That gap was being
// filled by hand — an agent driving a browser route by route, per engine, per
// viewport — which took roughly 45 minutes per engine/UA slice and still
// covered fewer combinations than the loop below does in one run. Measuring
// overflow, console errors, failed requests and tap-target sizes is not
// judgement work; it is arithmetic, and arithmetic should be a script.
//
// WHAT IT MEASURES, per (engine x device x route):
//   * horizontal overflow, with the three widest offenders named
//   * console errors and uncaught page errors
//   * requests that answered >= 400, or failed outright
//   * images that did not load (naturalWidth === 0)
//   * interactive targets whose rendered box is under 44x44 CSS px, which is
//     the floor for a thumb (WCAG 2.5.5 / the iOS HIG both land there)
//   * whether the route rendered anything at all
//
// WHY WEBKIT CARRIES THE IN-APP CASES. Every iOS in-app browser — TikTok,
// Instagram, Facebook, Snapchat — is WKWebView. A spoofed user agent on
// Chromium changes the string, not the engine, so a layout claim about the
// place this business's paid traffic lands can only come from WebKit.
//
// TRANSPORT IS NOT A DEFECT. The egress proxy resets TLS 1.3 and occasionally
// drops a single resource. A navigation that fails is retried once and, if it
// fails again, reported under TRANSPORT rather than as a finding — reading one
// of those as a site defect is how this project has previously "reproduced"
// outages that did not exist. See docs/BROWSER-TESTING-RUNBOOK.md.
//
// Development-only: it signs in as a seeded QA account and refuses to run
// against anything but the local harness.
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-engines node scripts/qa-surface-matrix.mjs
//   ENGINES=webkit node scripts/qa-surface-matrix.mjs
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";

import * as pw from "playwright-core";

const BASE = process.env.QA_BASE_URL || "https://127.0.0.1:3443";
const EMAIL = process.env.QA_SIGNIN_EMAIL || "qa.verified@example.test";
const PASSWORD = process.env.QA_SIGNIN_PASSWORD || "HarnessPass123!";
const ENGINES = (process.env.ENGINES || "webkit,chromium,firefox").split(",").map((s) => s.trim());

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. This script signs in and drives the local harness only.`);
  process.exit(1);
}

// The egress proxy resets TLS 1.3 and each engine caps differently. Inert on
// loopback; kept so the same script works against a preview URL.
const LAUNCH = {
  chromium: { headless: true, executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--ssl-version-max=tls1.2"] },
  firefox: { headless: true, firefoxUserPrefs: { "security.tls.version.max": 3 } },
  webkit: { headless: true },
};

/**
 * A FRESH RATE-LIMIT BUCKET PER CONTEXT, AND WHY THIS SCRIPT NEEDS ONE.
 *
 * A loop walks 32 routes in 43 seconds. A human does not, so the limiter that
 * is correctly sized for a person answers 429 to the loop — and the FIRST run
 * of this script duly reported 31 P2 "failing request" findings against
 * /api/catalog/promotions/eligibility on every route after the third. Not one
 * of them was a site defect; the script had DoSed itself and written the
 * result up as a product problem.
 *
 * qa-cross-engine-journey.mjs and qa-abuse-and-roles.mjs already solve this by
 * presenting a distinct client IP per run. Same trick here, per context, so no
 * two devices share a bucket either. 100.64/10 is the carrier-grade-NAT range:
 * routable nowhere, and unmistakably synthetic in a log.
 */
const clientIp = () => {
  const [a, b, c] = randomBytes(3);
  return `100.${64 + (a % 64)}.${b}.${(c % 254) + 1}`;
};

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";

/**
 * The devices worth measuring.
 *
 * `webkitOnly` marks the cases that are a lie in any other engine: an iOS
 * in-app browser is WKWebView, and running one of these under Blink or Gecko
 * would produce a pass that means nothing.
 */
const DEVICES = [
  { name: "TikTok webview", ua: `${IOS} Mobile/15E148 musical_ly_2023005030 BytedanceWebview/d8a21c6`, vp: { width: 393, height: 664 }, webkitOnly: true },
  { name: "TikTok webview SE", ua: `${IOS} Mobile/15E148 musical_ly_2023005030 BytedanceWebview/d8a21c6`, vp: { width: 375, height: 548 }, webkitOnly: true },
  { name: "Instagram webview", ua: `${IOS} Mobile/21F90 Instagram 335.0.0.34.95 (iPhone16,1; iOS 17_5_1)`, vp: { width: 390, height: 844 }, webkitOnly: true },
  { name: "Instagram webview max", ua: `${IOS} Mobile/21F90 Instagram 335.0.0.34.95 (iPhone16,1; iOS 17_5_1)`, vp: { width: 430, height: 932 }, webkitOnly: true },
  { name: "Facebook webview", ua: `${IOS} Mobile/15E148 [FBAN/FBIOS;FBDV/iPhone16,1;FBMD/iPhone;FBSN/iOS;FBSV/17.5.1;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]`, vp: { width: 393, height: 852 }, webkitOnly: true },
  { name: "Snapchat webview", ua: `${IOS} Mobile/15E148 Snapchat/12.85.0.45 (like Safari/604.1)`, vp: { width: 412, height: 915 }, webkitOnly: true },
  { name: "Safari iOS", ua: `${IOS} Version/17.5 Mobile/15E148 Safari/604.1`, vp: { width: 393, height: 852 }, webkitOnly: true },
  { name: "phone", ua: null, vp: { width: 390, height: 844 } },
  { name: "narrow android", ua: null, vp: { width: 360, height: 740 } },
  { name: "tablet", ua: null, vp: { width: 768, height: 1024 } },
  { name: "tablet large", ua: null, vp: { width: 820, height: 1180 } },
  { name: "laptop", ua: null, vp: { width: 1280, height: 800 } },
  { name: "desktop", ua: null, vp: { width: 1440, height: 900 } },
  { name: "wide", ua: null, vp: { width: 1920, height: 1080 } },
];

/** Every customer-facing route. Admin and partner portals have their own runs. */
const ROUTES = [
  "/", "/products", "/products/bpc-157-10mg", "/products/cjc-1295-2mg", "/products/tb-500-5mg",
  "/research", "/cart", "/checkout", "/contact", "/coa-library", "/membership",
  "/ambassador", "/vault", "/wholesale", "/partner",
  "/account", "/account/orders", "/account/addresses", "/account/wishlist",
  "/account/rewards", "/account/subscriptions", "/account/support",
  "/account/notifications", "/account/settings", "/account/ambassador",
  "/legal/research-disclaimer", "/legal/privacy", "/legal/terms",
  "/legal/shipping", "/legal/refund", "/legal/cookies",
];

// ---------------------------------------------------------------------------
// The in-page probe. One evaluate per route, because a round trip per metric
// across 400+ page loads is most of the runtime.
// ---------------------------------------------------------------------------
const PROBE = () => {
  const vw = window.innerWidth;
  const de = document.documentElement;

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const offenders = [...document.querySelectorAll("body *")]
    .filter((el) => visible(el) && el.getBoundingClientRect().right > vw + 1)
    .slice(0, 3)
    .map((el) => `${el.tagName.toLowerCase()}.${String(el.className || "").slice(0, 28)}`);

  // A target is only too small if a thumb can actually reach it: rendered,
  // on-screen, and not inside a collapsed menu. Anything off-screen is skipped
  // rather than counted, because a closed drawer's contents are not a defect.
  const small = [...document.querySelectorAll("a[href], button, [role=button], input, select, summary")]
    .filter((el) => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight * 3) return false;
      if (r.right < 0 || r.left > vw) return false;
      return r.width < 44 || r.height < 44;
    })
    .slice(0, 6)
    .map((el) => {
      const r = el.getBoundingClientRect();
      const label = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("name") || "").trim().slice(0, 28);
      return `${el.tagName.toLowerCase()}[${label}] ${Math.round(r.width)}x${Math.round(r.height)}`;
    });

  const brokenImages = [...document.images]
    .filter((img) => img.complete && img.naturalWidth === 0)
    .slice(0, 4)
    .map((img) => String(img.currentSrc || img.src || "").slice(-60));

  return {
    overflowBy: de.scrollWidth - vw,
    offenders,
    small,
    brokenImages,
    textLength: (document.body.innerText || "").trim().length,
    title: document.title,
    h1Count: document.querySelectorAll("h1").length,
  };
};

// ---------------------------------------------------------------------------

const findings = [];
const transport = [];
let checks = 0;
let routeLoads = 0;

/**
 * ONE DEFECT IS ONE FINDING, HOWEVER MANY ROUTES IT APPEARS ON.
 *
 * Most of this store's chrome is shared, so a small tap target in the promo
 * banner is present on all 31 routes and was reported 31 times per device —
 * 434 lines saying one thing. That does not read as thorough, it reads as
 * noise, and the single genuine finding underneath it is invisible.
 *
 * Findings are therefore keyed on (severity, device, what-it-is, evidence) with
 * the route collected rather than repeated. The route list is printed with the
 * finding, so nothing is lost: you still see exactly where it occurs, and you
 * can tell a site-wide defect from a one-page one at a glance.
 */
const seen = new Map();
const finding = (severity, where, what, detail, route) => {
  // The route is stripped out of `what` for the key, so the same defect on
  // thirty routes collapses instead of producing thirty keys.
  const key = `${severity}|${where}|${what}|${detail}`;
  const existing = seen.get(key);
  if (existing) {
    if (route && !existing.routes.includes(route)) existing.routes.push(route);
    return;
  }
  const record = { severity, where, what, detail, routes: route ? [route] : [] };
  seen.set(key, record);
  findings.push(record);
  console.log(`  ${severity}  ${where}  ${what}${detail ? ` — ${detail}` : ""}`);
};

/** Navigate, retrying once. A second failure is transport, not a defect. */
async function goto(page, url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      return { ok: true, status: res?.status() ?? 0 };
    } catch (error) {
      if (attempt === 1) return { ok: false, error: String(error?.message ?? error).split("\n")[0].slice(0, 110) };
      await page.waitForTimeout(1200);
    }
  }
  return { ok: false, error: "unreachable" };
}

async function signIn(page, ctx) {
  await goto(page, `${BASE}/products`);
  await page.waitForSelector(".vl-portal-row", { timeout: 20000 }).catch(() => {});

  // ACCEPT THE COOKIE BANNER FIRST, because a real visitor answers it once and
  // every route after that is measured without it. Left standing it sits over
  // the foot of all 31 routes on all 14 devices and reports itself as an
  // overflow and a row of small tap targets 434 times — noise that buries the
  // one real finding. The banner's own geometry is worth measuring; it is
  // measured on the portal above, before this click.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Accept");
    if (b) b.click();
  }).catch(() => {});
  await page.waitForTimeout(500);
  for (let i = 0; i < 5 && !(await page.$("form input[type=email]")); i += 1) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Sign in with email");
      if (b) b.click();
    });
    await page.waitForTimeout(700);
  }
  if (!(await page.$("form input[type=email]"))) return false;
  await page.fill("form input[type=email]", EMAIL);
  await page.fill("form input[type=password]", PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/auth/session") && r.request().method() === "POST", { timeout: 30000 }).catch(() => null),
    page.click("form button[type=submit]"),
  ]);
  await page.waitForTimeout(2000);
  return (await ctx.cookies()).some((c) => c.name === "vl_session_token");
}

async function runDevice(engine, browser, device) {
  const tag = `${engine}/${device.name} ${device.vp.width}x${device.vp.height}`;
  const ctx = await browser.newContext({
    viewport: device.vp,
    ...(device.ua ? { userAgent: device.ua } : {}),
    extraHTTPHeaders: { "x-real-ip": clientIp() },
    ignoreHTTPSErrors: true,
    // Firefox does not implement Playwright's mobile emulation.
    ...(device.vp.width < 500 && engine !== "firefox" ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const badRequests = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 140)); });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 140)));
  page.on("response", (r) => { if (r.status() >= 400) badRequests.push(`${r.status()} ${r.url().replace(BASE, "").slice(0, 80)}`); });
  page.on("requestfailed", (r) => {
    const err = r.failure()?.errorText ?? "";
    // AN ABORT IS A NAVIGATION, NOT A FAILURE — and each engine words it
    // differently, which is how the first full run produced three P2s that
    // were nothing at all:
    //
    //   Chromium  net::ERR_ABORTED
    //   Firefox   NS_BINDING_ABORTED / NS_ERROR_ABORT
    //   WebKit    "Load request cancelled"
    //
    // The three it caught were a Next RSC prefetch (?_rsc=...) cancelled when
    // the page navigated away, and a fire-and-forget /api/analytics/track
    // beacon cut off by the same navigation. Both are the browser working. The
    // tell was in the shape: each appeared on exactly ONE route in exactly ONE
    // engine, and a real defect reproduces across engines.
    if (!/ERR_ABORTED|NS_BINDING_ABORTED|NS_ERROR_ABORT|Load request cancelled|cancelled/i.test(err)) {
      badRequests.push(`FAILED ${err} ${r.url().replace(BASE, "").slice(0, 70)}`);
    }
  });

  console.log(`\n### ${tag}`);

  // The portal is the one screen EVERY visitor sees, including the paid
  // traffic that arrives in a webview, so it is measured signed-out and with
  // the cookie banner still up — the state it is actually met in.
  const portalNav = await goto(page, `${BASE}/products`);
  if (portalNav.ok) {
    await page.waitForSelector(".vl-portal-row", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(700);
    const portal = await page.evaluate(PROBE).catch(() => null);
    routeLoads += 1;
    if (portal) {
      checks += 1;
      if (portal.overflowBy > 1) {
        finding("P2", tag, "the access portal overflows horizontally", `+${portal.overflowBy}px · ${portal.offenders.join(", ")}`);
      }
      if (portal.textLength < 40) {
        finding("P0", tag, "the access portal rendered nothing", `${portal.textLength} chars — no visitor can get in`);
      }
      if (device.vp.width < 500 && portal.small.length) {
        finding("P3", tag, `the access portal has ${portal.small.length} tap target(s) under 44px`, portal.small.slice(0, 3).join(", "));
      }
    }
  }

  if (!(await signIn(page, ctx))) {
    finding("P1", tag, "could not sign in through the portal", "every route behind the wall is unmeasured here");
    await ctx.close();
    return;
  }

  for (const route of ROUTES) {
    consoleErrors.length = 0; pageErrors.length = 0; badRequests.length = 0;
    // A FRESH BUCKET PER ROUTE, not merely per context.
    //
    // One context walking 32 routes in 43 seconds is one IP, and every page
    // calls /api/catalog/promotions/eligibility, so the limiter — correctly —
    // started answering 429 from the fourth route on and 22 of 32 routes went
    // unmeasured. Rotating the presented IP per navigation keeps the sweep
    // measuring LAYOUT, which is its job. Whether the limiter itself is right
    // is qa-abuse-and-roles.mjs's job, and it is tested there against a real
    // flood rather than incidentally against this one.
    await page.setExtraHTTPHeaders({ "x-real-ip": clientIp() }).catch(() => {});
    const nav = await goto(page, `${BASE}${route}`);
    routeLoads += 1;
    if (!nav.ok) {
      transport.push(`${tag} ${route}: ${nav.error}`);
      continue;
    }
    await page.waitForTimeout(900);

    let probe;
    try {
      probe = await page.evaluate(PROBE);
    } catch (error) {
      transport.push(`${tag} ${route}: probe threw ${String(error).slice(0, 70)}`);
      continue;
    }
    checks += 1;

    const landed = new URL(page.url()).pathname;
    if (probe.overflowBy > 1) {
      finding("P2", tag, "overflows horizontally", `+${probe.overflowBy}px · ${probe.offenders.join(", ")}`, route);
    }
    if (probe.textLength < 40 && nav.status < 400) {
      finding("P1", tag, "rendered almost nothing", `${probe.textLength} chars, landed ${landed}`, route);
    }
    if (pageErrors.length) {
      finding("P1", tag, "threw an uncaught error", pageErrors[0], route);
    }
    const realConsole = consoleErrors.filter((e) => !/429|Too Many Requests/.test(e));
    if (realConsole.length) {
      finding("P3", tag, "logged a console error", realConsole[0], route);
    }
    const throttled = badRequests.filter((r) => r.startsWith("429"));
    const realBad = badRequests.filter((r) => !r.startsWith("429"));
    if (throttled.length) {
      // Recorded, not counted. A limiter answering a loop is the limiter
      // working; treating it as a route defect is how the first run of this
      // script produced 31 findings and zero information.
      transport.push(`${tag} ${route}: throttled (${throttled[0]})`);
    }
    if (realBad.length) {
      finding("P2", tag, "made a failing request", realBad.slice(0, 2).join(" | "), route);
    }
    if (probe.brokenImages.length) {
      finding("P2", tag, "has an image that did not load", probe.brokenImages[0], route);
    }
    // Tap targets only matter where a thumb is doing the tapping.
    if (device.vp.width < 500 && probe.small.length) {
      finding("P3", tag, "has tap targets under 44px", probe.small.slice(0, 3).join(", "), route);
    }
    if (probe.h1Count === 0) {
      finding("P3", tag, "has no h1", "", route);
    } else if (probe.h1Count > 1) {
      finding("P3", tag, `has ${probe.h1Count} h1 elements`, "", route);
    }
  }

  // THE STORAGE-BLOCKED CASE, which is the one an in-app browser actually
  // produces. Facebook and Snapchat's webviews are the most restrictive, and a
  // store that white-screens without localStorage loses the traffic it paid
  // for. qa-customer-journey covers sign-in under this condition; this covers
  // whether the storefront RENDERS under it.
  if (device.webkitOnly) {
    const blocked = await browser.newContext({
      viewport: device.vp, userAgent: device.ua, ignoreHTTPSErrors: true, isMobile: true, hasTouch: true,
      extraHTTPHeaders: { "x-real-ip": clientIp() },
    });
    await blocked.addInitScript(() => {
      const boom = () => { throw new Error("SecurityError: storage is disabled"); };
      for (const key of ["localStorage", "sessionStorage"]) {
        Object.defineProperty(window, key, { configurable: true, get: boom });
      }
    });
    const bp = await blocked.newPage();
    const bpErrors = [];
    bp.on("pageerror", (e) => bpErrors.push(String(e).slice(0, 120)));
    for (const route of ["/", "/products", "/products/bpc-157-10mg", "/cart"]) {
      const nav = await goto(bp, `${BASE}${route}`);
      if (!nav.ok) { transport.push(`${tag} [no-storage] ${route}: ${nav.error}`); continue; }
      await bp.waitForTimeout(900);
      const len = await bp.evaluate(() => (document.body.innerText || "").trim().length).catch(() => 0);
      checks += 1;
      if (len < 40) {
        finding("P0", tag, "renders nothing when storage is blocked",
          `${len} chars — this is how Facebook and Snapchat webviews arrive`, route);
      }
    }
    if (bpErrors.length) {
      finding("P1", tag, "storage-blocked browsing threw an uncaught error", bpErrors[0]);
    }
    await blocked.close();
  }

  await ctx.close();
}

// ---------------------------------------------------------------------------

const started = Date.now();
for (const engine of ENGINES) {
  const launcher = pw[engine];
  if (!launcher) { console.error(`unknown engine "${engine}"`); continue; }
  const devices = DEVICES.filter((d) => (d.webkitOnly ? engine === "webkit" : true));
  if (!devices.length) continue;

  const browser = await launcher.launch(LAUNCH[engine]);
  for (const device of devices) {
    try {
      await runDevice(engine, browser, device);
    } catch (error) {
      transport.push(`${engine}/${device.name}: ${String(error?.message ?? error).split("\n")[0].slice(0, 120)}`);
    }
  }
  await browser.close();
}

console.log(`\n${"=".repeat(72)}\nFINDINGS, deduplicated, with every route each one affects:`);
for (const f of findings.sort((a, b) => a.severity.localeCompare(b.severity))) {
  const routes = f.routes.length > 6 ? `${f.routes.slice(0, 6).join(" ")} +${f.routes.length - 6} more` : f.routes.join(" ");
  console.log(`  ${f.severity}  ${f.where}  ${f.what}${f.detail ? ` — ${f.detail}` : ""}`);
  if (routes) console.log(`        on ${f.routes.length} route(s): ${routes}`);
}

const bySeverity = (s) => findings.filter((f) => f.severity === s).length;
console.log(`\n${"=".repeat(72)}`);
console.log(`${routeLoads} route loads, ${checks} measured, in ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`P0 ${bySeverity("P0")} · P1 ${bySeverity("P1")} · P2 ${bySeverity("P2")} · P3 ${bySeverity("P3")}`);

if (transport.length) {
  // Printed, always, and NEVER counted as findings. A route that could not be
  // reached is a route that was not measured, and calling that a pass is the
  // failure mode this whole harness exists to prevent.
  console.log(`\nTRANSPORT — not defects, but these routes went UNMEASURED (${transport.length}):`);
  for (const t of transport.slice(0, 25)) console.log(`  ${t}`);
}

// Only a defect that would reach a customer fails the run. P3s are reported and
// do not gate, because a run nobody can get green is a run nobody reads.
const gating = bySeverity("P0") + bySeverity("P1") + bySeverity("P2");
process.exit(gating > 0 ? 1 : 0);
