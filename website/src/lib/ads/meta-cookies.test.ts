import { describe, expect, it } from "vitest";
import { readPixelCookies } from "./meta-cookies";

describe("readPixelCookies", () => {
  it("picks the two pixel cookies out of a cookie header", () => {
    expect(readPixelCookies("vl_session=abc; _fbp=fb.1.1700.123; _fbc=fb.1.1700.IwAR; other=1")).toEqual({
      fbp: "fb.1.1700.123",
      fbc: "fb.1.1700.IwAR",
    });
  });

  it("returns nulls for a visitor with neither, and for no header at all", () => {
    expect(readPixelCookies("vl_session=abc")).toEqual({ fbp: null, fbc: null });
    expect(readPixelCookies(null)).toEqual({ fbp: null, fbc: null });
  });

  it("ignores an oversized value rather than forwarding it", () => {
    expect(readPixelCookies(`_fbp=${"x".repeat(300)}`).fbp).toBeNull();
  });
});
