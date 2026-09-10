import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),

// ---------------------------------------------------------------------------
// A DATE MAY NOT BE FORMATTED IN "WHATEVER ZONE THIS HAPPENS TO RUN IN".
//
// `toLocaleDateString` and `toLocaleTimeString` exist only on Date, and
// `new Date(x).toLocaleString()` is unambiguously a date too, so these three
// selectors catch date formatting precisely and never touch
// `someNumber.toLocaleString()`, which is thousands separators and fine.
//
// Called with no timeZone they format in the AMBIENT zone. On Vercel that is
// UTC, so an 8:30 PM Eastern send rendered "Sep 9 12:30 AM" — the wrong hour,
// and the wrong DAY for anything after 8 PM ET. In a client component that is
// server-rendered first it is also a hydration mismatch: UTC on the server,
// local in the browser, two different strings for the same instant.
//
// Use formatDisplayDate from @/lib/format-date, which pins America/New_York.
// ---------------------------------------------------------------------------
{
  files: ["src/**/*.{ts,tsx}"],
  ignores: [
    // Each of these formats a date deliberately, and each says why in place:
    //   coa-format      a CALENDAR date, built and formatted in the same zone
    //                   so the printed day cannot drift; ET would move it.
    //   partner-portal  a month-key chart label pinned to UTC; ET would render
    //                   Sep 1 00:00Z as "Aug".
    //   gift-terms,     already pass timeZone: "America/New_York" explicitly,
    //   cart-recovery,  in a format the shared styles do not cover.
    //   admin-cart-recovery
    "src/lib/coa-format.ts",
    "src/lib/partner-portal.ts",
    "src/lib/offers/gift-terms.ts",
    "src/lib/cart-recovery.ts",
    "src/lib/admin-cart-recovery.ts",
    "src/**/*.test.{ts,tsx}",
  ],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector: 'CallExpression[callee.property.name="toLocaleDateString"]',
        message: "Formats in the ambient zone (UTC on Vercel). Use formatDisplayDate from @/lib/format-date.",
      },
      {
        selector: 'CallExpression[callee.property.name="toLocaleTimeString"]',
        message: "Formats in the ambient zone (UTC on Vercel). Use formatDisplayDate(value, \"time\") from @/lib/format-date.",
      },
      {
        selector: 'CallExpression[callee.property.name="toLocaleString"][callee.object.type="NewExpression"][callee.object.callee.name="Date"]',
        message: "Formats in the ambient zone (UTC on Vercel). Use formatDisplayDate from @/lib/format-date.",
      },
    ],
  },
},
]);

export default eslintConfig;
