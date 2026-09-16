import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ONE OWNER OF MARKETING SENDS, PINNED IN THE SOURCE (spec §3.1).
 *
 * `OMNISEND_MARKETING_OWNER=true` hands marketing to Omnisend. The rule is
 * only worth anything if every in-house sender that could put a marketing
 * message in front of a customer actually asks — and if the senders that must
 * KEEP running (the held-back event queue, transactional retries, the reapers)
 * do not. A behavioural test can only prove the jobs it thought to mock; this
 * reads the routes and names the jobs, so adding a fourth marketing job
 * without the check, or wrapping a transactional one by mistake, fails here.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** Source with comments removed: documenting the rule is not applying it. */
function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const OWNERSHIP = executable(read("src/lib/marketing/omnisend/ownership.ts"));
const LIFECYCLE = executable(read("src/app/api/cron/lifecycle/route.ts"));
const SEND = executable(read("src/app/api/admin/email/campaigns/[campaignId]/send/route.ts"));
const AUTOMATIONS = executable(read("src/app/api/admin/email/automations/route.ts"));

const CHECK = "marketingSendBlockedByOmnisend(";

/**
 * One entry of the JOBS map, from its key to the next key or the closing
 * brace — so the assertion holds whether the entry is written on one line or
 * spread over several.
 */
function jobEntry(name: string): string {
  const start = LIFECYCLE.indexOf(`\n  ${name}: {`);
  expect(start, `lifecycle job ${name} not found`).toBeGreaterThan(-1);
  const rest = LIFECYCLE.slice(start + 1);
  const next = rest.slice(1).search(/\n  [A-Za-z]+: \{|\n\};/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("ownership.ts", () => {
  it("derives the answer from the one switch in config.ts rather than reading the environment itself", () => {
    expect(OWNERSHIP).toMatch(/import \{[^}]*omnisendOwnsMarketing[^}]*\} from "\.\/config";/);
    expect(OWNERSHIP).not.toContain("OMNISEND_MARKETING_OWNER");
  });

  it("is importable anywhere, so the cron route and the admin routes share it without a server-only wall", () => {
    expect(OWNERSHIP).not.toContain('"server-only"');
  });
});

describe("the lifecycle schedule stands down exactly the marketing jobs", () => {
  it("imports the check and its reason from the Omnisend module", () => {
    expect(LIFECYCLE).toMatch(
      /import \{[^}]*MARKETING_OWNED_BY_OMNISEND[^}]*marketingSendBlockedByOmnisend[^}]*\} from "@\/lib\/marketing\/omnisend\/ownership";/,
    );
  });

  it.each(["cartRecovery", "emailAutomations", "emailCampaigns"])("%s consults the switch before running", (name) => {
    const entry = jobEntry(name);
    expect(entry).toContain(CHECK);
    expect(entry).toContain("skipped: MARKETING_OWNED_BY_OMNISEND");
  });

  it.each(["marketingQueue", "emailRetry", "orderEmailReaper", "marketingSendReaper"])(
    "%s keeps running, because it is not a marketing send Omnisend replaces",
    (name) => {
      expect(jobEntry(name)).not.toContain(CHECK);
    },
  );

  it("consults the switch for exactly three jobs, no more and no fewer", () => {
    const jobs = LIFECYCLE.slice(LIFECYCLE.indexOf("const JOBS: CronJobMap = {"), LIFECYCLE.indexOf("\n};") + 3);
    expect(jobs.split(CHECK).length - 1).toBe(3);
  });
});

describe("the admin campaign send route refuses while Omnisend owns marketing", () => {
  it("imports the check from the Omnisend module", () => {
    expect(SEND).toMatch(/import \{[^}]*marketingSendBlockedByOmnisend[^}]*\} from "@\/lib\/marketing\/omnisend\/ownership";/);
  });

  it("answers 409 with the message that names the switch and the way out", () => {
    const check = SEND.indexOf(CHECK);
    expect(check).toBeGreaterThan(-1);
    const block = SEND.slice(check, SEND.indexOf("\n  }", check));
    expect(block).toContain("{ status: 409 }");
    expect(block).toContain(
      '"Campaign sends are handled by Omnisend while OMNISEND_MARKETING_OWNER is set. Send this from Omnisend, or unset the switch to use the in-house sender."',
    );
  });

  it("checks after auth and before anything moves a campaign to scheduled or starts a send", () => {
    const auth = SEND.indexOf("verifyAdminSessionFromRequest(");
    const check = SEND.indexOf(CHECK);
    const firstStatusWrite = SEND.indexOf(".update({ status:");
    const queue = SEND.indexOf("queueCampaign(");
    expect(auth).toBeGreaterThan(-1);
    expect(firstStatusWrite).toBeGreaterThan(-1);
    expect(queue).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(auth);
    expect(check).toBeLessThan(firstStatusWrite);
    expect(check).toBeLessThan(queue);
  });

  it("asks exactly once, at the top, rather than once per branch", () => {
    expect(SEND.split(CHECK).length - 1).toBe(1);
  });
});

describe("the admin automations GET reports who owns marketing", () => {
  it("returns marketingOwner as omnisend or native from the same check", () => {
    expect(AUTOMATIONS).toContain("export async function GET(");
    expect(AUTOMATIONS).toContain(`marketingOwner: ${CHECK}) ? "omnisend" : "native"`);
  });
});
