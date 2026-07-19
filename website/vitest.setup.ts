import { vi } from "vitest";

vi.mock("@/lib/supabase-server", () => {
  const state = {
    paymentEvents: new Set<string>(),
    orders: new Map<string, { id: string; order_id: string; payment_status?: string; paid_at?: string | null }>(),
    referralOrders: new Map<string, { id: string; order_id: string; payment_status?: string }>(),
    ambassadors: new Map<string, { id: string; name: string; referral_code: string; commission_percent: number; status: string }>(),
  };

  function maybeSingleFor(table: string, filterCol?: string, filterValue?: string) {
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
    let filterValue: string | undefined;

    return {
      eq: (col: string, value: string) => {
        filterCol = col;
        filterValue = value;
        return {
          maybeSingle: async () => ({ data: maybeSingleFor(table, filterCol, filterValue), error: null }),
          single: async () => ({ data: maybeSingleFor(table, filterCol, filterValue) ?? { id: "mock-id" }, error: null }),
          limit: async () => ({ data: [], error: null }),
        };
      },
      maybeSingle: async () => ({ data: maybeSingleFor(table, filterCol, filterValue), error: null }),
      single: async () => ({ data: maybeSingleFor(table, filterCol, filterValue) ?? { id: "mock-id" }, error: null }),
      in: async () => ({ data: [], error: null }),
    };
  }

  function makeTableClient(table: string) {
    return {
      select: (_columns?: string) => makeSelectChain(table),
      insert: (payload: any) => {
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
          select: (_columns?: string) => ({
            single: async () => ({ data: { id: "mock-id" }, error: null }),
          }),
        };
      },
      update: (payload: any) => ({
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
      upsert: async (payload: any) => {
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
