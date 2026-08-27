import { describe, expect, it } from "vitest";
import { wasAlreadySent, type LedgerRow } from "./purchase-ledger";

describe("wasAlreadySent", () => {
  it("returns false for an empty ledger", () => {
    expect(wasAlreadySent([], "tiktok")).toBe(false);
    expect(wasAlreadySent([], "reddit")).toBe(false);
    expect(wasAlreadySent([], "google")).toBe(false);
  });

  it("returns true when a row exists for that platform", () => {
    const rows: LedgerRow[] = [{ order_id: "VL-1001", platform: "tiktok", delivered: true }];
    expect(wasAlreadySent(rows, "tiktok")).toBe(true);
  });

  it("treats a row as sent even when delivery failed", () => {
    // A hard rejection must not be retried on every page refresh.
    const rows: LedgerRow[] = [{ order_id: "VL-1001", platform: "tiktok", delivered: false }];
    expect(wasAlreadySent(rows, "tiktok")).toBe(true);
  });

  it("NEGATIVE CONTROL: one platform's row does not suppress another platform", () => {
    expect(wasAlreadySent([{ order_id: "x", platform: "tiktok", delivered: true }], "google")).toBe(false);
    expect(wasAlreadySent([{ order_id: "x", platform: "tiktok", delivered: true }], "reddit")).toBe(false);
    expect(wasAlreadySent([{ order_id: "x", platform: "reddit", delivered: true }], "tiktok")).toBe(false);
  });

  it("selects the right platform out of a mixed ledger", () => {
    const rows: LedgerRow[] = [
      { order_id: "x", platform: "tiktok", delivered: true },
      { order_id: "x", platform: "reddit", delivered: false },
    ];
    expect(wasAlreadySent(rows, "tiktok")).toBe(true);
    expect(wasAlreadySent(rows, "reddit")).toBe(true);
    expect(wasAlreadySent(rows, "google")).toBe(false);
  });

  it("tolerates a legacy row whose platform is null or empty by treating it as tiktok", () => {
    // The column carries `default 'tiktok'`, but a row written before the
    // column existed reads back as null. Charging it to TikTok matches the
    // default rather than silently suppressing every channel.
    expect(wasAlreadySent([{ order_id: "x", platform: null, delivered: true }], "tiktok")).toBe(true);
    expect(wasAlreadySent([{ order_id: "x", platform: null, delivered: true }], "reddit")).toBe(false);
    expect(wasAlreadySent([{ order_id: "x", platform: "", delivered: true }], "tiktok")).toBe(true);
  });

  it("matches platform case-insensitively and ignores surrounding whitespace", () => {
    expect(wasAlreadySent([{ order_id: "x", platform: " TikTok ", delivered: true }], "tiktok")).toBe(true);
  });

  it("ignores rows for an unrelated platform entirely", () => {
    expect(wasAlreadySent([{ order_id: "x", platform: "snap", delivered: true }], "google")).toBe(false);
  });

  it("tolerates a null or undefined row list", () => {
    expect(wasAlreadySent(null, "tiktok")).toBe(false);
    expect(wasAlreadySent(undefined, "tiktok")).toBe(false);
  });
});
