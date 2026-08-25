import { NextResponse } from "next/server";
import { getMcpStore } from "@/lib/mcp/store";
import type { McpJsonValue, McpTrafficEvent } from "@/lib/mcp/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, Math.floor(requestedLimit))) : 100;
  const events = getMcpStore().listTraffic(limit);
  return NextResponse.json({ success: true, events }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as
    | {
        contextId?: unknown;
        transport?: McpTrafficEvent["transport"];
        direction?: McpTrafficEvent["direction"];
        route?: unknown;
        payload?: McpJsonValue;
      }
    | null;

  if (!body || (body.direction !== "request" && body.direction !== "response" && body.direction !== "event")) {
    return NextResponse.json({ success: false, error: "direction is required" }, { status: 400 });
  }
  const route = typeof body.route === "string" ? body.route.trim() : "";
  if (!route) {
    return NextResponse.json({ success: false, error: "route is required" }, { status: 400 });
  }

  const event = getMcpStore().recordTraffic({
    contextId: typeof body.contextId === "string" ? body.contextId : null,
    transport: body.transport === "websocket" ? "websocket" : "http",
    direction: body.direction,
    route,
    payload: body.payload ?? {},
  });
  return NextResponse.json({ success: true, event }, { status: 201 });
}
