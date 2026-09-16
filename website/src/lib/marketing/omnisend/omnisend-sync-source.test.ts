import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SOURCE INVARIANTS FOR THE SERVER-SIDE OMNISEND SYNC.
 *
 * The modules under src/lib/marketing/omnisend/ hand a third party the
 * store's contacts, consent, orders and carts. The rules that keep that
 * honest are not visible to a behavioural test — they are about WHERE a call
 * sits (the gate before the key, the gate before the database), WHAT a log
 * line is allowed to carry, and WHICH modules are walled off from the
 * client bundle. So this suite reads the source.
 *
 * Files are DISCOVERED rather than listed: hooks.ts, sweeps.ts,
 * cart-offers.ts and migration-snapshot.ts are being written beside this
 * test, and each is covered the moment it lands and skipped while absent.
 * The only hard-coded list is the set of modules that must stay PURE, and a
 * new module is assumed to be an I/O module the moment it touches
 * supabaseAdmin or omnisendRequest.
 */

const DIR = join(process.cwd(), "src/lib/marketing/omnisend");
const read = (name: string) => readFileSync(join(DIR, name), "utf8");

/**
 * Modules with NO "server-only" import, on purpose: they are unit-tested
 * against fixed inputs and must never grow a database or network call.
 */
const PURE_MODULES = [
  "catalog-payload.ts",
  "config.ts",
  "contact-payload.ts",
  "events.ts",
  "link-token.ts",
  "ownership.ts",
  "reconcile-plan.ts",
] as const;

/** Modules whose exported async entry points must ask the gate before any database work. */
const GATE_FIRST_MODULES = ["order-hooks.ts", "reconcile.ts"] as const;

/** Modules other agents are writing now; each is checked once it exists. */
const EXPECTED_LATER = ["hooks.ts", "sweeps.ts", "cart-offers.ts", "migration-snapshot.ts"] as const;

/** Log arguments that would put personal data or a secret in the log stream. */
const FORBIDDEN_LOG_IDENTIFIERS = ["email", "phone", "token", "code", "apiKey", "key"] as const;

const modules = readdirSync(DIR)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
  .sort();

/** Source with comments removed: documenting a rule is not applying it. */
function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .map((line) => line.replace(/\s\/\/.*$/, ""))
    .join("\n");
}

/**
 * Executable source with string literals emptied, so a word inside a message
 * ("customer email read refused") is not mistaken for an identifier. Template
 * interpolations are kept as bare expressions: `${email}` in a log line leaks
 * exactly as the identifier would.
 */
