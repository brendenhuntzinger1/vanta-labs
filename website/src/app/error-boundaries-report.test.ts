import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// A crash caught by an explicit App Router error boundary reaches only
// console.error in Next 16; the browser Sentry SDK's global handlers never see
// it. Every boundary that shows a customer or an admin an error page must
// therefore report it itself, the way global-error.tsx already did.
describe("every error boundary reports to Sentry", () => {
  it.each(["src/app/error.tsx", "src/app/admin/error.tsx", "src/app/global-error.tsx"])("%s captures the error", (path) => {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    expect(source).toContain('import("@sentry/nextjs")');
    expect(source).toContain("captureException(error");
  });
});
