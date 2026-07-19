import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

const CONTROL_ACTION = "admin_control_upsert";

type ControlRow = {
  id: string;
  target_table: string | null;
  target_id: string | null;
  metadata: { value?: unknown } | null;
  created_at: string;
};

export type HomepageControlConfig = {
  promoTickerItems?: string[];
  heroKicker?: string;
  heroHeadline?: string;
  heroSubheadline?: string;
  promoPills?: string[];
  promoCaption?: string;
  featuredProductSlugs?: string[];
  qualityPanelTitle?: string;
  qualityPanelItems?: string[];
};

function sanitizeSection(section: string) {
  return section.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function sanitizeKey(key: string) {
  return key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

export async function getControlSnapshot(section?: string) {
  const normalizedSection = section ? sanitizeSection(section) : null;

  let query = supabaseAdmin
    .from("admin_audit_logs")
    .select("id, target_table, target_id, metadata, created_at")
    .eq("action", CONTROL_ACTION)
    .order("created_at", { ascending: false })
    .limit(1500);

  if (normalizedSection) {
    query = query.eq("target_table", normalizedSection);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  const rows = (data ?? []) as ControlRow[];
  const result: Record<string, Record<string, unknown>> = {};

  for (const row of rows) {
    const table = sanitizeSection(String(row.target_table ?? ""));
    const key = sanitizeKey(String(row.target_id ?? ""));
    if (!table || !key) {
      continue;
    }

    result[table] ??= {};
    if (!(key in result[table])) {
      result[table][key] = row.metadata?.value ?? null;
    }
  }

  return result;
}

export async function upsertControlValue(input: { section: string; key: string; value: unknown; actorUserId?: string | null }) {
  const section = sanitizeSection(input.section);
  const key = sanitizeKey(input.key);
  if (!section || !key) {
    throw new Error("Section and key are required");
  }

  const { error } = await supabaseAdmin
    .from("admin_audit_logs")
    .insert({
      actor_user_id: input.actorUserId ?? null,
      action: CONTROL_ACTION,
      target_table: section,
      target_id: key,
      metadata: { value: input.value },
      created_at: new Date().toISOString(),
    });

  if (error) {
    throw error;
  }
}

export async function getHomepageControlConfig(): Promise<HomepageControlConfig> {
  try {
    const snapshot = await getControlSnapshot("homepage");
    const homepage = snapshot.homepage ?? {};
    return {
      promoTickerItems: Array.isArray(homepage.promo_ticker_items) ? homepage.promo_ticker_items as string[] : undefined,
      heroKicker: typeof homepage.hero_kicker === "string" ? homepage.hero_kicker : undefined,
      heroHeadline: typeof homepage.hero_headline === "string" ? homepage.hero_headline : undefined,
      heroSubheadline: typeof homepage.hero_subheadline === "string" ? homepage.hero_subheadline : undefined,
      promoPills: Array.isArray(homepage.promo_pills) ? homepage.promo_pills as string[] : undefined,
      promoCaption: typeof homepage.promo_caption === "string" ? homepage.promo_caption : undefined,
      featuredProductSlugs: Array.isArray(homepage.featured_product_slugs) ? homepage.featured_product_slugs as string[] : undefined,
      qualityPanelTitle: typeof homepage.quality_panel_title === "string" ? homepage.quality_panel_title : undefined,
      qualityPanelItems: Array.isArray(homepage.quality_panel_items) ? homepage.quality_panel_items as string[] : undefined,
    };
  } catch {
    return {};
  }
}