/**
 * Fakes for the two payment suites — payment-service.test.ts and
 * payment-webhook-identity.test.ts.
 *
 * WHY THIS FILE EXISTS. Both of these were `vi.mock()` calls in vitest.setup.ts,
 * which vitest applies to EVERY suite in the repository. Nine other modules were
 * stubbed there too — including @/lib/email/send, stubbed to return
 * `{ success: true }` unconditionally, so no suite anywhere could observe a send
 * failure. Removing each of those nine changed the suite result by exactly zero
 * tests: they were load-bearing for nothing and hazardous for everything.
 *
 * These two are the only ones any suite actually depended on. They live here,
 * applied explicitly by the two files that need them, so a suite's fakes are
 * visible in the suite rather than acting on 200 files that never asked for them.
 *
 * The bodies below are unchanged from vitest.setup.ts.
 */

type GenericRow = Record<string, unknown>;

export function catalogModule() {
  return {
  getCatalogProductsBySlugs: async (slugs: string[]) => slugs
    .filter((slug) => slug === "bpc-157-10mg")
    .map((slug) => ({
      slug,
      name: "BPC-157",
      category: "Research Peptides",
      price: "$44.99",
      stockStatus: "In Stock",
      batchNumber: "VL-0718A",
      purityResult: "99.8%",
      description: "Synthetic pentadecapeptide.",
      image: "/images/vantalabs.png",
      testingDate: "2026-07-10",
      labName: "Vanta Independent Testing Group",
      coaUrl: "/demo-coa.pdf",
      molecularFormula: "C62H98N16O22",
      // Note the ABSENCE of inventoryQuantity: the real catalog reads no longer
      // publish it, because these objects are serialized to client components.
      // The checkout oversell guard reads getStockLevelsBySlugs instead.
    })),
  // Empty map = no stock on record, which makes the secondary oversell guard a
  // no-op. That is the correct default here: these suites test pricing, and the
  // authoritative gate is the atomic reservation, not this guard.
  getStockLevelsBySlugs: async () => new Map<string, number>(),
};
}

