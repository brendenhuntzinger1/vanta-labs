import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // The root-level `tests/` directory holds Playwright specs
    // (browser-driven, run via `npx playwright test`), not Vitest suites.
    // Without this exclude, Vitest's default `*.spec.ts` glob picks them up
    // too and fails on the `@playwright/test` import, which isn't a Vitest
    // dependency. Extending `configDefaults.exclude` (rather than replacing
    // it) keeps Vitest's own default ignores — node_modules, dist, .next,
    // etc. — intact. The pattern is anchored to the repo root (`tests/**`,
    // not `**/tests/**`) so it does not also swallow a future
    // `src/**/tests/**` Vitest suite.
    exclude: [...configDefaults.exclude, "tests/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `server-only` ships two entry points: an empty module under the
      // "react-server" export condition, and one that THROWS everywhere else.
      // Vitest resolves the throwing branch, so any suite that transitively
      // imports a server-only module dies at import with "This module cannot be
      // imported from a Client Component module" and reports ZERO tests — a
      // silent loss of coverage rather than a visible failure.
      //
      // Pointing at the same empty module Next.js uses on the server is exactly
      // what the react-server condition does. Without this, 8 suites (payment
      // service/mock, fuzz + final + ambassador invariants, and others) only
      // appeared to pass while a warm vite cache masked the resolution.
      "server-only": path.resolve(__dirname, "node_modules/server-only/empty.js"),
    },
  },
});
