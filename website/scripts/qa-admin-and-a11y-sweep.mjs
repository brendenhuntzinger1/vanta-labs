#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE ADMIN AREA AND THE STATIC ACCESSIBILITY RULES, MEASURED RATHER THAN READ.
//
// Two audit slices were being driven by hand, an agent clicking through page by
// page, at roughly 45 minutes each. Almost none of it is judgement:
//
//   * "does /admin/coupons render, or 500, or come back an empty shell"
//   * "does dropping the admin cookie actually refuse every one of these"
//   * "does every input have a label, every image alt text, every page one h1"
//   * "is the buy button's contrast above 4.5:1"
//   * "can the purchase path be walked with the keyboard alone"
//
// Every one of those is arithmetic over the DOM. What genuinely needs a reader
// is whether a NUMBER on a dashboard is wrong, and that is left to an agent.
//
// Development-only. Read-only against the admin area: it opens pages and
// measures them, and changes no setting, price, coupon, product or stock.
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-engines node scripts/qa-admin-and-a11y-sweep.mjs
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";

import * as pw from "playwright-core";

const BASE = process.env.QA_BASE_URL || "https://127.0.0.1:3443";
const PLAIN = process.env.QA_PLAIN_URL || "http://127.0.0.1:3000";
const ADMIN_USER = process.env.QA_ADMIN_USER ?? "qaadmin";
const ADMIN_PASS = process.env.QA_ADMIN_PASS ?? "QaAdmin123!Pass";
const EMAIL = process.env.QA_SIGNIN_EMAIL || "qa.verified@example.test";
const PASSWORD = process.env.QA_SIGNIN_PASSWORD || "HarnessPass123!";

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. Local harness only.`);
  process.exit(1);
}

const LAUNCH = {
  chromium: { headless: true, executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--ssl-version-max=tls1.2"] },
  webkit: { headless: true },
};

/** A fresh rate-limit bucket per navigation — see qa-surface-matrix.mjs. */
const clientIp = () => {
  const [a, b, c] = randomBytes(3);
  return `100.${64 + (a % 64)}.${b}.${(c % 254) + 1}`;
};

const ADMIN_ROUTES = [
  "/admin", "/admin/account", "/admin/ads", "/admin/affiliates/emails", "/admin/audit-log",
  "/admin/cart-recovery", "/admin/coa", "/admin/content", "/admin/coupons", "/admin/customers",
  "/admin/email", "/admin/fulfillment", "/admin/fulfillment/workstation", "/admin/inventory",
  "/admin/membership", "/admin/orders", "/admin/partners", "/admin/payments",
  "/admin/payments/settings", "/admin/policies", "/admin/products", "/admin/promotions",
  "/admin/reconciliation", "/admin/revenue", "/admin/settings", "/admin/status", "/admin/team",
];

const CUSTOMER_ROUTES = [
  "/", "/products", "/products/bpc-157-10mg", "/research", "/cart", "/checkout", "/contact",
  "/coa-library", "/membership", "/ambassador", "/account", "/account/orders", "/account/settings",
  "/legal/refund", "/legal/privacy",
];

const findings = [];
const transport = [];
let checks = 0;

const finding = (severity, area, what, detail) => {
  findings.push({ severity, area, what, detail });
  console.log(`  ${severity}  ${area}  ${what}${detail ? ` — ${detail}` : ""}`);
};

async function goto(page, url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.setExtraHTTPHeaders({ "x-real-ip": clientIp() }).catch(() => {});
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      return { ok: true, status: res?.status() ?? 0 };
    } catch (error) {
      if (attempt === 1) return { ok: false, error: String(error?.message ?? error).split("\n")[0].slice(0, 100) };
      await page.waitForTimeout(1000);
    }
  }
  return { ok: false, error: "unreachable" };
}

// ---------------------------------------------------------------------------
// The static accessibility probe. WCAG rules that are decidable from the DOM.
// ---------------------------------------------------------------------------
const A11Y = () => {
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const labelled = (el) => {
    if (el.getAttribute("aria-label")?.trim()) return true;
    if (el.getAttribute("aria-labelledby")?.trim()) return true;
    if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return true;
    if (el.closest("label")) return true;
    if (el.getAttribute("type") === "hidden") return true;
    if (el.getAttribute("title")?.trim()) return true;
    return false;
  };

  const unlabelled = [...document.querySelectorAll("input, select, textarea")]
    .filter((el) => visible(el) && !labelled(el))
    .slice(0, 5)
    .map((el) => `${el.tagName.toLowerCase()}[type=${el.getAttribute("type") ?? "text"}][name=${el.getAttribute("name") ?? "?"}]`);

  const imagesNoAlt = [...document.querySelectorAll("img")]
    .filter((el) => visible(el) && el.getAttribute("alt") === null && el.getAttribute("aria-hidden") !== "true")
    .slice(0, 5)
    .map((el) => String(el.currentSrc || el.src || "").slice(-50));

  // Heading order: a jump of more than one level is a skipped level.
  const levels = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
    .filter(visible)
    .map((h) => Number(h.tagName.slice(1)));
  const skips = [];
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i] - levels[i - 1] > 1) skips.push(`h${levels[i - 1]}->h${levels[i]}`);
  }

  const srgb = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (rgb) => 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2]);

  // LET THE BROWSER CONVERT THE COLOUR. Tailwind 4 emits oklab(), and a regex
  // that scrapes the first three numbers out of
  //   oklab(0.999994 0.0000455677 0.0000200868 / 0.7)
  // reads white-at-70% as rgb(0,0,0) and reports 1.07:1 against a near-black
  // page. The first run of this script produced fifteen such "failures" on text
  // that actually sits at about 15:1. Painting the colour and reading the pixel
  // back handles every syntax the browser supports, now and later.
  const probe = document.createElement("canvas");
  probe.width = 1; probe.height = 1;
  const pctx = probe.getContext("2d", { willReadFrequently: true });
  const toRgba = (value) => {
    if (!value) return null;
    pctx.clearRect(0, 0, 1, 1);
    pctx.fillStyle = "#000";
    pctx.fillStyle = value;             // ignored if the browser cannot parse it
    if (pctx.fillStyle === "#000000" && !/^#0{3,6}$|black|rgba?\(0, ?0, ?0/.test(value)) return null;
    pctx.clearRect(0, 0, 1, 1);
    pctx.fillRect(0, 0, 1, 1);
    const d = pctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };

  /** Composite a translucent colour over what is behind it, as a renderer does. */
  const over = (fg, bg) => [0, 1, 2].map((i) => Math.round(fg[i] * fg[3] + bg[i] * (1 - fg[3])));

  // Walk up for the first background with real opacity.
  const bgOf = (el) => {
    let node = el;
    while (node) {
      const c = toRgba(getComputedStyle(node).backgroundColor);
      if (c && c[3] > 0.5) return [c[0], c[1], c[2]];
      node = node.parentElement;
    }
    return [11, 11, 11];
  };

  const contrastIssues = [];
  const notAssessable = [];
  const sample = [...document.querySelectorAll("main a, main button, main p, main span, main li, h1, h2")]
    .filter((el) => visible(el) && (el.textContent || "").trim().length > 1)
    .slice(0, 120);
  for (const el of sample) {
    const cs = getComputedStyle(el);

    // GRADIENT-CLIPPED TEXT CANNOT BE JUDGED FROM THE DOM, AND MUST NOT BE
    // JUDGED AS BLACK. `background-clip: text` paints the glyphs with the
    // element's background image and sets the colour to transparent, so reading
    // `color` gives rgba(0,0,0,0) — which composited against the page yields a
    // perfect 1.00:1 and reads as invisible text. /products' h1 is exactly this:
    // a white gradient, entirely legible, reported as the worst failure on the
    // site by the first run of this script.
    //
    // Recorded rather than skipped, because "cannot be measured here" is not
    // "passes" — these need an eye, or a screenshot-based check.
    const clip = cs.webkitBackgroundClip || cs.backgroundClip;
    if (clip === "text" || cs.webkitTextFillColor === "rgba(0, 0, 0, 0)") {
      notAssessable.push(`${el.tagName.toLowerCase()} "${(el.textContent || "").trim().slice(0, 24)}" (gradient text)`);
      continue;
    }

    const fgRaw = toRgba(cs.color);
    if (!fgRaw) continue;
    const bg = bgOf(el);
    // Text at 70% white over a dark page is what the eye actually sees, so the
    // ratio is computed on the composited colour rather than on the declared one.
    const fg = over(fgRaw, bg);
    const l1 = lum(fg); const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const floor = large ? 3 : 4.5;
    if (ratio < floor) {
      contrastIssues.push(`${el.tagName.toLowerCase()} "${(el.textContent || "").trim().slice(0, 24)}" ${ratio.toFixed(2)}:1 (needs ${floor})`);
    }
  }

  return {
    unlabelled,
    imagesNoAlt,
    h1Count: [...document.querySelectorAll("h1")].filter(visible).length,
    skips: skips.slice(0, 3),
    landmarks: {
      main: document.querySelectorAll("main").length,
      nav: document.querySelectorAll("nav").length,
      footer: document.querySelectorAll("footer").length,
    },
    lang: document.documentElement.getAttribute("lang") || "",
    contrast: contrastIssues.slice(0, 4),
    notAssessable: notAssessable.slice(0, 3),
    contrastChecked: sample.length,
  };
};

async function signInCustomer(page, ctx) {
  await goto(page, `${BASE}/products`);
  await page.waitForSelector(".vl-portal-row", { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Accept");
    if (b) b.click();
  }).catch(() => {});
  await page.waitForTimeout(400);
  for (let i = 0; i < 5 && !(await page.$("form input[type=email]")); i += 1) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Sign in with email");
      if (b) b.click();
    });
    await page.waitForTimeout(600);
  }
  if (!(await page.$("form input[type=email]"))) return false;
  await page.fill("form input[type=email]", EMAIL);
  await page.fill("form input[type=password]", PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/auth/session") && r.request().method() === "POST", { timeout: 30000 }).catch(() => null),
    page.click("form button[type=submit]"),
  ]);
  await page.waitForTimeout(1500);
  return (await ctx.cookies()).some((c) => c.name === "vl_session_token");
}

// ---------------------------------------------------------------------------

const started = Date.now();
const browser = await pw.chromium.launch(LAUNCH.chromium);

// --- 1. THE ADMIN AREA ------------------------------------------------------
console.log("\n### admin surfaces (chromium 1440x900)");

const loginRes = await fetch(`${PLAIN}/api/admin/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: PLAIN },
  body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
});
const adminCookie = loginRes.headers.getSetCookie?.().find((c) => c.startsWith("vl_admin_session="));

