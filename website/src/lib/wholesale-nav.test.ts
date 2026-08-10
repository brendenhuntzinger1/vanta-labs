import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const header = read("src/components/site-header-v2.tsx");
const footer = read("src/components/site-footer.tsx");
const sitemap = read("src/app/sitemap.ts");
const route = read("src/app/api/wholesale/route.ts");
const form = read("src/components/wholesale-form.tsx");
const page = read("src/app/wholesale/page.tsx");
const product = read("src/components/product-detail-client.tsx");

describe("Wholesale replaces Research in customer navigation", () => {
  it("the header links to /wholesale and no longer promotes /research", () => {
    expect(header).toContain('href: "/wholesale", label: "Wholesale"');
    expect(header).not.toContain('href: "/research"');
  });

  it("the footer links to /wholesale and no longer promotes /research", () => {
    expect(footer).toContain('{ label: "Wholesale", href: "/wholesale" }');
    expect(footer).not.toContain('href: "/research" }');
  });

  it("keeps the research routes indexed rather than deleting indexed content", () => {
    // The library is database-backed and has been public. Removing it from the
    // nav is what was asked; removing the URLs would strand inbound links and
    // discard SEO value, which is a different decision.
    expect(sitemap).toContain('"/wholesale"');
    expect(sitemap).toContain('"/research"');
  });

  it("leaves the term 'research' alone where the brand legitimately uses it", () => {
    // A blanket find-and-replace would have renamed the disclaimer, the support
    // domain and the company's own description of itself.
    expect(footer).toContain("Research Disclaimer");
    expect(footer).toContain("vantalabsresearch.com");
  });
});

describe("the wholesale form is protected like the contact form, not less", () => {
  it("keeps the same honeypot, timing gate, rate limit and length caps", () => {
    expect(route).toContain("honeypot");
    expect(route).toContain("SUBMISSION_WINDOW_MS");
    expect(route).toContain("checkRateLimit");
    expect(route).toContain("MAX_MESSAGE_LENGTH");
    expect(route).toContain("EMAIL_PATTERN.test(email)");
  });

  it("uses a honeypot name that a real organisation field cannot trip", () => {
    // The contact form traps on `company`. Reusing that here — where companies
    // legitimately type their name — would reject every genuine submission.
    expect(route).toContain("body.website");
    expect(route).not.toMatch(/const honeypot = parseString\(body\.organization\)/);
    expect(form).toContain('name="website"');
    expect(form).toContain('name="organization"');
  });

  it("hides the honeypot from assistive technology as well as from sight", () => {
    expect(form).toContain('aria-hidden="true"');
    expect(form).toContain("tabIndex={-1}");
  });

  it("sends to the configured support inbox, never a hard-coded address", () => {
    expect(route).toContain("getBusinessSettings()");
    expect(route).not.toMatch(/to:\s*"[^"]*@/);
  });

  it("reports a delivery failure instead of showing a false success", () => {
    expect(route).toContain('error: result.error ?? "Email delivery is not configured."');
  });

  it("marks the subject unmistakably so it filters away from order mail", () => {
    expect(read("src/lib/email/templates.ts")).toContain("WHOLESALE INQUIRY —");
  });

  it("escapes every submitted value before it reaches an HTML email", () => {
    const templates = read("src/lib/email/templates.ts");
    const start = templates.indexOf("export function wholesaleInquiryNotificationTemplate");
    // Bounded by the next top-level declaration rather than the first closing
    // brace, which belongs to the parameter type.
    const next = templates.indexOf("export function", start + 1);
    expect(templates.slice(start, next === -1 ? undefined : next)).toContain("escapeHtml(line)");
  });
});

describe("the page promises nothing the business has not configured", () => {
  it("publishes no minimums, payment terms or dispatch guarantees", () => {
    // None of these exist anywhere in config, so stating them would invent a
    // commitment on the company's behalf.
    expect(page).not.toMatch(/net\s*30/i);
    expect(page).not.toMatch(/\b\d+\s*(hour|hr)s?\b/i);
    expect(page).not.toMatch(/unit minimum/i);
    expect(page).not.toMatch(/same[- ]day/i);
    expect(page).not.toMatch(/\d+%\s*(off|discount|purity)/i);
  });

  it("keeps the research-use-only framing", () => {
    expect(page).toMatch(/research use only/i);
  });
});

