import type { Metadata } from "next";
import { CartPageClient } from "./cart-client";

export const metadata: Metadata = {
  title: "Your Cart",
  description: "Review the research compounds in your Vanta Labs cart before checkout.",
};

export default function Page() {
  return <CartPageClient />;
}
