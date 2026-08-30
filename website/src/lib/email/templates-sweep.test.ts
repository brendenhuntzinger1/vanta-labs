import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as templates from "./templates";

/**
 * Renders EVERY email template and asserts the things that make an email safe
 * to send: no leaked internals, no unescaped customer input, no dangling
 * labels, no absolute-URL mistakes.
 *
 * Driven off the module's own exports rather than a hand-written list, so a new
 * template is covered the moment it is added — the failure mode of a curated
 * list is that the one template nobody remembered is the one that ships broken.
 */

const XSS = '<script>alert("xss")</script>';

// Each template takes a differently-shaped `input`. Rather than 37 hand-written
// fixtures (which drift the moment a field is added), the fixture is DERIVED
// FROM each template's own declared TypeScript signature — so a new field is
// populated with the right type automatically. Guessing the type from the field
// NAME was tried first and is not reliable: `discountLabel` contains "count".
const SOURCE = readFileSync(path.join(__dirname, "templates.ts"), "utf8");

function valueForType(key: string, type: string): unknown {
  if (/Array<|\[\]/.test(type)) {
    const inner = type.match(/\{([^}]*)\}/)?.[1] ?? "";
    const row = buildFixture(inner);
    return [row, { ...row }];
  }
  if (/\bnumber\b/.test(type)) return 12;
  if (/\bboolean\b/.test(type)) return true;
  if (/(url|link|href)/i.test(key)) return "https://vantalabs.com/account/orders";
  if (/html$/i.test(key)) return "<p>Admin-authored body.</p>";
  if (/date|endsat|startsat|at$/i.test(key)) return "2026-09-03T01:00:00Z";
  // Every remaining string is treated as attacker-controlled — customer names
  // and product names really are.
  return `Value ${XSS}`;
}

function buildFixture(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // `name?: string;` / `items: Array<{ ... }>;` — split on the semicolons that
  // are not inside a nested brace/angle group.
  for (const raw of block.split(/;(?![^<{]*[}>])/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\w+)\??\s*:\s*([\s\S]+)$/);
    if (!m) continue;
    out[m[1]] = valueForType(m[1], m[2]);
  }
  return out;
}

function inputFixtureFor(templateName: string): Record<string, unknown> {
  const start = SOURCE.indexOf(`export function ${templateName}(`);
  if (start < 0) return {};
  const end = SOURCE.indexOf("): EmailTemplate", start);
  const sig = SOURCE.slice(start, end);
  const open = sig.indexOf("{");
  if (open < 0) return {};
  return buildFixture(sig.slice(open + 1, sig.lastIndexOf("}")));
}

type EmailTemplate = { subject: string; html: string; text: string };

const TEMPLATE_ENTRIES = Object.entries(templates as Record<string, unknown>).filter(
  ([name, value]) => typeof value === "function" && name.endsWith("Template"),
) as Array<[string, (input: unknown) => EmailTemplate]>;

const rendered = TEMPLATE_ENTRIES.map(([name, fn]) => ({ name, ...fn(inputFixtureFor(name)) }));

