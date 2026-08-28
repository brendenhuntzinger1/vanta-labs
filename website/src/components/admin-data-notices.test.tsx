import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminReadFailureNotice, AdminTruncationNotice } from "@/components/admin-data-notices";

describe("AdminReadFailureNotice", () => {
  it("names every read that did not answer", () => {
    const html = renderToStaticMarkup(
      <AdminReadFailureNotice failures={["Revenue metrics", "Sales tax report"]} />,
    );
    expect(html).toContain("Revenue metrics, Sales tax report");
    expect(html).toContain("Nothing below is evidence that the store is quiet");
    // Announced, not merely drawn: this is the sentence that stops an owner
    // reading a broken screen as an all-clear.
    expect(html).toContain('role="alert"');
  });

  it("stays out of the way when everything loaded", () => {
    expect(renderToStaticMarkup(<AdminReadFailureNotice failures={[]} />)).toBe("");
  });
});

describe("AdminTruncationNotice", () => {
  it("says the figures are floors and names the reports", () => {
    const html = renderToStaticMarkup(
      <AdminTruncationNotice sources={["the sales-tax filing report"]} detail="Narrow it by year." />,
    );
    expect(html).toContain("floors, not totals");
    expect(html).toContain("the sales-tax filing report");
    expect(html).toContain("Narrow it by year.");
  });

  it("renders nothing when no read hit its ceiling", () => {
    expect(renderToStaticMarkup(<AdminTruncationNotice sources={[]} />)).toBe("");
  });
});
