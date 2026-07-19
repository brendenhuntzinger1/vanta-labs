import { NextResponse } from "next/server";
import { getCatalogProducts } from "@/lib/catalog";

export async function GET() {
  try {
    const products = await getCatalogProducts();
    return NextResponse.json({ success: true, products });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load products";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
