import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Product } from "@/lib/catalog-types";

// ---------------------------------------------------------------------------
// A PRODUCT WHOSE COA IS STILL AT THE LABORATORY LOOKS LIKE EVERY OTHER CARD.
//
// The catalogue used to draw the "COA verified" pill and the "View COA" action
// only for a product with a document behind it, so the handful of compounds
// whose certificate had not come back yet stood out as the ones with something
// missing — on the one signal a research buyer scans for. The owner's rule is
// that every card looks the same: the pill is there, the action is there, and
// tapping it on an undocumented product says the certificate is on its way
// back from the laboratory and where to ask in the meantime.
//
// Rendered, not grepped: the claim is that two cards LOOK the same, which is a
// property of the markup, not of the source.
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => {
    const attrs = Object.fromEntries(Object.entries(rest).filter(([key]) => key !== "prefetch" && key !== "scroll"));
    return <a href={href} {...attrs}>{children}</a>;
  },
}));
vi.mock("next/image", () => ({
  // A plain <img> stands in for next/image; the test reads markup, not pixels.
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

const { ProductCard } = await import("./product-card");
const { COA_SUPPORT_EMAIL, COA_TESTING_PENDING_HEADING } = await import("@/lib/coa-pending");

function product(overrides: Partial<Product>): Product {
  return {
    id: "p-1",
    slug: "tesamorelin",
    name: "Tesamorelin",
    category: "Growth Hormone",
    price: "$74.99",
    stockStatus: "In Stock",
    batchNumber: "Vanta184290",
    purityResult: ">99%",
    description: "",
    image: "/images/tesamorelin.jpg",
    testingDate: "",
    labName: "",
    coaUrl: "",
    doses: [{ id: "d-1", label: "10mg", price: "$74.99", isDefault: true }],
    ...overrides,
  } as Product;
}

const render = (item: Product) =>
  renderToStaticMarkup(<ProductCard product={item} image={item.image} onAddToCart={() => {}} />);

const actionClass = (html: string, opener: RegExp) => html.match(opener)?.[1];
const DOCUMENT_ANCHOR = /<a href="\/api\/coa\/[^"]+"[^>]*class="([^"]+)"/;
const DIALOG_TRIGGER = /<button[^>]*aria-haspopup="dialog"[^>]*class="([^"]+)"/;

describe("a card for a product whose COA is still at the laboratory", () => {
  const documented = render(product({ slug: "bpc-157", name: "BPC-157", coaRecordUrl: "/api/coa/r1/file" }));
  const pending = render(product({ slug: "tesamorelin", name: "Tesamorelin" }));

  it("wears the same COA verified pill as a documented product", () => {
    expect(documented).toContain("COA verified");
    expect(pending).toContain("COA verified");
  });

  it("offers View COA in the same place, with the same look", () => {
    const documentedLook = actionClass(documented, DOCUMENT_ANCHOR);
    const pendingLook = actionClass(pending, DIALOG_TRIGGER);
    expect(documentedLook).toBeTruthy();
    expect(pendingLook).toBe(documentedLook);
    expect(pending).toContain("View COA");
  });

  it("never renders a link to nowhere", () => {
    expect(pending).not.toMatch(/href="(undefined|null)?"/);
    expect(pending).not.toContain('target="_blank"');
  });

  it("explains, in a dialog, that the certificate is returning from the laboratory and where to ask", () => {
    expect(pending).toContain("<dialog");
    expect(pending).toContain(COA_TESTING_PENDING_HEADING);
    expect(pending).toContain(`mailto:${COA_SUPPORT_EMAIL}`);
    expect(documented).not.toContain("<dialog");
  });

  it("prefers the real document the moment one is published", () => {
    const published = render(product({ slug: "tesamorelin", coaRecordUrl: "/api/coa/r9/file" }));
    expect(published).toContain('href="/api/coa/r9/file"');
    expect(published).not.toContain("<dialog");
  });

  it("leaves Recon Water alone — a solvent was never sent to a laboratory", () => {
    const solvent = render(
      product({ slug: "recon-water", name: "Recon water (0.9% Benzyl Alcohol)", category: "Solvents & Solutions" }),
    );
    expect(solvent).not.toContain("COA verified");
    expect(solvent).not.toContain("View COA");
    expect(solvent).not.toContain("<dialog");
  });
});
