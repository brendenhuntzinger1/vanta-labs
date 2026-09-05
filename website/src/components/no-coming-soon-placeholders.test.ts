import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// A customer-facing page must not advertise features that do not exist. The
// account settings page carried a "Two-factor authentication" panel and an
// "SMS text updates" row, each tagged "Coming soon", for features with no
// implementation anywhere in the codebase.
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx$/.test(entry) && !/\.test\./.test(entry)) out.push(path);
  }
  return out;
}

describe("customer-facing components", () => {
  it("carry no 'Coming soon' placeholders", () => {
    const files = [...walk(join(process.cwd(), "src/components")), ...walk(join(process.cwd(), "src/app"))]
      .filter((p) => !p.includes("/admin"));
    // A badge that says "Coming soon" beside a feature — not prose such as an
    // empty state saying plans are coming soon.
    const offenders = files.filter((p) => />\s*Coming soon\s*</.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
});
