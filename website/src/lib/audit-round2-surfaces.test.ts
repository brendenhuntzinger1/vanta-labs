import { readFileSync } from "node:fs";
import { join } from "node:path";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THREE CUSTOMER- AND OPERATOR-FACING DEFECTS FROM THE LAUNCH AUDIT.
//
// PAY-04  The confirmation page thanked a declined or cancelled card order and
//         told the shopper there was "no need to pay again".
// ADM-10  A CSV product import turned every blank cell into 0 / false, so a
//         price-only sheet unpublished and zeroed the products it listed.
// AA-6    A partner application silently swapped a taken referral code for a
//         generated one and told the applicant nothing.
// ---------------------------------------------------------------------------

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => React.createElement("a", { href }, children),
}));

import { OrderConfirmationStatus } from "@/components/order-confirmation-status";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("PAY-04: a declined order is not thanked", () => {
  const render = (props: Partial<React.ComponentProps<typeof OrderConfirmationStatus>>) =>
    renderToStaticMarkup(
      React.createElement(OrderConfirmationStatus, {
        orderId: "order-1",
        orderNumber: "VL-TEST1234",
        maskedEmail: "j***@example.com",
        initialPaid: false,
        initialFailed: false,
        isManual: false,
        fulfillmentStatus: null,
        ...props,
      }),
    );

  it("renders the failed state with no thanks and no 'no need to pay again'", () => {
    const html = render({ initialFailed: true });
    expect(html).toContain("Payment not completed");
    expect(html).toContain("has not been charged");
    expect(html).toContain('href="/checkout"');
    expect(html).not.toMatch(/thank you/i);
    expect(html).not.toMatch(/no need to pay/i);
  });

  it("still thanks a paid order", () => {
    const html = render({ initialPaid: true });
    expect(html).not.toContain("Payment not completed");
  });

  it("the page passes the failed state down and keeps the cart for a failed order", () => {
    const page = read("src/app/order-confirmation/[orderId]/page.tsx");
    expect(page).toContain("initialFailed={isFailed}");
    expect(page).toContain("{!isFailed ? <ClearCartOnMount /> : null}");
    expect(page).toContain('paymentStatus === "payment_failed" || paymentStatus === "canceled"');
  });
});

describe("ADM-10: a blank CSV cell leaves the product alone", () => {
  const csv = read("src/lib/admin-products-csv.ts");

  it("updates only the columns present with a non-blank cell", () => {
    expect(csv).toContain("function buildUpdatePatch(");
    expect(csv).toContain('const present = (key: string) => header.includes(key) && (record[key] ?? "").trim() !== "";');
    expect(csv).toContain("const money = (key: string) => present(key) && /\\d/.test(record[key]);");
    expect(csv).toContain("await updateAdminProduct(existingId, buildUpdatePatch(record, header, slug, name));");
  });

  it("no longer builds a full zero-defaulted input for an existing product", () => {
    const updateBranch = csv.slice(csv.indexOf("await updateAdminProduct("), csv.indexOf("await updateAdminProduct(") + 200);
    expect(updateBranch).not.toContain('parseDollarsToCents(record.price || "0")');
    expect(updateBranch).not.toContain("Number(record.inventoryQuantity) || 0");
  });
});

describe("AA-6: a taken referral code is refused at application time", () => {
  it("checks availability with the shared checker and answers 400 for a taken code", () => {
    const route = read("src/app/api/partner/apply/route.ts");
    expect(route).toContain("checkReferralCodeAvailability(preferredReferralCode)");
    expect(route).toContain('availability.reason === "taken"');
    expect(route).toContain("That referral code is already taken.");
  });
});

describe("DB-01: a product delete removes children before the parent", () => {
  it("issues the three deletes sequentially", () => {
    const src = read("src/lib/admin-products.ts");
    const images = src.indexOf('from("product_images").delete().eq("product_id", productId)');
    const doses = src.indexOf('from("product_doses").delete().eq("product_id", productId)');
    const parent = src.indexOf('from("products").delete().eq("id", productId)');
    expect(images).toBeGreaterThan(0);
    expect(doses).toBeGreaterThan(images);
    expect(parent).toBeGreaterThan(doses);
    expect(src.slice(images, parent)).not.toContain("Promise.all([");
  });
});
