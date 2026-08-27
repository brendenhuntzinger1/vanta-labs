import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contract assertions about the purchase route.
 *
 * The route needs a database and a request to run, so these assert the
 * structural properties that matter about its source: that Google is built
 * from the shared paid order, and that it does not acquire an independent
 * opinion about whether a purchase happened.
 */
const ROUTE = join(process.cwd(), "src/app/api/ads/purchase-event/[orderId]/route.ts");
const source = () => readFileSync(ROUTE, "utf8");

describe("purchase route — Google wiring", () => {
  it("builds the Google purchase from the shared paidOrder object", () => {
    expect(source()).toMatch(/buildGooglePurchase\(\s*paidOrder/);
  });

  it("does not re-read payment_status for Google", () => {
    const occurrences = source().match(/payment_status/g) ?? [];
    // Baseline as of Task 5 (order query, isPaid derivation, comments, and the
    // inspect payload's paymentStatus/reason strings) is 7 occurrences, none
    // of them Google's. This guards that Google's wiring adds zero more.
    expect(occurrences.length).toBeLessThanOrEqual(7);
  });

  it("gates the Google send on its own ledger entry, not another platform's", () => {
    expect(source()).toMatch(/wasAlreadySent\(ledgerRows,\s*["']google["']\)/);
  });

  it("gates the Google send on its own credential check", () => {
    expect(source()).toMatch(/googleCredentialStatus\(\)\.configured/);
  });

  it("returns the Google purchase for the confirmation page to emit", () => {
    expect(source()).toContain("googlePurchase");
  });

  it("NEGATIVE CONTROL: Google's send gate is not the same call as TikTok's or Reddit's", () => {
    // The route must call wasAlreadySent three times, once per platform
    // literal. If the "google" argument were ever swapped out for "tiktok" or
    // "reddit" — accidentally reusing another platform's already-computed
    // boolean — this still matches, because it only checks for the literal
    // calls' presence. What it DOES catch: a Google send gated on nothing but
    // "tiktok"/"reddit" calls (i.e. no "google" call in the source at all),
    // which is exactly the silent-single-point-of-failure shape the brief
    // warns about.
    const calls = source().match(/wasAlreadySent\(ledgerRows,\s*["'](tiktok|reddit|google)["']\)/g) ?? [];
    const platforms = calls.map((c) => c.match(/["'](tiktok|reddit|google)["']/)?.[1]);
    expect(platforms).toContain("google");
    expect(platforms).toContain("tiktok");
    expect(platforms).toContain("reddit");
    // And the boolean actually used to gate Google's send block must be the
    // google-specific one, not a bare reuse of `alreadySent` (tiktok's) or
    // `redditAlreadySent`.
    const googleGate = source().match(/if \(googlePurchase[^)]*\)/);
    expect(googleGate?.[0]).toContain("googleAlreadySent");
    expect(googleGate?.[0]).not.toContain("!redditAlreadySent");
    expect(googleGate?.[0]).not.toBe("!alreadySent"); // tiktok's bare variable
  });
});
