import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const upgrade = request.headers.get("upgrade");
  if (upgrade && upgrade.toLowerCase() === "websocket") {
    return NextResponse.json(
      {
        success: false,
        error: "WebSocket upgrades are handled by the MCP bridge integration layer.",
      },
      { status: 426, headers: { Upgrade: "websocket" } },
    );
  }

  return NextResponse.json(
    {
      success: true,
      websocket: {
        supported: true,
        route: "/api/mcp/ws",
        protocol: "mcp-context.v1",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
