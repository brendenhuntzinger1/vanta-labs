import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindMcpWebSocketClient, getMcpStore, resetMcpStoreForTests } from "@/lib/mcp/store";

beforeEach(() => {
  resetMcpStoreForTests();
});

describe("McpStore", () => {
  it("supports context CRUD operations", () => {
    const store = getMcpStore();
    const created = store.createContext({ name: "checkout", payload: { orderId: "o-1" } });

    expect(store.listContexts()).toHaveLength(1);
    expect(store.getContext(created.id)?.name).toBe("checkout");

    const updated = store.updateContext(created.id, { name: "checkout-v2", metadata: { source: "test" } });
    expect(updated?.name).toBe("checkout-v2");
    expect(updated?.metadata).toEqual({ source: "test" });

    expect(store.deleteContext(created.id)).toBe(true);
    expect(store.getContext(created.id)).toBeNull();
  });

  it("records traffic and streams to bound websocket clients", () => {
    const send = vi.fn();
    const unbind = bindMcpWebSocketClient({ readyState: 1, send });
    const store = getMcpStore();

    store.recordTraffic({
      direction: "request",
      route: "/api/mcp/contexts",
      payload: { name: "checkout" },
    });

    expect(store.listTraffic(1)[0]?.route).toBe("/api/mcp/contexts");
    expect(send).toHaveBeenCalled();
    unbind();
  });
});