if (!adminCookie) {
  finding("P1", "admin", "could not obtain an admin session", `${loginRes.status} — every admin page is unmeasured`);
} else {
  const value = adminCookie.split(";")[0].split("=").slice(1).join("=");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  await ctx.addCookies([{ name: "vl_admin_session", value, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const bad = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 120)); });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 120)));
  page.on("response", (r) => { if (r.status() >= 500) bad.push(`${r.status()} ${r.url().replace(BASE, "").slice(0, 70)}`); });

  for (const route of ADMIN_ROUTES) {
    consoleErrors.length = 0; pageErrors.length = 0; bad.length = 0;
    const nav = await goto(page, `${BASE}${route}`);
    if (!nav.ok) { transport.push(`admin ${route}: ${nav.error}`); continue; }
    await page.waitForTimeout(1100);
    checks += 1;

    const state = await page.evaluate(() => ({
      text: (document.body.innerText || "").trim(),
      landed: window.location.pathname,
      hasSkeleton: /loading|please wait/i.test(document.body.innerText || ""),
    })).catch(() => null);
    if (!state) { transport.push(`admin ${route}: probe threw`); continue; }

    if (/\/admin\/login|\/account\/login/.test(state.landed)) {
      finding("P1", "admin", `${route} bounced an authenticated admin to a login page`, `landed ${state.landed}`);
    } else if (state.text.length < 60) {
      finding("P1", "admin", `${route} rendered almost nothing`, `${state.text.length} chars`);
    }
    if (nav.status >= 500) finding("P1", "admin", `${route} answered ${nav.status}`, "");
    if (pageErrors.length) finding("P1", "admin", `${route} threw an uncaught error`, pageErrors[0]);
    if (bad.length) finding("P2", "admin", `${route} made a 5xx request`, bad[0]);
    // The shim implements no realtime channel (BROWSER-TESTING-RUNBOOK: "Storage
    // / realtime — Not implemented"), so a failed websocket here is the harness,
    // not the page. Recorded, never counted.
    const realConsole = consoleErrors.filter((e) => !/websocket|realtime\/v1/i.test(e));
    if (consoleErrors.length !== realConsole.length) {
      transport.push(`admin ${route}: realtime websocket unavailable in the harness`);
    }
    if (realConsole.length) finding("P3", "admin", `${route} logged a console error`, realConsole[0]);
  }

  await ctx.close();

  // --- 2. THE GUARD ---------------------------------------------------------
  // Every admin route must refuse a caller with no admin cookie, and refuse by
  // redirecting rather than by 500ing or rendering a blank page. "Locked" and
  // "secure" are different claims; a 500 is neither.
  console.log("\n### admin guard (no cookie)");
  const anon = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const anonPage = await anon.newPage();
  let refused = 0;
  for (const route of ADMIN_ROUTES) {
    const nav = await goto(anonPage, `${BASE}${route}`);
    if (!nav.ok) { transport.push(`guard ${route}: ${nav.error}`); continue; }
    await anonPage.waitForTimeout(300);
    checks += 1;
    const landed = new URL(anonPage.url()).pathname;
    // WHAT "REFUSED" ACTUALLY LOOKS LIKE HERE.
    //
    // This accepted only /admin/login, /account/login or /, and the wall
    // redirects to /vault — which IS the admin login portal, deliberately named
    // so that the door is not advertised. The first run of this script
    // therefore reported all 27 admin routes as wide open to an anonymous
    // caller: twenty-seven P0s against a guard that was working perfectly.
    //
    // The honest test is "did the admin page render", not "did it land on a
    // path I recognised". Anywhere other than the admin route it asked for
    // means the request did not get what it came for.
    if (!landed.startsWith("/admin")) { refused += 1; continue; }
    if (nav.status >= 500) {
      finding("P1", "admin-guard", `${route} answered ${nav.status} to an anonymous caller`, "refusing by crashing is not refusing");
    } else {
      finding("P0", "admin-guard", `${route} did NOT refuse an anonymous caller`, `landed ${landed} (${nav.status})`);
    }
  }
  console.log(`  ${refused}/${ADMIN_ROUTES.length} admin routes refused an anonymous caller`);
  await anon.close();
}

