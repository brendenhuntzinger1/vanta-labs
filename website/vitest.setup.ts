import { vi } from "vitest";

vi.mock("@/lib/supabase-server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/supabase-server")>("@/lib/supabase-server");
  return {
    ...actual,
    supabaseAdmin: {
      from: () => ({
        insert: async () => ({ data: null, error: null }),
        update: async () => ({ data: null, error: null }),
        delete: async () => ({ data: null, error: null }),
        select: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
          single: async () => ({ data: { id: "mock-id" }, error: null }),
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
            single: async () => ({ data: { id: "mock-id" }, error: null }),
            limit: async () => ({ data: [], error: null }),
          }),
          in: async () => ({ data: [], error: null }),
        }),
        upsert: async () => ({ data: null, error: null }),
      }),
    },
  };
});