function withoutStrings(source: string): string {
  return source
    .replace(/`(?:[^`\\]|\\.)*`/g, (literal) => {
      const parts = [...literal.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1]);
      return parts.length > 0 ? `(${parts.join(", ")})` : '""';
    })
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

/** Every `console.<method>(` call with its argument list, brackets balanced. */
function consoleCalls(source: string): string[] {
  const calls: string[] = [];
  const pattern = /\bconsole\.(?:log|info|warn|error|debug|trace)\(/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let index = start;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === "(" || char === "[" || char === "{") depth += 1;
      else if (char === ")" || char === "]" || char === "}") depth -= 1;
      index += 1;
    }
    calls.push(source.slice(start, index - 1));
  }
  return calls;
}

/** The bare identifiers among a call's arguments: positional, or object shorthand. */
function bareIdentifiers(args: string): string[] {
  const found: string[] = [];
  for (const match of args.matchAll(/(?:^|[\s,{(])([A-Za-z_$][\w$]*)(?=\s*(?:[,)}]|$))/g)) {
    found.push(match[1]);
  }
  return found;
}

type ExportedFunction = { name: string; body: string };

/** Each `export async function NAME(` with its body up to the next top-level declaration. */
function exportedAsyncFunctions(source: string): ExportedFunction[] {
  const found: ExportedFunction[] = [];
  const matches = [...source.matchAll(/^export async function ([A-Za-z_$][\w$]*)\s*\(/gm)];
  matches.forEach((match, index) => {
    const start = match.index;
    const next = matches[index + 1]?.index ?? source.length;
    const rest = source.slice(start, next);
    const following = rest.search(/\n(?:export |const |function |type |interface |async function )/);
    found.push({ name: match[1], body: following > 0 ? rest.slice(0, following) : rest });
  });
  return found;
}

const usesIo = (name: string) => /\bsupabaseAdmin\b|\bomnisendRequest\b/.test(executable(read(name)));
const ioModules = modules.filter((name) => usesIo(name) && !(PURE_MODULES as readonly string[]).includes(name));
const presentLater = EXPECTED_LATER.filter((name) => existsSync(join(DIR, name)));

describe("module discovery", () => {
  it("sees every module the plan names, so the invariants below are not vacuous", () => {
    expect(modules).toEqual(expect.arrayContaining([...PURE_MODULES, "client.ts", "contacts.ts", "order-hooks.ts", "reconcile.ts"]));
    expect(ioModules.length).toBeGreaterThan(0);
  });

  it("classifies every module as pure or I/O, so a new file is never unexamined", () => {
    for (const name of modules) {
      const pure = (PURE_MODULES as readonly string[]).includes(name);
      const importsDb = /\bfrom "@\/lib\/supabase-server"/.test(read(name));
      expect(pure || usesIo(name) || !importsDb, `${name} imports the database client without using it`).toBe(true);
    }
  });
});

describe("server-only walls", () => {
  it("every module that touches the database or the transport imports server-only", () => {
    for (const name of ioModules) {
      expect(executable(read(name)), `${name} reaches the database or Omnisend without a server-only wall`).toMatch(/^import "server-only";/m);
    }
  });

  it.each(PURE_MODULES)("%s stays pure: no server-only, no database, no transport, no environment", (name) => {
    const source = executable(read(name));
    expect(source).not.toMatch(/^import "server-only";/m);
    expect(source).not.toContain("supabaseAdmin");
    expect(source).not.toMatch(/^import[^\n]*supabase-server/m);
    if (name === "events.ts") {
      // The one allowed reach: the transport loaded on demand inside the
      // sender, so the builders stay importable from a plain test.
      expect(source).toMatch(/const \{ omnisendRequest \} = await import\("@\/lib\/marketing\/omnisend\/client"\);/);
      expect(source).not.toMatch(/^import[^\n]*omnisend\/client/m);
    } else {
      expect(source).not.toContain("omnisendRequest");
    }
  });

  it("no client component imports the Omnisend sync", () => {
    const src = join(process.cwd(), "src");
    const walk = (dir: string, found: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path, found);
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path);
      }
      return found;
    };
    for (const path of walk(src)) {
      const source = readFileSync(path, "utf8");
      if (!/^"use client";/m.test(source)) continue;
      expect(source, `${path.replace(src, "src")} is a client file importing the Omnisend sync`).not.toMatch(/from "@\/lib\/marketing\/omnisend/);
    }
  });
});

describe("log lines carry no address, number, token, code or key", () => {
  it.each(modules)("%s", (name) => {
    const source = withoutStrings(executable(read(name)));
    for (const args of consoleCalls(source)) {
      const leaked = bareIdentifiers(args).filter((identifier) => (FORBIDDEN_LOG_IDENTIFIERS as readonly string[]).includes(identifier));
      expect(leaked, `${name} logs ${leaked.join(", ")}: console.*(${args.trim()})`).toEqual([]);
    }
  });

  it("every I/O module that logs does so under an [omnisend/...] prefix", () => {
    for (const name of ioModules) {
      const source = executable(read(name));
      if (consoleCalls(source).length === 0) continue;
      expect(source, `${name} logs without an [omnisend/...] prefix`).toMatch(/\[omnisend(?:\/[a-z-]+)?\]/);
    }
  });
});

describe("the gate is asked before the database", () => {
  it.each(GATE_FIRST_MODULES)("%s: every exported async entry point references omnisendActive( before any supabaseAdmin use", (name) => {
    const source = executable(read(name));
    expect(source).toMatch(/import \{[^}]*\bomnisendActive\b[^}]*\} from "@\/lib\/marketing\/omnisend\/client";/);
    const entries = exportedAsyncFunctions(source);
    expect(entries.length, `${name} exports no async entry points`).toBeGreaterThan(0);
    for (const { name: fn, body } of entries) {
      const gate = body.indexOf("omnisendActive(");
      expect(gate, `${name}: ${fn} never asks omnisendActive()`).toBeGreaterThan(-1);
      const db = body.indexOf("supabaseAdmin");
      if (db > -1) expect(gate, `${name}: ${fn} touches supabaseAdmin before the gate`).toBeLessThan(db);
      const firstAwait = body.indexOf("await ");
      if (firstAwait > -1) expect(gate, `${name}: ${fn} awaits something before the gate`).toBeLessThan(firstAwait);
    }
  });

  it.each(presentLater.length > 0 ? presentLater : ["(none present yet)"])("%s: every exported async hook is gated and never throws", (name) => {
    if (name === "(none present yet)") return;
    const source = executable(read(name));
    const entries = exportedAsyncFunctions(source);
    expect(entries.length, `${name} exports no async entry points`).toBeGreaterThan(0);
    // A hook may ask the gate itself or delegate to a function that does.
    const gated = /\bomnisendActive\(|\bupsertOmnisendContact\(|\bsendOrderEventOnce\(|\bonOrder(?:Paid|Fulfilled|Cancelled|Refunded)\(|\breconcileOmnisendContacts\(|\bsyncOmnisendCatalog\(/;
    for (const { name: fn, body } of entries) {
      expect(body, `${name}: ${fn} never consults the gate`).toMatch(gated);
      const gate = body.indexOf("omnisendActive(");
      const db = body.indexOf("supabaseAdmin");
      if (db > -1) {
        expect(gate, `${name}: ${fn} touches supabaseAdmin without asking omnisendActive() first`).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(db);
      }
      expect(body, `${name}: ${fn} has no try/catch, so a marketing failure could reach the caller`).toMatch(/\btry\s*\{[\s\S]*\}\s*catch\b/);
    }
  });
});

describe("contact-payload.ts copies consent exactly", () => {
  const source = executable(read("contact-payload.ts"));

  it("never lets Omnisend send its own welcome message", () => {
    const values = [...source.matchAll(/sendWelcomeMessage:\s*([^,\n]+)/g)].map((match) => match[1].trim());
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => value === "false"), `sendWelcomeMessage is set to ${values.join(", ")}`).toBe(true);
  });

  it("pushes a phone identifier only alongside an SMS consent record", () => {
    const phoneRead = source.indexOf("const phone = facts.smsConsent ? normalizeE164(");
    const push = source.indexOf('type: "phone"');
    expect(phoneRead).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(phoneRead);
    const guard = source.lastIndexOf("if (phone && facts.smsConsent) {", push);
    expect(guard, "the phone identifier is pushed outside the smsConsent guard").toBeGreaterThan(phoneRead);
    // The SMS channel status is the store's record, never a literal.
    expect(source).toContain("channels: { sms: { status: facts.smsConsent.status, statusChangedAt: facts.smsConsent.changedAt } }");
    expect(source).not.toMatch(/sms:\s*\{\s*status:\s*"subscribed"/);
  });

  it("copies the email channel status from the facts rather than choosing one", () => {
    expect(source).toContain("channels: { email: { status: facts.emailConsent.status, statusChangedAt: facts.emailConsent.changedAt } }");
    expect(source).not.toMatch(/email:\s*\{\s*status:\s*"subscribed"/);
  });
});

describe("client.ts asks the environment gate before it reads the key", () => {
  const source = executable(read("client.ts"));

  it("in omnisendRequest, serverAdsReportingAllowed() runs before OMNISEND_API_KEY is read", () => {
    const start = source.indexOf("export async function omnisendRequest");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start);
    const gate = body.indexOf("serverAdsReportingAllowed()");
    const key = body.indexOf("OMNISEND_API_KEY");
    const fetchCall = body.indexOf("fetch(");
    expect(gate).toBeGreaterThan(-1);
    expect(key).toBeGreaterThan(gate);
    expect(fetchCall).toBeGreaterThan(key);
    expect(body.slice(gate, key)).toMatch(/if \(!environment\.allowed\)[\s\S]*return \{ ok: false, status: 0, body: null/);
  });

  it("in omnisendActive, the environment gate runs before omnisendConfigured()", () => {
    const start = source.indexOf("export function omnisendActive");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("export async function omnisendRequest"));
    const gate = body.indexOf("serverAdsReportingAllowed()");
    const configured = body.indexOf("omnisendConfigured()");
    expect(gate).toBeGreaterThan(-1);
    expect(configured).toBeGreaterThan(gate);
  });

  it("is the only module that reads OMNISEND_API_KEY, and never logs", () => {
    for (const name of modules) {
      if (name === "client.ts" || name === "config.ts") continue;
      expect(executable(read(name)), `${name} reads OMNISEND_API_KEY`).not.toContain("OMNISEND_API_KEY");
    }
    expect(source).not.toContain("console.");
  });
});
