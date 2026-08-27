import { expect, test } from "@playwright/test";

/**
 * The consent gate, observed in a real browser rather than inferred from
 * source. The assertion that matters is the negative one: no request to
 * googletagmanager.com before someone agrees to it.
 *
 * NECESSARY, NOT SUFFICIENT — read before trusting a green run here.
 *
 * Against local dev, all three specs below pass whether or not the consent
 * gate works at all. `browserAdsReportingAllowed()` refuses to load the tag
 * outside production regardless of consent state, so "no request before
 * consent" and "no request after declining" are both trivially true here:
 * the environment guard is doing the suppressing, not consent. The third
 * spec (390x844) is the first spec at a different viewport, not a distinct
 * scenario — it cannot fail differently from the first for the same reason.
 * A real proof that consent gating works requires a Vercel preview pointed
 * at a TEST conversion action, where the environment guard permits the tag
 * to load and consent becomes the only remaining variable — add a positive
 * "loads after accepting" assertion there, never on local dev, and never by
 * weakening the guard to make local dev accept.
 *
 * It also cannot run at all today: `@playwright/test` is not installed as a
 * project dependency and there is no `playwright.config.ts` in this repo.
 * Until both exist, this file is documentation of intent, not a gate that
 * has ever executed.
 */

const GOOGLE_HOST = /googletagmanager\.com/;

test("makes no Google request before consent", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (GOOGLE_HOST.test(request.url())) requests.push(request.url());
  });

  await page.goto("http://localhost:3000/");
  await page.waitForTimeout(2000);

  expect(requests).toEqual([]);
});

test("makes no Google request after declining", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (GOOGLE_HOST.test(request.url())) requests.push(request.url());
  });

  await page.goto("http://localhost:3000/");
  await page.getByRole("button", { name: /decline/i }).click();
  await page.waitForTimeout(2000);

  expect(requests).toEqual([]);
});

test("mobile viewport behaves identically", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (GOOGLE_HOST.test(request.url())) requests.push(request.url());
  });

  await page.goto("http://localhost:3000/");
  await page.waitForTimeout(2000);

  expect(requests).toEqual([]);
});
