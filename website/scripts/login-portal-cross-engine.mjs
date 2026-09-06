#!/usr/bin/env node
/**
 * Cross-engine layout check for the LOGIN PORTAL (/account/login).
 *
 * WHY A SECOND SCRIPT. cross-engine-check.mjs walks the storefront behind the
 * gate and clears it on the way in. This one measures the gate itself, which is
 * now the first screen of almost every visit and the one screen a failure is
 * most expensive on: a visitor who cannot read or reach the sign-in controls
 * does not become a customer, they leave.
 *
 * Chromium cannot speak for the browsers that matter here. Every iOS in-app
 * browser — TikTok, Instagram, Facebook, Snapchat — is WKWebView, i.e. WebKit,
 * and those are where paid traffic lands. A spoofed user-agent changes the
 * string, not the engine, so this drives the real ones.
 *
 * READ-ONLY. It ticks checkboxes to observe the enabled state of the buttons
 * and reads geometry. It never presses a provider button, never submits a form,
 * never creates an account. Safe to point at a preview; never needed against
 * production.
 *
 *   ENGINE=webkit  node scripts/login-portal-cross-engine.mjs
 *   ENGINE=firefox node scripts/login-portal-cross-engine.mjs
 *   ENGINE=chromium node scripts/login-portal-cross-engine.mjs
 *
 * PREREQUISITE: playwright-core and the engines are not dependencies of this
 * app. See docs/BROWSER-TESTING-RUNBOOK.md, "Chromium is not Safari".
 * Exits non-zero if any real layout defect is found.
 */
import * as pw from "playwright-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const ENGINE = process.env.ENGINE || "webkit";
const launcher = pw[ENGINE];
if (!launcher) {
  console.error(`unknown ENGINE "${ENGINE}" — use webkit, firefox or chromium`);
  process.exit(2);
}

// The egress proxy resets TLS 1.3; each engine caps differently and WebKit
// copes unaided. Without these every page looks dead, which reads as an outage
// and is not one. Inert on loopback, kept so the same script works against a
// preview URL.
const LAUNCH = {
  chromium: {
    headless: true,
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--ssl-version-max=tls1.2"],
  },
  firefox: { headless: true, firefoxUserPrefs: { "security.tls.version.max": 3 } },
  webkit: { headless: true },
}[ENGINE];

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const AND = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0";

/**
 * Heights are the USABLE viewport, not the device height — browser chrome and
 * the in-app header are already subtracted. That is the number the button has
 * to fit inside at first paint, which is the only paint that decides a bounce.
 */
const CASES = [
  ["TikTok WebView", `${IOS} Mobile/15E148 musical_ly_2023005030 BytedanceWebview/d8a21c6`, { width: 393, height: 664 }],
  ["Instagram WebView", `${IOS} Mobile/21F90 Instagram 335.0.0.34.95 (iPhone16,1; iOS 17_5_1)`, { width: 393, height: 692 }],
  ["Safari iOS 15/SE", `${IOS} Version/17.5 Mobile/15E148 Safari/604.1`, { width: 375, height: 548 }],
  ["Safari iOS 14/15", `${IOS} Version/17.5 Mobile/15E148 Safari/604.1`, { width: 390, height: 659 }],
  ["Android Chrome", `${AND} Mobile Safari/537.36`, { width: 412, height: 730 }],
  ["small Android", `${AND} Mobile Safari/537.36`, { width: 360, height: 640 }],
  ["narrow floor", null, { width: 320, height: 568 }],
  ["tablet", null, { width: 768, height: 1024 }],
  ["laptop", null, { width: 1280, height: 800 }],
  ["desktop", null, { width: 1440, height: 900 }],
];

const findings = [];

/**
 * Layout facts only. Everything here is engine-independent by construction, so
 * anything that reports on one engine and not another is a real difference
 * rather than a threshold artefact.
 */
