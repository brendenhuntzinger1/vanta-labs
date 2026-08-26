import { vi } from "vitest";

// Intentionally almost empty. See src/test-support/payment-suite-fakes.ts.
//
// This file used to apply vi.mock() to ELEVEN modules for every suite in the
// repository: @/lib/email/send, @/lib/coupons, @/lib/membership,
// @/lib/cart-recovery, @/lib/admin-control, @/lib/tax-provider,
// @/lib/membership-billing, @/lib/fulfillment/service, @/lib/ambassador-settings,
// @/lib/catalog and @/lib/supabase-server.
//
// A global stub is not free. It silently replaces the module for suites that
// never asked for it, so a test can exercise a stub, assert on the stub's return
// value, and pass while the real code is broken or never runs at all. That is not
// hypothetical here: a cart-recovery regression test written during this audit
// passed green while calling `runAbandonedCartSweep: async () => ({ t30mSent: 0,
// ... })` — a stub that touches no database and cannot fail. The @/lib/email/send
// stub returned `{ success: true }` unconditionally, so NO suite in this repo
// could observe a failed send, which is exactly what three separate email defects
// live behind.
//
// Each of the eleven was removed in isolation and the full suite re-run. NINE
// changed the result by zero tests — every suite that needed one already
// re-mocked it locally — so they were deleted. The remaining two were needed by
// exactly two suites, which now apply them explicitly.
//
// THE RULE: mock in the suite that needs the mock. If something genuinely belongs
// to every suite, it needs a comment here saying why, and a demonstration that a
// suite fails without it.
//
// (`server-only` is aliased to an empty module in vitest.config.ts rather than
// mocked here — that is a resolution concern, not a behavioural one.)

void vi;

export {};
