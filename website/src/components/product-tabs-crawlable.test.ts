import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const client = read("src/components/product-detail-client.tsx");

// ---------------------------------------------------------------------------
// GOOGLEBOT DOES NOT TAP TABS.
//
// The Description, Specifications and COA panels were mounted on click —
// `{activeTab === "description" && <div>...}` — so an unopened panel was not in
// the document at all. Same for the FAQ answers. Measured against production on
// 2026-09-03, counting occurrences OUTSIDE <script> (serialized RSC props are
// not page text):
//
//     product long description   10 in the HTML,  0 as page text
//     FAQ answer text             0 in the HTML,  0 as page text
//
// So the one substantial piece of per-product prose the store owns reached the
// browser as props and never as words, and the ~110 words of FAQ answers were
// not rendered anywhere. Both are now in the document from the first byte and
// hidden with the `hidden` attribute instead.
//
// `hidden` deliberately, rather than an off-screen or transparent trick: hidden
// content must leave the tab order and the accessibility tree, or a keyboard
// user tabs into text they cannot see. That is the same failure the age gate
// had. Google indexes content that is in the HTML behind a disclosure; what it
// cannot index is content that is not there until an interaction.
// ---------------------------------------------------------------------------
describe("product tabs and FAQ ship their content in the HTML", () => {
  it("renders every tab panel unconditionally", () => {
    for (const key of ["description", "specs", "coa"]) {
      expect(client, `panel ${key} must not be mounted on click`).not.toContain(`{activeTab === "${key}" && (`);
      expect(client).toContain(`id="product-panel-${key}"`);
      expect(client).toContain(`hidden={activeTab !== "${key}"}`);
    }
  });

  it("renders every FAQ answer unconditionally", () => {
    expect(client, "answers must not be mounted on click").not.toMatch(/\{openIndex === idx && \(/);
    expect(client).toContain('id={answerId}');
    expect(client).toContain("hidden={!open}");
  });

  it("hides closed panels with `hidden`, not with a trick that keeps them focusable", () => {
    // visibility/opacity/off-screen all leave the subtree in the tab order.
    const panelRegion = client.slice(client.indexOf('id="product-panel-description"'), client.indexOf('id="product-panel-coa"'));
    expect(panelRegion).not.toMatch(/opacity-0|sr-only|-left-\[9999|absolute -top-\[9999|visibility:\s*hidden/);
  });

  it("keeps the panels collapsed on arrival, so nothing on screen changes", () => {
    // The visible behaviour is unchanged: no panel is open until it is tapped.
    expect(client).toMatch(/const \[activeTab, setActiveTab\] = useState<TabKey \| null>\(null\)/);
    expect(client).toMatch(/const \[openIndex, setOpenIndex\] = useState<number \| null>\(null\)/);
  });

  it("wires each control to the thing it controls", () => {
    expect(client).toContain("aria-controls={`product-panel-${tab.key}`}");
    expect(client).toContain("id={`product-tab-${tab.key}`}");
    expect(client).toContain("aria-controls={answerId}");
    expect(client).toContain("aria-labelledby={questionId}");
    expect(client).toContain('aria-labelledby="product-tab-description"');
  });

  it("stays a disclosure rather than claiming to be a tablist", () => {
    // ARIA requires a tablist to have exactly one selected tab at all times.
    // This control set is allowed to have none — every panel starts closed and
    // clicking the open one closes it — so `role="tab"` would be a lie.
    // Comments stripped first: the source explains this decision in prose, and
    // the prose names the role it is declining to use.
    const code = client.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
    expect(code).not.toMatch(/role="tab(list|panel)?"/);
    expect(client).toContain("aria-expanded={activeTab === tab.key}");
  });
});
