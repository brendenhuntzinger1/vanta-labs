import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// ADM-02 — AN UNTOUCHED FORM MUST NOT FLIP A SETTING.
//
// The Control Center's `profitCountTax` state initialised to `true` while the
// server default (DEFAULT_PROFIT_CONFIG.countSalesTaxAsProfit) is `false` — the
// owner's decision that collected sales tax is not the store's money. With the
// key never stored, the changed-keys diff saw "" -> "true" and the first save of
// ANY field wrote count_sales_tax_as_profit=true, overstating every profit
// figure by the tax on every order without the operator touching the control.
//
// The component is a large client form with no isolated seam for its initial
// state, so this pins the source: the client default and the server default
// must be the same literal.
// ---------------------------------------------------------------------------

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Control Center: count_sales_tax_as_profit default", () => {
  it("the server default is false", () => {
    const control = source("src/lib/admin-control.ts");
    expect(control).toMatch(/countSalesTaxAsProfit:\s*false,/);
  });

  it("the client initialises the select to the SAME default, so an untouched form sends nothing new", () => {
    const client = source("src/components/admin-control-center-client.tsx");
    const declaration = client.match(/const \[profitCountTax, setProfitCountTax\] = useState\(([^)]*)\);/);
    expect(declaration, "profitCountTax useState declaration not found").not.toBeNull();
    expect(declaration?.[1].trim()).toBe("false");
  });

  it("the loader still honours a stored true", () => {
    const client = source("src/components/admin-control-center-client.tsx");
    expect(client).toContain(
      'setProfitCountTax(profit.count_sales_tax_as_profit === true || profit.count_sales_tax_as_profit === "true");',
    );
  });
});
