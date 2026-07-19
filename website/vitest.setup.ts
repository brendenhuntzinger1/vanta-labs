import { vi } from "vitest";

type GenericRow = Record<string, unknown>;

vi.mock("@/lib/catalog", () => ({
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
    })),
}));

vi.mock("@/lib/supabase-server", () => {
  const state = {
    paymentEvents: new Set<string>(),
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

  function maybeSingleFor(table: string, filterCol?: string, filterValue?: string | boolean) {
    if (table === "products") {
      if (filterCol === "slug") {
        return state.products.find((row) => row.slug === String(filterValue)) ?? null;
      }
      return state.products[0] ?? null;
    }

    if (table === "payment_events" && filterCol === "event_id") {
      return state.paymentEvents.has(String(filterValue)) ? { event_id: String(filterValue) } : null;
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
      update: (payload: GenericRow) => ({
        eq: async (col: string, value: string) => {
          if (table === "orders" && col === "order_id") {
            const existing = state.orders.get(String(value)) ?? { id: `order-${value}`, order_id: String(value) };
            state.orders.set(String(value), { ...existing, ...payload });
          }

          if (table === "referral_orders" && col === "order_id") {
            const existing = state.referralOrders.get(String(value)) ?? { id: `ref-${value}`, order_id: String(value) };
            state.referralOrders.set(String(value), { ...existing, ...payload });
          }

          return { data: null, error: null };
        },
      }),
      delete: () => ({
        eq: async () => ({ data: null, error: null }),
      }),
      upsert: async (payload: GenericRow | GenericRow[]) => {
        const rows = Array.isArray(payload) ? payload : [payload];

        if (table === "payment_events") {
          for (const row of rows) {
            if (row?.event_id) {
              state.paymentEvents.add(String(row.event_id));
            }
          }
        }

        return { data: null, error: null };
      },
    };
  }

  const mockClient = {
    from: (table: string) => makeTableClient(table),
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
      admin: {
        inviteUserByEmail: async () => ({ data: null, error: null }),
      },
    },
  };

  return {
    createServerClient: () => mockClient,
    supabaseAdmin: mockClient,
  };
});
