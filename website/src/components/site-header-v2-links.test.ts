import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const header = readFileSync(join(process.cwd(), "src/components/site-header-v2.tsx"), "utf8");

describe("every primary navigation link shares one treatment", () => {
  it("no longer singles Membership out as a filled white pill", () => {
    expect(header).not.toContain('link.href === "/membership"');
    expect(header).not.toMatch(/bg-white text-black/);
  });

  it("lists COA Library at the same weight and colour as its neighbours", () => {
    expect(header).toContain('{ href: "/coa-library", label: "COA Library" }');
    expect(header).not.toContain("discreet");
  });

  it("styles the desktop and mobile rows with one class string per link", () => {
    // A ternary keyed on href is how the two exceptions crept in; a flat class
    // constant keeps the next one from doing the same.
    expect(header).toContain("className={DESKTOP_LINK_CLASS}");
    expect(header).toContain("className={MOBILE_LINK_CLASS}");
    expect(header).not.toContain("link.href ===");
  });
});