describe("the product image frame follows the photograph", () => {
  it("uses a fixed portrait ratio instead of an oversized min-height box", () => {
    expect(product).toContain('aspect-[4/5]');
    expect(product).not.toContain("min-h-[460px]");
  });

  it("caps the frame width and centres it, so a tall vial is not lost in a wide panel", () => {
    expect(product).toContain("mx-auto w-full max-w-[340px]");
    expect(product).toContain("sm:max-w-[420px]");
  });

  it("never stretches or crops the product", () => {
    expect(product).toContain("object-contain");
    expect(product).not.toMatch(/className="object-cover"[\s\S]{0,80}priority/);
  });

  it("declares sizes matching the capped frame, so phones do not fetch a full-width asset", () => {
    expect(product).toContain('sizes="(max-width: 640px) 340px, (max-width: 1024px) 420px, 42vw"');
  });
});

describe("the redesigned page is composed, not assembled from cards", () => {
  const stack = read("src/components/wholesale-vial-stack.tsx");

  it("uses real catalogue photography rather than a decorative rectangle", () => {
    expect(page).toContain("getCatalogProducts()");
    expect(page).toContain("WholesaleVialStack");
  });

  it("refuses to stack placeholders as if they were product shots", () => {
    // Three grey placeholders would be worse than the empty panel this
    // replaced, so the composition is withheld and type stands in.
    expect(stack).toContain("PLACEHOLDER_IMAGE_PATHS.includes(src)");
    expect(page).toContain("heroImages.length > 0");
  });

  it("never repeats the same photograph within one composition", () => {
    expect(stack).toContain("seen.has(src)");
  });

  it("builds depth from scale and opacity, preserving every aspect ratio", () => {
    expect(stack).toContain("object-contain");
    expect(stack).not.toContain("object-cover");
    expect(stack).toMatch(/opacity-45|opacity-35/);
  });

  it("gives decorative layers empty alt text and names only the foreground", () => {
    expect(stack).toContain('alt=""');
    expect(stack).toContain("alt={front.alt}");
  });

  it("has one accent treatment for calls to action, not a new one per section", () => {
    expect(page).toContain("const PRIMARY_CTA");
    expect(page).toContain("const SECONDARY_CTA");
  });

  it("does not wrap every section in its own bordered panel", () => {
    // The old version put all five sections inside vl2-lab-panel, which is what
    // made it read as a template. Only the form sits on a surface now.
    expect(page.match(/vl2-lab-panel/g) ?? []).toHaveLength(0);
  });

  it("keeps the anchor target offset clear of the fixed header", () => {
    expect(page).toContain("scroll-mt-24");
  });
});

describe("the bulk photograph degrades rather than breaking", () => {
  it("checks the file is on disk instead of assuming it", () => {
    // A missing file would render as a broken image on the page a wholesale
    // buyer lands on, which is worse than any fallback.
    expect(page).toContain('existsSync(join(process.cwd(), "public", "images", "wholesale-bulk.png"))');
  });

  it("falls back through the composed stack to type, in that order", () => {
    expect(page).toContain("hasBulkImage ? (");
    expect(page).toContain(") : heroImages.length > 0 ? (");
  });

  it("drops the separate-vial composition entirely once the photograph exists", () => {
    // The composition was the thing that read as "separate vials"; when a real
    // bulk shot is present it should not appear alongside it.
    const hero = page.slice(page.indexOf("hasBulkImage ? ("), page.indexOf("BENEFITS ─"));
    expect(hero.indexOf("<Image")).toBeLessThan(hero.indexOf("WholesaleVialStack"));
  });

  it("describes the photograph for screen readers once, not twice", () => {
    // Same asset in two sections: the hero names it, the second frame is
    // decorative and stays silent.
    expect(page).toContain('alt="Vanta Labs research vials packed for bulk supply"');
    expect(page).toContain('alt=""');
  });
});