export function supabaseServerModule() {
  const state = {
    paymentEvents: new Map<string, { event_id: string; processed_at: unknown; claimed_at: unknown }>(),
    orders: new Map<string, { id: string; order_id: string; payment_status?: unknown; paid_at?: unknown }>(),
    referralOrders: new Map<string, { id: string; order_id: string; payment_status?: unknown }>(),
    ambassadors: new Map<string, { id: string; name: string; referral_code: string; commission_percent: number; status: string }>(),
    products: [
      {
        slug: "bpc-157-10mg",
        name: "BPC-157",
        category: "Research Peptides",
        price_cents: 4499,
        stock_status: "In Stock",
        batch_number: "VL-0718A",
        purity_result: "99.8%",
        description: "Synthetic pentadecapeptide.",
        image_url: "/images/vantalabs.png",
        testing_date: "2026-07-10",
        lab_name: "Vanta Independent Testing Group",
        coa_url: "/demo-coa.pdf",
        molecular_formula: "C62H98N16O22",
        is_active: true,
      },
    ],
  };

  // Exposed so a suite can seed a pre-existing row and then assert what a
  // webhook did to it. Without this the mock is write-only from a test's point
  // of view, which is how a webhook that NULLED a real order's customer email
  // sat here undetected: every existing test asserted the returned status, and
  // none could look at the row afterwards.
  (globalThis as Record<string, unknown>).__vlSupabaseState = state;

  function maybeSingleFor(table: string, filterCol?: string, filterValue?: string | boolean) {
    if (table === "products") {
      if (filterCol === "slug") {
        return state.products.find((row) => row.slug === String(filterValue)) ?? null;
      }
      return state.products[0] ?? null;
    }

    if (table === "payment_events" && filterCol === "event_id") {
      return state.paymentEvents.get(String(filterValue)) ?? null;
    }

    if (table === "orders" && filterCol === "order_id") {
      return state.orders.get(String(filterValue)) ?? null;
    }

    if (table === "referral_orders" && filterCol === "order_id") {
      return state.referralOrders.get(String(filterValue)) ?? null;
    }

    if (table === "ambassadors" && filterCol === "referral_code") {
      return state.ambassadors.get(String(filterValue)) ?? null;
    }

    return null;
  }

  function makeSelectChain(table: string) {
    let filterCol: string | undefined;
    let filterValue: string | boolean | undefined;
    let inFilterCol: string | undefined;
    let inFilterValues: string[] | undefined;

    const getRows = () => {
      if (table === "products") {
        let rows = [...state.products];
        const slugFilterValues = inFilterValues;
        if (inFilterCol === "slug" && slugFilterValues) {
          rows = rows.filter((row) => slugFilterValues.includes(row.slug));
        }
        if (filterCol === "slug") {
          rows = rows.filter((row) => row.slug === String(filterValue));
        }
        if (filterCol === "is_active") {
          rows = rows.filter((row) => row.is_active === filterValue);
        }
        return rows;
      }

      const maybeSingle = maybeSingleFor(table, filterCol, filterValue);
      return maybeSingle ? [maybeSingle] : [];
    };

    const chain = {
      eq: (col: string, value: string | boolean) => {
        filterCol = col;
        filterValue = value;
        return chain;
      },
      in: (col: string, values: string[]) => {
        inFilterCol = col;
        inFilterValues = values;
        return chain;
      },
      order: async () => ({ data: getRows(), error: null }),
      maybeSingle: async () => ({ data: getRows()[0] ?? null, error: null }),
      single: async () => ({ data: getRows()[0] ?? { id: "mock-id" }, error: null }),
      limit: async () => ({ data: getRows(), error: null }),
    };

    return chain;
  }

  function makeTableClient(table: string) {
    return {
      select: () => makeSelectChain(table),
      insert: (payload: GenericRow | GenericRow[]) => {
        const rows = Array.isArray(payload) ? payload : [payload];

        // Simulate the payment_events primary-key uniqueness so the atomic
        // claim-based webhook idempotency (insert -> 23505 on duplicate) can be
        // exercised in tests.
        if (table === "payment_events") {
          for (const row of rows) {
            const id = String(row?.event_id ?? "");
            if (id && state.paymentEvents.has(id)) {
              return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
            }
          }
          for (const row of rows) {
            if (row?.event_id) {
              state.paymentEvents.set(String(row.event_id), {
                event_id: String(row.event_id),
                processed_at: row.processed_at ?? null,
                claimed_at: row.claimed_at ?? new Date().toISOString(),
              });
            }
          }
          return { data: null, error: null };
        }

        if (table === "orders") {
          for (const row of rows) {
            const orderId = String(row.order_id ?? "mock-order");
            state.orders.set(orderId, { id: `order-${orderId}`, order_id: orderId, payment_status: row.payment_status, paid_at: row.paid_at ?? null });
          }
        }

        if (table === "referral_orders") {
          for (const row of rows) {
            const orderId = String(row.order_id ?? "mock-order");
            state.referralOrders.set(orderId, { id: `ref-${orderId}`, order_id: orderId, payment_status: row.payment_status });
          }
        }

        return {
          data: null,
          error: null,
          select: () => ({
            single: async () => ({ data: { id: "mock-id" }, error: null }),
          }),
        };
      },
      update: (payload: GenericRow) => {
        const filters: Record<string, string> = {};
        const apply = () => {
          if (table === "orders" && filters.order_id !== undefined) {
            const existing = state.orders.get(filters.order_id) ?? { id: `order-${filters.order_id}`, order_id: filters.order_id };
            state.orders.set(filters.order_id, { ...existing, ...payload });
            return { data: [{ id: existing.id, order_id: filters.order_id }], error: null };
          }
          if (table === "referral_orders" && filters.order_id !== undefined) {
            const existing = state.referralOrders.get(filters.order_id) ?? { id: `ref-${filters.order_id}`, order_id: filters.order_id };
            state.referralOrders.set(filters.order_id, { ...existing, ...payload });
            return { data: [{ id: existing.id }], error: null };
          }
          if (table === "payment_events" && filters.event_id !== undefined) {
            const existing = state.paymentEvents.get(filters.event_id);
            if (existing) {
              state.paymentEvents.set(filters.event_id, { ...existing, ...(payload as object) });
            }
            return { data: existing ? [{ event_id: filters.event_id }] : [], error: null };
          }
          return { data: [], error: null };
        };
        // Chainable, awaitable builder supporting eq/neq/is/lt/gt + terminal select().
        const builder: Record<string, unknown> = {
          eq: (col: string, value: string) => { filters[col] = String(value); return builder; },
          neq: () => builder,
          is: () => builder,
          lt: () => builder,
          gt: () => builder,
          select: () => apply(),
          then: (resolve: (v: unknown) => unknown) => resolve(apply()),
        };
        return builder;
      },
      delete: () => ({
        eq: async () => ({ data: null, error: null }),
      }),
      upsert: async (payload: GenericRow | GenericRow[]) => {
        const rows = Array.isArray(payload) ? payload : [payload];

        if (table === "payment_events") {
          for (const row of rows) {
            if (row?.event_id) {
              const id = String(row.event_id);
              const existing = state.paymentEvents.get(id);
              state.paymentEvents.set(id, {
                event_id: id,
                processed_at: row.processed_at ?? existing?.processed_at ?? new Date().toISOString(),
                claimed_at: existing?.claimed_at ?? new Date().toISOString(),
              });
            }
          }
        }

        return { data: null, error: null };
      },
    };
  }

  const mockClient = {
    from: (table: string) => makeTableClient(table),
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
      admin: {
        inviteUserByEmail: async () => ({ data: null, error: null }),
        // isApprovedAmbassadorCustomer reads the ACCOUNT's own email here rather
        // than trusting the address on the order — a guest who typed an
        // ambassador's address used to collect their personal discount. These
        // suites drive quote-order with fixtures that are nobody's ambassador,
        // so "no such account" is the honest answer and keeps the personal
        // discount out of the money math they are actually asserting.
        getUserById: async () => ({ data: { user: null }, error: null }),
      },
    },
  };

  return {
    createServerClient: () => mockClient,
    supabaseAdmin: mockClient,
  };
}
