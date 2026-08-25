import { randomUUID } from "node:crypto";
import type {
  CreateMcpContextInput,
  CreateMcpTrafficEventInput,
  McpContextRecord,
  McpTrafficEvent,
  UpdateMcpContextInput,
} from "@/lib/mcp/types";

type TrafficListener = (event: McpTrafficEvent) => void;

export interface McpWebSocketClient {
  readyState: number;
  send: (data: string) => void;
}

const SOCKET_OPEN_STATE = 1;
const MAX_TRAFFIC_EVENTS = 500;

export class McpStore {
  private readonly contexts = new Map<string, McpContextRecord>();
  private readonly traffic: McpTrafficEvent[] = [];
  private readonly listeners = new Set<TrafficListener>();

  createContext(input: CreateMcpContextInput): McpContextRecord {
    const now = new Date().toISOString();
    const context: McpContextRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      payload: input.payload ?? {},
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.contexts.set(context.id, context);
    return context;
  }

  listContexts(): McpContextRecord[] {
    return Array.from(this.contexts.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getContext(id: string): McpContextRecord | null {
    return this.contexts.get(id) ?? null;
  }

  updateContext(id: string, input: UpdateMcpContextInput): McpContextRecord | null {
    const existing = this.contexts.get(id);
    if (!existing) {
      return null;
    }
    const updated: McpContextRecord = {
      ...existing,
      name: input.name === undefined ? existing.name : input.name.trim(),
      payload: input.payload ?? existing.payload,
      metadata: input.metadata ?? existing.metadata,
      updatedAt: new Date().toISOString(),
    };
    this.contexts.set(id, updated);
    return updated;
  }

  deleteContext(id: string): boolean {
    return this.contexts.delete(id);
  }

  listTraffic(limit = 100): McpTrafficEvent[] {
    const parsedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 100;
    return this.traffic.slice(-parsedLimit).reverse();
  }

  recordTraffic(input: CreateMcpTrafficEventInput): McpTrafficEvent {
    const event: McpTrafficEvent = {
      id: randomUUID(),
      contextId: input.contextId ?? null,
      transport: input.transport ?? "http",
      direction: input.direction,
      route: input.route,
      payload: input.payload,
      timestamp: new Date().toISOString(),
    };
    this.traffic.push(event);
    if (this.traffic.length > MAX_TRAFFIC_EVENTS) {
      this.traffic.splice(0, this.traffic.length - MAX_TRAFFIC_EVENTS);
    }
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }

  subscribe(listener: TrafficListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

type McpGlobal = typeof globalThis & {
  __vlMcpStore?: McpStore;
};

export function getMcpStore(): McpStore {
  const runtimeGlobal = globalThis as McpGlobal;
  runtimeGlobal.__vlMcpStore ??= new McpStore();
  return runtimeGlobal.__vlMcpStore;
}

export function bindMcpWebSocketClient(client: McpWebSocketClient): () => void {
  const store = getMcpStore();
  const unsubscribe = store.subscribe((event) => {
    if (client.readyState !== SOCKET_OPEN_STATE) {
      return;
    }
    client.send(JSON.stringify({ type: "mcp_traffic_event", event }));
  });
  const recentEvents = store.listTraffic(25).reverse();
  for (const event of recentEvents) {
    if (client.readyState !== SOCKET_OPEN_STATE) {
      break;
    }
    client.send(JSON.stringify({ type: "mcp_traffic_event", event }));
  }
  return unsubscribe;
}

export function resetMcpStoreForTests() {
  const runtimeGlobal = globalThis as McpGlobal;
  runtimeGlobal.__vlMcpStore = new McpStore();
}
