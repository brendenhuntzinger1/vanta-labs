import { NextResponse } from "next/server";
import { getMcpStore } from "@/lib/mcp/store";
import type { McpJsonValue } from "@/lib/mcp/types";

type Params = { params: Promise<{ contextId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { contextId } = await params;
  const context = getMcpStore().getContext(contextId);
  if (!context) {
    return NextResponse.json({ success: false, error: "Context not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true, context }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: Request, { params }: Params) {
  const { contextId } = await params;
  const body = await request.json().catch(() => null) as
    | { name?: unknown; payload?: McpJsonValue; metadata?: Record<string, string> }
    | null;
  const updated = getMcpStore().updateContext(contextId, {
    name: typeof body?.name === "string" ? body.name : undefined,
    payload: body?.payload,
    metadata: body?.metadata,
  });
  if (!updated) {
    return NextResponse.json({ success: false, error: "Context not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true, context: updated });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { contextId } = await params;
  const deleted = getMcpStore().deleteContext(contextId);
  if (!deleted) {
    return NextResponse.json({ success: false, error: "Context not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
