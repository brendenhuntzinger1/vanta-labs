import { beforeEach, describe, expect, it } from "vitest";
import { resetMcpStoreForTests } from "@/lib/mcp/store";
import { GET as listContexts, POST as createContext } from "@/app/api/mcp/contexts/route";
import {
  DELETE as deleteContext,
  GET as getContext,
  PATCH as updateContext,
} from "@/app/api/mcp/contexts/[contextId]/route";
import { GET as listEvents, POST as createEvent } from "@/app/api/mcp/events/route";

beforeEach(() => {
  resetMcpStoreForTests();
});

describe("MCP API routes", () => {
  it("creates, fetches, updates and deletes a context", async () => {
    const createdResponse = await createContext(
      new Request("https://vantalabsresearch.com/api/mcp/contexts", {
        method: "POST",
        body: JSON.stringify({ name: "cart", payload: { itemCount: 1 } }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(createdResponse.status).toBe(201);
    const createdBody = (await createdResponse.json()) as { context: { id: string; name: string } };
    expect(createdBody.context.name).toBe("cart");

    const listed = await listContexts();
    const listedBody = (await listed.json()) as { contexts: Array<{ id: string }> };
    expect(listedBody.contexts.map((context) => context.id)).toContain(createdBody.context.id);

    const fetched = await getContext(new Request("https://vantalabsresearch.com/api/mcp/contexts"), {
      params: Promise.resolve({ contextId: createdBody.context.id }),
    });
    expect(fetched.status).toBe(200);

    const patched = await updateContext(
      new Request("https://vantalabsresearch.com/api/mcp/contexts", {
        method: "PATCH",
        body: JSON.stringify({ name: "cart-updated" }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ contextId: createdBody.context.id }) },
    );
    const patchedBody = (await patched.json()) as { context: { name: string } };
    expect(patchedBody.context.name).toBe("cart-updated");

    const deleted = await deleteContext(new Request("https://vantalabsresearch.com/api/mcp/contexts"), {
      params: Promise.resolve({ contextId: createdBody.context.id }),
    });
    expect(deleted.status).toBe(200);
  });

  it("records and lists MCP traffic events", async () => {
    const created = await createEvent(
      new Request("https://vantalabsresearch.com/api/mcp/events", {
        method: "POST",
        body: JSON.stringify({
          direction: "request",
          route: "/api/mcp/contexts",
          payload: { name: "checkout" },
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(created.status).toBe(201);

    const listed = await listEvents(new Request("https://vantalabsresearch.com/api/mcp/events?limit=5"));
    const listedBody = (await listed.json()) as { events: Array<{ route: string }> };
    expect(listedBody.events[0]?.route).toBe("/api/mcp/contexts");
  });
});