describe("email template sweep", () => {
  it("covers every exported template", () => {
    // Guards against the whole suite silently passing on an empty list.
    expect(TEMPLATE_ENTRIES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(TEMPLATE_ENTRIES.map(([name]) => name))("%s has every declared field populated", (name) => {
    // The fixture is parsed out of the signature's TEXT, so anything that
    // confuses the parser — a comment inside the braces, most easily — silently
    // drops the fields after it and renders them as undefined. That is only
    // caught downstream if the word "undefined" reaches the output, so a field
    // used behind a `??` fallback would slip through entirely.
    //
    // Real near-miss: a doc comment added above `dashboardUrl` hid it, and the
    // CTA rendered with no URL.
    const declared = [...
      (SOURCE.slice(
        SOURCE.indexOf(`export function ${name}(`),
        SOURCE.indexOf("): EmailTemplate", SOURCE.indexOf(`export function ${name}(`)),
      ).matchAll(/^\s*(\w+)\??\s*:/gm))
    ].map((match) => match[1]);

    const fixture = inputFixtureFor(name);
    for (const field of declared) {
      if (field === "input") continue;
      expect(fixture, `${name}.${field} was not populated — the signature parser missed it`)
        .toHaveProperty(field);
    }
  });

  it.each(rendered.map((r) => [r.name, r] as const))("%s renders a complete email", (_name, email) => {
    expect(email.subject.trim().length).toBeGreaterThan(0);
    expect(email.html.trim().length).toBeGreaterThan(0);
    expect(email.text.trim().length).toBeGreaterThan(0);
  });

  it.each(rendered.map((r) => [r.name, r] as const))("%s leaks no internals to the customer", (_name, email) => {
    const body = `${email.subject}\n${email.html}\n${email.text}`;
    expect(body).not.toMatch(/evo\s?labs|evolabs|arcline|basis\s?theory|veyra/i);
    expect(body).not.toMatch(/service_role|supabase|process\.env|sk_live|Bearer /i);
  });

  it.each(rendered.map((r) => [r.name, r] as const))("%s renders no undefined/NaN placeholders", (_name, email) => {
    const body = `${email.subject}\n${email.html}\n${email.text}`;
    expect(body).not.toMatch(/\bundefined\b/);
    expect(body).not.toMatch(/\bNaN\b/);
    expect(body).not.toMatch(/\[object Object\]/);
    expect(body).not.toMatch(/\$NaN|\$undefined/);
  });

  it.each(rendered.map((r) => [r.name, r] as const))("%s escapes attacker-controlled text", (_name, email) => {
    // Customer names and product names flow into these. A raw <script> tag
    // surviving into the HTML is a stored-XSS vector in any webmail that
    // renders it, and in the admin inbox that reads the notification copies.
    expect(email.html).not.toContain("<script>alert");
    if (email.html.includes("alert(")) {
      expect(email.html).toMatch(/&lt;script&gt;/);
    }
  });

  it.each(rendered.map((r) => [r.name, r] as const))("%s uses only absolute, safe links", (_name, email) => {
    const hrefs = [...email.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    for (const href of hrefs) {
      expect(href.length).toBeGreaterThan(0);
      // A relative href in an email resolves against the mail client, not the
      // site, and simply fails.
      expect(href).toMatch(/^(https:\/\/|mailto:)/);
      expect(href).not.toMatch(/^https:\/\/(localhost|127\.0\.0\.1)/);
    }
  });

  it.each(rendered.map((r) => [r.name, r] as const))("%s constrains width for mobile", (_name, email) => {
    // A fixed pixel width wider than ~600 forces horizontal scrolling in every
    // mobile mail client.
    const widths = [...email.html.matchAll(/(?:max-)?width:\s*(\d+)px/g)].map((m) => Number(m[1]));
    for (const width of widths) {
      expect(width).toBeLessThanOrEqual(640);
    }
  });

  it("interpolates no optional field straight after a label", () => {
    // The "Carrier: " bug: `Label: ${input.maybeMissing ?? ""}` renders the
    // label with nothing after it. Checked against the SOURCE rather than the
    // output, because a rendered "Heading:" whose value sits on the next line is
    // legitimate and indistinguishable from the broken shape.
    const offenders = [...SOURCE.matchAll(/[A-Z][A-Za-z ]{2,20}:\s*\$\{[^}]*\?\?\s*""[^}]*\}/g)].map((m) => m[0]);
    expect(offenders).toEqual([]);
  });
});

describe("shippingUpdateTemplate carrier handling", () => {
  // The regression that motivated the sweep: an unrecognised carrier is
  // withheld rather than printed, and must not leave a bare label behind.
  it("omits the carrier line entirely when the carrier is unknown", () => {
    const email = templates.shippingUpdateTemplate({
      customerName: "Sam",
      orderId: "VL-4F2A9C31",
      status: "Shipped",
      carrier: undefined,
      trackingNumber: "1Z0037BB0313242143",
      trackingUrl: "https://www.ups.com/track?tracknum=1Z0037BB0313242143",
    });
    expect(email.text).not.toMatch(/Carrier:/);
    expect(email.html).not.toMatch(/Carrier:/);
    expect(email.text).toContain("1Z0037BB0313242143");
  });

  it("names the carrier when it is known", () => {
    const email = templates.shippingUpdateTemplate({
      customerName: "Sam",
      orderId: "VL-4F2A9C31",
      status: "Shipped",
      carrier: "UPS",
      trackingNumber: "1Z0037BB0313242143",
      trackingUrl: "https://www.ups.com/track?tracknum=1Z0037BB0313242143",
    });
    expect(email.text).toContain("Carrier: UPS");
    expect(email.html).toContain("ups.com");
  });
});
