import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// A PAGE LOAD MUST NOT BE ABLE TO SPEND THE CUSTOMER'S ONE SPIN.
//
// /api/spin does two jobs. Drawing a prize is irreversible — one spin per
// customer, for ever. Re-arming a second device for a prize already won is not.
// Only the button is entitled to the first, and the wheel's re-arm effect runs
// on MOUNT, with no click and no intent behind it.
//
// That distinction used to live entirely in the client: `if (!initialResult)
// return` inside the effect. On 2026-09-17 a prize was minted on production at
// 14:26:28 with no button press, seconds after a GET /spin, and a controlled
// re-test under apparently identical conditions did not reproduce it. The cause
// is unexplained. The shape of the hazard is not, and a guard that only holds
// while the caller reasons correctly is not a guard.
//
// So the server decides. `rearmOnly` reaches readExistingSpin, which selects
// and cannot insert; the draw is reachable only without it. These assertions
// are what stop the two paths being merged back together by someone who reads
// the route as "one endpoint that gets a prize".
// ---------------------------------------------------------------------------

const ROUTE = readFileSync("src/app/api/spin/route.ts", "utf8");
const WHEEL = readFileSync("src/components/spin-wheel.tsx", "utf8");
const SERVICE = readFileSync("src/lib/spin/spin-service.ts", "utf8");

describe("the mount effect asks for a re-arm, never a draw", () => {
  it("sends rearmOnly from the effect that runs without a click", () => {
    const effect = WHEEL.slice(WHEEL.indexOf("const rearmed = useRef(false)"));
    const post = effect.indexOf('fetch("/api/spin"');
    expect(post).toBeGreaterThan(-1);
    expect(effect.slice(post, post + 320)).toContain("rearmOnly: true");
  });

  it("does not send it from the button, which is the one caller entitled to draw", () => {
    // The spin() handler posts the token alone. If rearmOnly ever appears there
    // the button stops working, silently, for every customer.
    const handler = WHEEL.slice(0, WHEEL.indexOf("const rearmed = useRef(false)"));
    const post = handler.indexOf('fetch("/api/spin"');
    if (post > -1) {
      expect(handler.slice(post, post + 320)).not.toContain("rearmOnly");
    }
  });
});

describe("the server refuses to draw for a page load", () => {
  it("routes a rearmOnly request to the read, not the draw", () => {
    expect(ROUTE).toMatch(/const rearmOnly = body\.rearmOnly === true/);
    expect(ROUTE).toMatch(/rearmOnly\s*\?\s*await readExistingSpin\(/);
  });

  it("answers plainly when there is nothing to pick up", () => {
    // Not an error: the page asked whether a prize was waiting and there wasn't
    // one. An error here would put a red banner on a perfectly good wheel.
    expect(ROUTE).toContain("if (rearmOnly && !result)");
    expect(ROUTE).toMatch(/success: true, alreadySpun: false, rearmed: false/);
  });

  it("keeps the draw reachable for a real press", () => {
    expect(ROUTE).toMatch(/:\s*await spin\(\{ email: verified\.email, campaignId: verified\.campaignId \}\)/);
  });

  it("relies on readExistingSpin being incapable of minting", () => {
    // The whole safety argument in one assertion. spin() inserts; the function
    // the re-arm path reaches must not.
    const read = SERVICE.slice(
      SERVICE.indexOf("export async function readExistingSpin"),
      SERVICE.indexOf("export async function spin"),
    );
    expect(read.length).toBeGreaterThan(100);
    expect(read, "readExistingSpin must never insert an offer row").not.toMatch(/\.insert\(/);
  });
});
