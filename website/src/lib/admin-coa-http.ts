import "server-only";

import { NextResponse } from "next/server";
import { CoaValidationError } from "@/lib/admin-coa";

// Shared responses for the four COA admin routes. A `route.ts` file may only
// export HTTP method handlers and route config, so these live here rather than
// being re-exported from whichever route happens to define them first.

export function coaUnauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export function coaForbiddenResponse() {
  return NextResponse.json(
    { success: false, error: "Only managers and super admins can manage COAs." },
    { status: 403 },
  );
}

/**
 * A validation failure is the operator's to fix and its message was written for
 * them ("Attach a file or a link before publishing"), so it is passed through.
 * Anything else is ours — logged in full, reported as a generic failure.
 */
export function coaErrorResponse(error: unknown, fallback: string) {
  if (error instanceof CoaValidationError) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }
  console.error("Admin COA error:", error);
  return NextResponse.json({ success: false, error: fallback }, { status: 400 });
}
