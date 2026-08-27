import { expect, test } from "@playwright/test";

/**
 * The consent gate, observed in a real browser rather than inferred from
 * source. The assertion that matters is the negative one: no request to
 * googletagmanager.com before someone agrees to it.
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
