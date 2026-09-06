import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // .gitignore:49-52 has claimed since it was written that "vitest.config.ts
    // excludes scratchpad separately; both are required". It did not: there was
    // no `exclude` here at all, and vitest does not read .gitignore. A stray
    // agent probe left under website/scratchpad/ therefore JOINED the suite and
    // silently inflated the gate counts the whole project reports against.
    // Keep the defaults (node_modules, dist, build output) and add the two
    // scratch directories, so the comment over there is now true.
    //
    // The throwaway-probe NAMES are here for the same reason, one layer over.
    // .gitignore now hides `__verify_*`, `__probe_*`, `__scratch_*` and
    // `zz-verify-*` under src/ — but vitest does not read .gitignore, so a
    // gitignored probe sitting beside the code it measures is INVISIBLE to git
    // and still joins the suite. That is strictly worse than the scratchpad
    // case it repeats: `git status` says clean while the gate count is wrong.
    // Two of these turned up during the 2026-09-06 audit.
    exclude: [
      ...configDefaults.exclude,
      "scratchpad/**",
      "scratch-verify/**",
      "src/**/__verify_*",
      "src/**/__probe_*",
      "src/**/__scratch_*",
      "src/**/zz-verify-*",
    ],
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
