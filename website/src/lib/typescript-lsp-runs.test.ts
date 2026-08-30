import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// DOES THE DECLARED LANGUAGE SERVER ACTUALLY START?
//
// typescript-lsp-config.test.ts asserts that the plugin manifest has the right
// SHAPE. It passed, green, through an entire session in which no language
// server ran at all — because a manifest can be perfectly formed and still name
// a command that is absent, or a workspace that resolves the wrong TypeScript,
// or a server that dies during `initialize`. Shape is not startup.
//
// So this file takes the manifest's own `command`, `args` and `workspaceFolder`
// — not a hand-copied approximation of them — spawns exactly that, and speaks
// LSP to it. The assertions are on what the server REPLIES:
//
//   * that it answers `initialize` at all
//   * that it advertises the capabilities the plugin exists to provide
//   * that it resolved TypeScript from the WORKSPACE, not its bundled copy
//
// The last one is the one that matters and the one no config check can make.
// Started at the repo root the server reports "(bundled)" and happily works —
// against a different TypeScript than the one this project pins. Started at
// website/ it reports "(workspace) 5.9.3". Both are a healthy server; only one
// is the right answer, and only asking it tells them apart.
//
// This test does NOT prove the LSP is running inside any given Claude Code
// session — nothing inside the test process can see that. It proves the
// configuration this repo ships produces a working server when honoured, which
// is the half that lives in this repository.
// ---------------------------------------------------------------------------

const REPO = resolve(process.cwd(), "..");
const PLUGIN = join(REPO, ".claude/plugin-marketplace/plugins/vanta-typescript-lsp");

type LspServer = {
  command: string;
  args: string[];
  workspaceFolder: string;
};

function declaredServer(): LspServer {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin/plugin.json"), "utf8"));
  const server = manifest.lspServers?.typescript;
  if (!server) {
    throw new Error(
      "the plugin manifest declares no typescript LSP server, so Claude Code starts nothing — "
      + "this is the exact defect the official typescript-lsp plugin has",
    );
  }
  return server;
}

/** Claude Code substitutes this before any environment expansion. */
function workspaceFolder(server: LspServer) {
  return resolve(String(server.workspaceFolder).replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, PLUGIN));
}

type Initialized = {
  capabilities: Record<string, unknown>;
  logs: string[];
};

/**
 * Spawn the declared server and complete an LSP `initialize` handshake.
 *
 * Framing is the LSP wire protocol proper (Content-Length header, then a JSON
 * body) rather than line-delimited JSON, because that is what the server
 * speaks; a newline-framed request is silently ignored and looks like a hang.
 */
async function initialize(server: LspServer, root: string, timeoutMs: number): Promise<Initialized> {
  const proc = spawn(server.command, server.args, { cwd: root });
  const logs: string[] = [];

  try {
    return await new Promise<Initialized>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error(`${server.command} did not answer initialize within ${timeoutMs}ms`)),
        timeoutMs,
      );

      proc.on("error", (error) => {
        clearTimeout(timer);
        rejectPromise(new Error(`could not spawn ${server.command}: ${error.message}`));
      });

      let buffer = Buffer.alloc(0);
      proc.stdout.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd < 0) return;
          const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1]);
          if (!Number.isFinite(length) || buffer.length < headerEnd + 4 + length) return;
          const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
          buffer = buffer.subarray(headerEnd + 4 + length);

          // The TypeScript version is announced as a log notification, not in
          // the initialize result, so both have to be collected.
          if (message.method === "window/logMessage") logs.push(String(message.params?.message ?? ""));
          if (message.id === 1) {
            clearTimeout(timer);
            // Give the version notification, which follows the result, a moment
            // to arrive before the transport is torn down.
            setTimeout(() => resolvePromise({ capabilities: message.result?.capabilities ?? {}, logs }), 750);
          }
        }
      });

      const request = Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          processId: process.pid,
          rootUri: pathToFileURL(root).href,
          workspaceFolders: [{ uri: pathToFileURL(root).href, name: "workspace" }],
          capabilities: {},
          initializationOptions: {},
        },
      }), "utf8");
      proc.stdin.write(`Content-Length: ${request.length}\r\n\r\n`);
      proc.stdin.write(request);
    });
  } finally {
    proc.kill();
  }
}

// The server has to load a real TypeScript and index a Next.js app, which is
// slower than a unit test's default budget on a cold container.
const TIMEOUT = 60_000;

describe("the declared TypeScript language server actually starts", () => {
  it("the command it names is on PATH", () => {
    // Absent, `spawn` fails with ENOENT and every assertion below fails for a
    // reason that has nothing to do with the configuration under test.
    const { command } = declaredServer();
    const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
    expect(
      dirs.some((dir) => existsSync(join(dir, command))),
      `${command} is not on PATH — the plugin names a command this machine does not have`,
    ).toBe(true);
  });

  it("answers initialize and advertises the capabilities the plugin exists for", async () => {
    const server = declaredServer();
    const { capabilities } = await initialize(server, workspaceFolder(server), TIMEOUT);

    // A server that starts but provides none of these is indistinguishable, to
    // anyone using it, from the plugin that started nothing at all.
    expect(capabilities.definitionProvider, "no go-to-definition").toBeTruthy();
    expect(capabilities.referencesProvider, "no find-references").toBeTruthy();
    expect(capabilities.hoverProvider, "no hover/type-at-point").toBeTruthy();
  }, TIMEOUT);

  it("resolves the WORKSPACE TypeScript, not its own bundled copy", async () => {
    // The whole reason workspaceFolder points at website/ rather than the repo
    // root. At the root there is no node_modules and the server silently falls
    // back to "(bundled)" — a different compiler than the one this project
    // pins, which is how a type error can be reported here and not in CI.
    const server = declaredServer();
    const { logs } = await initialize(server, workspaceFolder(server), TIMEOUT);

    const version = logs.find((line) => /Using Typescript version/i.test(line));
    expect(version, "the server never reported which TypeScript it loaded").toBeTruthy();
    expect(version).toMatch(/\(workspace\)/);
    expect(version).toContain(join(workspaceFolder(server), "node_modules/typescript"));
  }, TIMEOUT);

  it("would have reported (bundled) from the repo root — the mistake this config avoids", async () => {
    // A NEGATIVE CONTROL. Without it, the assertion above passes for a server
    // that reports "(workspace)" from anywhere, and the workspaceFolder setting
    // could be wrong — or dropped entirely — with nothing to catch it.
    const server = declaredServer();
    expect(existsSync(join(REPO, "node_modules")), "the repo root has node_modules now; this control no longer isolates the workspace choice").toBe(false);

    const { logs } = await initialize(server, REPO, TIMEOUT);
    const version = logs.find((line) => /Using Typescript version/i.test(line));
    expect(version, "the server never reported which TypeScript it loaded").toBeTruthy();
    expect(version).toMatch(/\(bundled\)/);
  }, TIMEOUT);
});
