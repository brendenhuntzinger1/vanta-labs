import { createClient } from "@supabase/supabase-js";

function createBrowserClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing Supabase environment variables.");
  }

  return createClient(supabaseUrl, supabaseKey);
}

let cachedClient: ReturnType<typeof createBrowserClient> | null = null;

function getBrowserClient() {
  if (!cachedClient) {
    cachedClient = createBrowserClient();
  }
  return cachedClient;
}

export const supabase = new Proxy({} as ReturnType<typeof createBrowserClient>, {
  get(_target, property, receiver) {
    return Reflect.get(getBrowserClient(), property, receiver);
  },
});