const PROBE = () => {
  const de = document.documentElement;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

  const card = document.querySelector(".vl-auth-card");
  const google = [...document.querySelectorAll("button")].find((b) => /Continue with Google/.test(b.textContent || ""));
  const create = [...document.querySelectorAll("button")].find((b) => txt(b) === "Create an account");
  const signIn = [...document.querySelectorAll("button")].find((b) => txt(b) === "Sign in with email");
  const badge = document.querySelector(".vl-fastest-badge");
  const note = document.getElementById("vl-fastest-note");
  const rows = [...document.querySelectorAll(".vl-portal-row")];

  // Anything painting past the right edge. The card's own children are checked
  // separately because a card that fits while its contents do not is the
  // failure a page-level check misses.
  const past = (root) =>
    [...root.querySelectorAll("*")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") return false;
        return r.right > vw + 1;
      })
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className || "").slice(0, 30)}`);

  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) };
  };

  // A label that has been ellipsised is a truncation the eye reads as a broken
  // button, and it is exactly what a wider font metric in another engine causes.
  const truncated = (el) => {
    const s = el?.querySelector("span");
    return s ? s.scrollWidth > s.clientWidth + 1 : null;
  };

  return {
    overflow: de.scrollWidth > vw + 1,
    overBy: de.scrollWidth - vw,
    pageOffenders: past(document.body),
    cardOffenders: card ? past(card) : [],
    textLen: (document.body.innerText || "").trim().length,
    heading: txt(document.querySelector("h1")),
    google: box(google),
    googleFullyVisible: google ? google.getBoundingClientRect().bottom <= vh : null,
    googleTruncated: truncated(google),
    create: box(create),
    signIn: box(signIn),
    badge: box(badge),
    badgeText: txt(badge),
    note: box(note),
    rowCount: rows.length,
    // The third row must stay visibly different from the two that gate entry.
    rowStyles: rows.map((r) => ({
      optional: r.classList.contains("vl-portal-row-optional"),
      border: getComputedStyle(r).borderTopStyle,
      h: Math.round(r.getBoundingClientRect().height),
    })),
    // 44px is the platform minimum for a reliable thumb target.
    smallTargets: [...document.querySelectorAll(".vl-auth-card button, .vl-auth-card label, .vl-auth-card a")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.height < 44;
      })
      .map((el) => `${el.tagName.toLowerCase()}:${txt(el).slice(0, 22)}(${Math.round(el.getBoundingClientRect().height)}px)`)
      .slice(0, 4),
  };
};

const browser = await launcher.launch(LAUNCH);
console.log(`\n================ ${ENGINE.toUpperCase()} — ${BASE}/account/login ================`);

for (const [label, ua, viewport] of CASES) {
  const ctx = await browser.newContext({
    // The harness is sometimes fronted by tls-proxy.mjs with a self-signed
    // pair — the configuration WebKit needs before it will store the Secure
    // session cookie at all. Without this every navigation to the https port
    // fails and the run reports ten "navigation failed" findings against a
    // portal that is fine. Inert on http, and loopback only either way.
    ignoreHTTPSErrors: true,
    ...(ua ? { userAgent: ua } : {}),
    viewport,
    // Firefox does not implement Playwright's mobile emulation.
    ...(viewport.width < 500 && ENGINE !== "firefox" ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await ctx.newPage();
  const tag = `${ENGINE}/${label}`;
  try {
    await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded", timeout: 70000 });
    await page.waitForTimeout(2200);
    const m = await page.evaluate(PROBE);

    if (m.textLen < 80) {
      findings.push(`${tag}: page rendered empty`);
      console.log(`  ${label.padEnd(18)} EMPTY`);
      await ctx.close();
      continue;
    }
    if (m.heading !== "Access Vanta Labs") findings.push(`${tag}: heading is ${JSON.stringify(m.heading)}`);
    if (m.overflow) findings.push(`${tag}: horizontal overflow +${m.overBy}px — ${m.pageOffenders.join(", ")}`);
    if (m.cardOffenders.length) findings.push(`${tag}: content escapes the card — ${m.cardOffenders.join(", ")}`);
    if (!m.google) findings.push(`${tag}: no Google button rendered`);
    if (m.googleTruncated) findings.push(`${tag}: the Google label is ellipsised`);
    if (m.rowCount !== 4) findings.push(`${tag}: expected 4 checkbox rows, saw ${m.rowCount}`);
    if (!m.badge) findings.push(`${tag}: the Fastest option marker did not render`);
    if (m.badge && m.badge.h > 30) findings.push(`${tag}: the marker wrapped to ${m.badge.h}px`);
    if (m.smallTargets.length) findings.push(`${tag}: tap targets under 44px — ${m.smallTargets.join(", ")}`);

    // The third row is the marketing opt-in. It sits with the two that gate
    // entry and must never be mistakable for one of them.
    const third = m.rowStyles[2];
    if (third && (!third.optional || third.border !== "dashed")) {
      findings.push(`${tag}: the marketing row is not visibly distinct (optional=${third?.optional} border=${third?.border})`);
    }
    const gated = m.rowStyles.slice(0, 2);
    if (gated.some((r) => r.optional || r.border !== "solid")) {
      findings.push(`${tag}: an entry condition is styled as optional`);
    }

    const fold = m.googleFullyVisible ? "yes" : "NO";
    console.log(
      `  ${label.padEnd(18)} ${String(viewport.width).padStart(4)}x${String(viewport.height).padEnd(4)} ` +
        `google=${String(m.google?.top ?? "-").padStart(4)}..${String(m.google?.bottom ?? "-").padEnd(4)} ` +
        `aboveFold=${fold.padEnd(3)} overflow=${String(m.overflow).padEnd(5)} ` +
        `rows=${m.rowCount} badge=${m.badge?.h ?? "-"}px`,
    );
  } catch (e) {
    console.log(`  ${label.padEnd(18)} navigation failed: ${String(e).slice(0, 100)}`);
    findings.push(`${tag}: navigation failed (check whether it reproduces across engines — likely transport)`);
  }
  await ctx.close();
}

await browser.close();

console.log(`\n---- ${ENGINE}: ${findings.length} finding(s) ----`);
for (const f of findings) console.log(`  ! ${f}`);
process.exit(findings.length ? 1 : 0);
