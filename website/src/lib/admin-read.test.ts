import { describe, expect, it } from "vitest";

import { UNKNOWN_FIGURE, failedReads, figure, settleRead } from "@/lib/admin-read";

describe("settleRead", () => {
  it("keeps the value when the read answers", async () => {
    const read = await settleRead("Revenue", async () => 42);
    expect(read).toEqual({ ok: true, label: "Revenue", value: 42 });
  });

  it("keeps the failure instead of substituting a value for it", async () => {
    const read = await settleRead("Revenue", async () => {
      throw new Error("connection refused");
    });
    expect(read.ok).toBe(false);
    expect(read.value).toBeNull();
    expect(read).toMatchObject({ label: "Revenue", error: "connection refused" });
  });

  it("survives a thrown non-Error", async () => {
    const read = await settleRead("Revenue", async () => {
      throw "boom";
    });
    expect(read).toMatchObject({ ok: false, error: "boom" });
  });
});

describe("figure", () => {
  it("renders a real zero as a zero", async () => {
    const read = await settleRead("Revenue", async () => 0);
    expect(figure(read, (v) => `$${v.toFixed(2)}`)).toBe("$0.00");
  });

  it("renders an unknown as an em dash, never as a zero", async () => {
    // The whole point. A store that took no money today and a store whose
    // database is unreachable must not print the same character.
    const read = await settleRead("Revenue", async () => {
      throw new Error("down");
    });
    expect(figure(read, (v) => `$${Number(v).toFixed(2)}`)).toBe(UNKNOWN_FIGURE);
    expect(figure(read, () => "unused")).not.toBe("$0.00");
  });
});

describe("failedReads", () => {
  it("names every read that did not answer, and only those", async () => {
    const reads = await Promise.all([
      settleRead("Revenue", async () => 1),
      settleRead("Profit", async () => { throw new Error("x"); }),
      settleRead("Sales tax report", async () => { throw new Error("y"); }),
    ]);
    expect(failedReads(reads)).toEqual(["Profit", "Sales tax report"]);
  });

  it("is empty when everything loaded", async () => {
    const reads = [await settleRead("Revenue", async () => 1)];
    expect(failedReads(reads)).toEqual([]);
  });
});
