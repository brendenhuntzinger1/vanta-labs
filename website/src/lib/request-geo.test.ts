import { describe, expect, it } from "vitest";
import { resolveCoarseGeoFromHeaders } from "./request-geo";

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("resolveCoarseGeoFromHeaders", () => {
  it("reads country and city from Vercel's edge-resolved geo headers", () => {
    const geo = resolveCoarseGeoFromHeaders(
      headers({ "x-vercel-ip-country": "US", "x-vercel-ip-city": "Austin" }),
    );
    expect(geo).toEqual({ country: "US", city: "Austin" });
  });

  it("decodes a URL-encoded city name", () => {
    const geo = resolveCoarseGeoFromHeaders(
      headers({ "x-vercel-ip-country": "MX", "x-vercel-ip-city": "Ciudad%20de%20M%C3%A9xico" }),
    );
    expect(geo.city).toBe("Ciudad de México");
  });

  it("returns nulls when the headers are absent (local dev, non-Vercel host)", () => {
    expect(resolveCoarseGeoFromHeaders(headers({}))).toEqual({ country: null, city: null });
  });

  it("never reads or returns anything IP-shaped — country/city only", () => {
    const geo = resolveCoarseGeoFromHeaders(
      headers({ "x-forwarded-for": "203.0.113.5", "x-vercel-ip-country": "US" }),
    );
    expect(geo).toEqual({ country: "US", city: null });
    expect(Object.keys(geo)).toEqual(["country", "city"]);
  });

  it("degrades to null instead of throwing on a malformed percent-encoded city", () => {
    const geo = resolveCoarseGeoFromHeaders(headers({ "x-vercel-ip-city": "%" }));
    expect(geo.city).toBeNull();
  });
});
