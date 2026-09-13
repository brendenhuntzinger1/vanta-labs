import { describe, expect, it } from "vitest";
import { formatDurationShort } from "./duration-format";

describe("formatDurationShort", () => {
  it("renders sub-minute durations in seconds", () => {
    expect(formatDurationShort(0)).toBe("0s");
    expect(formatDurationShort(45_000)).toBe("45s");
  });

  it("renders minutes, dropping seconds once a minute has passed", () => {
    expect(formatDurationShort(90_000)).toBe("1m");
    expect(formatDurationShort(65 * 60_000)).toBe("1h 5m");
  });

  it("renders hours once 60 minutes have passed", () => {
    expect(formatDurationShort(3 * 60 * 60_000 + 4 * 60_000)).toBe("3h 4m");
  });

  it("treats a negative duration (clock skew) as 0s rather than a negative label", () => {
    expect(formatDurationShort(-500)).toBe("0s");
  });
});
