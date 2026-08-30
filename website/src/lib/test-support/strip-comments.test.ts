import { describe, expect, it } from "vitest";

import { assertNotGutted, stripComments } from "@/lib/test-support/strip-comments";

// The two regex approaches this replaced both deleted real code, and a deleted
// line makes a `not.toContain` guard pass for the wrong reason. These are the
// exact shapes that broke them.
describe("stripComments", () => {
  it("removes a whole-line comment but keeps the code around it", () => {
    expect(stripComments("const a = 1;\n// gone\nconst b = 2;\n"))
      .toContain("const a = 1;");
    expect(stripComments("const a = 1;\n// gone\nconst b = 2;\n"))
      .toContain("const b = 2;");
    expect(stripComments("const a = 1;\n// gone\nconst b = 2;\n"))
      .not.toContain("gone");
  });

  it("does not let a /* inside a LINE comment open a block", () => {
    // The literal that broke the blocks-first regex: it opened here and closed
    // at the next */ far below, taking everything between with it.
    const source = [
      "// every /api/account/* route refuses anonymous callers",
      "const keepMe = 1;",
      "/* a real block */",
      "const alsoKeepMe = 2;",
    ].join("\n");
    const stripped = stripComments(source);
    expect(stripped).toContain("const keepMe = 1;");
    expect(stripped).toContain("const alsoKeepMe = 2;");
    expect(stripped).not.toContain("refuses anonymous");
  });

  it("removes a JSDoc block without losing the code after it", () => {
    // The shape that broke the lines-first regex: dropping lines starting with
    // `*` also dropped the closing `*/`, so the opening /** never terminated.
    const source = ["/**", " * Docs.", " */", "export const kept = 1;"].join("\n");
    const stripped = stripComments(source);
    expect(stripped).toContain("export const kept = 1;");
    expect(stripped).not.toContain("Docs.");
  });

  it("removes a JSX comment", () => {
    const source = '<div>\n  {/* note */}\n  <span id="keep" />\n</div>';
    expect(stripComments(source)).toContain('id="keep"');
    expect(stripComments(source)).not.toContain("note");
  });

  it("keeps a URL, whose // is not a comment", () => {
    expect(stripComments('const u = "https://example.test/a";'))
      .toContain("https://example.test/a");
  });

  it("separates rather than fuses code around an inline block", () => {
    expect(stripComments("foo/* x */bar")).toBe("foo bar");
  });

  it("preserves line count so assertions and errors still line up", () => {
    const source = "a\n// b\n/* c\n d */\ne";
    expect(stripComments(source).split("\n")).toHaveLength(source.split("\n").length);
  });
});

describe("assertNotGutted", () => {
  it("passes through source that still holds its anchor", () => {
    expect(assertNotGutted("x.ts", "export const a = 1;")).toContain("export");
  });

  it("throws loudly rather than letting a guard pass against nothing", () => {
    expect(() => assertNotGutted("x.ts", "   ")).toThrow(/removed too much of x\.ts/);
  });

  it("accepts a caller-chosen anchor", () => {
    expect(() => assertNotGutted("x.tsx", "const a = 1;", "CartProvider"))
      .toThrow(/CartProvider/);
  });
});
