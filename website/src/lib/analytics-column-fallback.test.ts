import { describe, expect, it, vi } from "vitest";
import { createOptionalColumnInserter, isUnknownColumnError } from "./analytics-column-fallback";

const REQUIRED = { event_type: "page_view", page_path: "/" };
const OPTIONAL = { utm_content: "creative-1", ttclid: "abc" };

describe("recognising a missing column", () => {
  it("matches the PostgREST and Postgres codes", () => {
    expect(isUnknownColumnError({ code: "PGRST204", message: "Could not find the 'ttclid' column" })).toBe(true);
    expect(isUnknownColumnError({ code: "42703", message: "column \"ttclid\" does not exist" })).toBe(true);
  });

  it("matches on message alone when no code is given", () => {
    expect(isUnknownColumnError({ message: "Could not find the 'utm_term' column of 'x' in the schema cache" })).toBe(true);
  });

  it("does not treat an unrelated failure as a schema problem", () => {
    // Retrying a permissions or connection failure without the optional columns
    // would just fail again, and worse, would hide the real cause.
    expect(isUnknownColumnError({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isUnknownColumnError({ message: "fetch failed" })).toBe(false);
    expect(isUnknownColumnError(null)).toBe(false);
  });
});

describe("degrading instead of losing the write", () => {
  it("writes everything when the columns exist", async () => {
    const insert = vi.fn(async (_row: Record<string, unknown>) => ({ error: null }));
    const write = createOptionalColumnInserter(insert);
    expect(await write(REQUIRED, OPTIONAL)).toBeNull();
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toMatchObject({ ...REQUIRED, ...OPTIONAL });
  });

  it("still records the event when the new columns are missing", async () => {
    // The regression this exists for: shipping the columns before the migration
    // made PostgREST reject the whole row, silently killing analytics that had
    // worked for months.
    const insert = vi.fn(async (row: Record<string, unknown>) =>
      "ttclid" in row ? { error: { code: "PGRST204", message: "Could not find the 'ttclid' column" } } : { error: null },
    );
    const write = createOptionalColumnInserter(insert);
    expect(await write(REQUIRED, OPTIONAL)).toBeNull();
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert.mock.calls[1][0]).toEqual(REQUIRED);
  });

  it("stops paying for the retry once it knows the columns are absent", async () => {
    const insert = vi.fn(async (row: Record<string, unknown>) =>
      "ttclid" in row ? { error: { code: "PGRST204", message: "Could not find the 'ttclid' column" } } : { error: null },
    );
    const write = createOptionalColumnInserter(insert);
    await write(REQUIRED, OPTIONAL);
    insert.mockClear();
    await write(REQUIRED, OPTIONAL);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toEqual(REQUIRED);
  });

  it("surfaces a genuine failure instead of retrying it", async () => {
    const insert = vi.fn(async (_row: Record<string, unknown>) => ({ error: { code: "42501", message: "permission denied" } }));
    const write = createOptionalColumnInserter(insert);
    expect(await write(REQUIRED, OPTIONAL)).toMatchObject({ code: "42501" });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("reports the fallback's own failure rather than swallowing it", async () => {
    const insert = vi.fn(async (row: Record<string, unknown>) =>
      "ttclid" in row
        ? { error: { code: "PGRST204", message: "Could not find the 'ttclid' column" } }
        : { error: { code: "08006", message: "connection failure" } },
    );
    expect(await createOptionalColumnInserter(insert)(REQUIRED, OPTIONAL)).toMatchObject({ code: "08006" });
  });
});
