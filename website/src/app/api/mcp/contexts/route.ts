import { NextResponse } from "next/server";
import { getMcpStore } from "@/lib/mcp/store";
import type { McpJsonValue } from "@/lib/mcp/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = getMcpStore();
  return NextResponse.json({ success: true, contexts: store.listContexts() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as
    | { name?: unknown; payload?: McpJsonValue; metadata?: Record<string, string> }
    | null;

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ success: false, error: "Context name is required" }, { status: 400 });
  }

  const context = getMcpStore().createContext({
    name,
    payload: body?.payload ?? {},
    metadata: body?.metadata ?? {},
  });

  return NextResponse.json({ success: true, context }, { status: 201 });
}
