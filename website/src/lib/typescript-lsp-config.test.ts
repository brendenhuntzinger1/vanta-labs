import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE LANGUAGE SERVER THAT WAS ENABLED, INSTALLED, AND NEVER ONCE RAN.
//
// typescript-lsp was on in the checked-in settings, its binary was on PATH, and
// TypeScript 5.9.3 was installed both globally and in website/. No process ever
// started, no LSP tool ever appeared, and nothing anywhere said why.
//
// Claude Code starts a plugin's language servers from exactly two places — the
// plugin's own manifest (`lspServers`) or a `.lsp.json` in its root:
//
//     let K = A.lspServers || await nhY(A, q)
//     if (!K) return                            // ← neither: silently nothing
//
// The official plugin ships neither; its payload is a README and a LICENSE. Its
// lspServers block exists only in the marketplace catalogue, which the CLI
// deliberately will not read for this ("lspServers (not readable from
// marketplace)"). So it was healthy by every check anyone would think to run,
// and inert.
//
// This repo therefore ships its own plugin. These assert the parts that were
// silently absent before — because the failure mode is silence, and a config
// that stops resolving will not announce itself either.
// ---------------------------------------------------------------------------

const REPO = resolve(process.cwd(), "..");
const MARKETPLACE = join(REPO, ".claude/plugin-marketplace");
const PLUGIN = join(MARKETPLACE, "plugins/vanta-typescript-lsp");

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("the repo declares its own TypeScript language server", () => {
  it("registers the local marketplace in the checked-in settings", () => {
    const settings = readJson(join(REPO, ".claude/settings.json"));
    const entry = settings.extraKnownMarketplaces?.["vanta-local"];
    expect(entry, "no vanta-local marketplace registered").toBeTruthy();
    // Nested source object, not a bare string — the schema rejects the string
    // form, and it is the shape known_marketplaces.json uses.
    expect(entry.source).toEqual({
      source: "directory",
      path: "./.claude/plugin-marketplace",
    });
  });

  it("enables our plugin and leaves the inert official one off", () => {
    const { enabledPlugins } = readJson(join(REPO, ".claude/settings.json"));
    expect(enabledPlugins["vanta-typescript-lsp@vanta-local"]).toBe(true);
    // Two tsservers on this repo the day upstream ships a manifest is a real
    // cost, and the official plugin contributes nothing until then.
    expect(enabledPlugins["typescript-lsp@claude-plugins-official"]).toBe(false);
  });

  it("the marketplace points at a plugin directory that exists", () => {
    const manifest = readJson(join(MARKETPLACE, ".claude-plugin/marketplace.json"));
    expect(manifest.name).toBe("vanta-local");
    const entry = manifest.plugins.find((p: { name: string }) => p.name === "vanta-typescript-lsp");
    expect(entry, "plugin not listed in the marketplace").toBeTruthy();
    expect(existsSync(resolve(MARKETPLACE, entry.source))).toBe(true);
  });

  it("THE THING THAT WAS MISSING: the plugin manifest declares lspServers", () => {
    // Everything else can be right and this one absence makes the whole plugin
    // a no-op. It is the single assertion this file exists for.
    const plugin = readJson(join(PLUGIN, ".claude-plugin/plugin.json"));
    expect(plugin.lspServers?.typescript, "plugin declares no typescript LSP server")
      .toBeTruthy();
  });

  it("runs the server the way the CLI will invoke it", () => {
    const { typescript } = readJson(join(PLUGIN, ".claude-plugin/plugin.json")).lspServers;
    expect(typescript.command).toBe("typescript-language-server");
    expect(typescript.args).toContain("--stdio");
    // A command containing a space is rejected by the CLI's own schema; args
    // belong in the array.
    expect(typescript.command).not.toMatch(/\s/);
  });

  it("covers every extension the codebase actually uses", () => {
    const { typescript } = readJson(join(PLUGIN, ".claude-plugin/plugin.json")).lspServers;
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      expect(Object.keys(typescript.extensionToLanguage), `${ext} not mapped`).toContain(ext);
    }
  });
});

describe("the workspace it points at", () => {
  // READ LAZILY, because the defect being guarded against is a MISSING
  // lspServers block. Destructuring it at module scope threw during collection
  // when that was reproduced, and vitest reported "no tests" — a failing exit
  // code with no indication of why. It would have been read as a broken test
  // file rather than a broken config, which is how the original silence got
  // tolerated in the first place.
  const server = () => {
    const plugin = readJson(join(PLUGIN, ".claude-plugin/plugin.json"));
    const typescript = plugin.lspServers?.typescript;
    if (!typescript) {
      throw new Error(
        "the plugin manifest declares no typescript LSP server, so Claude Code will "
        + "start nothing — this is the exact defect the official typescript-lsp plugin has",
      );
    }
    return typescript;
  };

  /** Claude Code substitutes this before any environment expansion. */
  const expand = () =>
    resolve(String(server().workspaceFolder).replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, PLUGIN));

  it("resolves to website/, not the repo root", () => {
    // Not cosmetic. Started at the repo root the server reports "Using
    // Typescript version (bundled)" because there is no node_modules there;
    // started at website/ it reports "(workspace)" and uses the pinned copy.
    expect(expand()).toBe(join(REPO, "website"));
  });

  it("that directory has the TypeScript the server will resolve", () => {
    expect(existsSync(join(expand(), "node_modules/typescript/lib/tsserver.js"))).toBe(true);
  });

  it("uses ${CLAUDE_PLUGIN_ROOT} rather than a machine-specific path", () => {
    // An absolute path here works on exactly one clone.
    expect(server().workspaceFolder).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(server().workspaceFolder).not.toMatch(/^\/(home|Users)\//);
  });
});