// --- 3. STATIC ACCESSIBILITY ------------------------------------------------
console.log("\n### static accessibility (chromium 1440x900, signed in)");
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  if (!(await signInCustomer(page, ctx))) {
    finding("P1", "a11y", "could not sign in", "every route behind the wall is unmeasured");
  } else {
    for (const route of CUSTOMER_ROUTES) {
      const nav = await goto(page, `${BASE}${route}`);
      if (!nav.ok) { transport.push(`a11y ${route}: ${nav.error}`); continue; }
      await page.waitForTimeout(700);
      const r = await page.evaluate(A11Y).catch(() => null);
      if (!r) { transport.push(`a11y ${route}: probe threw`); continue; }
      checks += 1;

      if (r.unlabelled.length) finding("P2", "a11y", `${route} has ${r.unlabelled.length} unlabelled form control(s)`, r.unlabelled.slice(0, 3).join(", "));
      if (r.imagesNoAlt.length) finding("P3", "a11y", `${route} has ${r.imagesNoAlt.length} image(s) with no alt attribute`, r.imagesNoAlt[0]);
      if (r.h1Count === 0) finding("P3", "a11y", `${route} has no h1`, "");
      if (r.h1Count > 1) finding("P3", "a11y", `${route} has ${r.h1Count} h1 elements`, "");
      if (r.skips.length) finding("P3", "a11y", `${route} skips a heading level`, r.skips.join(", "));
      if (!r.landmarks.main) finding("P3", "a11y", `${route} has no <main> landmark`, "");
      if (!r.lang) finding("P3", "a11y", `${route} has no lang attribute`, "");
      if (r.contrast.length) finding("P2", "a11y", `${route} has text below WCAG AA contrast`, r.contrast.slice(0, 2).join(" | "));
      if (r.notAssessable.length) {
        transport.push(`a11y ${route}: ${r.notAssessable.length} gradient-clipped element(s) not contrast-assessable from the DOM — ${r.notAssessable[0]}`);
      }
    }
  }
  await ctx.close();
}

// --- 4. THE KEYBOARD PATH ---------------------------------------------------
// Can the purchase path be walked without a mouse? Measured by tabbing and
// watching where focus goes, rather than by clicking and asserting afterwards.
console.log("\n### keyboard path (chromium + webkit)");
for (const engine of ["chromium", "webkit"]) {
  const b = engine === "chromium" ? browser : await pw.webkit.launch(LAUNCH.webkit);
  const ctx = await b.newContext({
    viewport: engine === "webkit" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();
  const nav = await goto(page, `${BASE}/products`);
  if (!nav.ok) { transport.push(`keyboard/${engine}: ${nav.error}`); await ctx.close(); continue; }
  await page.waitForSelector(".vl-portal-row", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);

  // Tab through the portal and record what focus lands on.
  const reached = [];
  let lost = 0;
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    const at = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("name") || "").trim().slice(0, 30),
        outline: cs.outlineStyle !== "none" && cs.outlineWidth !== "0px",
        shadow: cs.boxShadow !== "none",
      };
    }).catch(() => null);
    if (!at) { lost += 1; continue; }
    reached.push(at);
  }
  checks += 1;

  const focusable = reached.length;
  const withIndicator = reached.filter((r) => r.outline || r.shadow).length;
  console.log(`  ${engine}: ${focusable} focus stops in 40 tabs, ${withIndicator} with a visible indicator, focus lost to <body> ${lost} times`);

  if (focusable === 0) {
    finding("P0", `keyboard/${engine}`, "nothing on the access portal is reachable by keyboard", "a keyboard-only visitor cannot enter the site");
  } else if (withIndicator / focusable < 0.5) {
    finding("P2", `keyboard/${engine}`, "most focused controls show no visible focus indicator",
      `${withIndicator}/${focusable} — a keyboard user cannot see where they are`);
  }
  if (lost > focusable) {
    finding("P3", `keyboard/${engine}`, "focus falls back to <body> more often than it lands on a control", `${lost} losses`);
  }

  // Escape must close the cookie banner / any dialog rather than trapping.
  const dialogBefore = await page.evaluate(() => document.querySelectorAll("[role=dialog],[aria-modal=true]").length);
  if (dialogBefore > 0) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => document.querySelectorAll("[role=dialog][aria-modal=true]").length);
    if (after >= dialogBefore) {
      finding("P3", `keyboard/${engine}`, "Escape does not close the dialog on the portal", `${dialogBefore} before, ${after} after`);
    }
  }

  await ctx.close();
  if (engine === "webkit") await b.close();
}

await browser.close();

// ---------------------------------------------------------------------------
const by = (s) => findings.filter((f) => f.severity === s).length;
console.log(`\n${"=".repeat(72)}`);
console.log(`${checks} measurements in ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`P0 ${by("P0")} · P1 ${by("P1")} · P2 ${by("P2")} · P3 ${by("P3")}`);
if (transport.length) {
  console.log(`\nTRANSPORT — NOT defects, but these went UNMEASURED (${transport.length}):`);
  for (const t of transport.slice(0, 20)) console.log(`  ${t}`);
}
process.exit(by("P0") + by("P1") + by("P2") > 0 ? 1 : 0);
