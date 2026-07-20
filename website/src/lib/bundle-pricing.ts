// Quantity-based "Bundle & Save" pricing. This is the single source of
// truth for the discount math - imported by both the client cart
// (cart-context.tsx, product-detail-client.tsx) and the server checkout
// (payment-service.ts) so the total a shopper sees is always exactly what
// the server charges. Never duplicate this formula elsewhere.
export function bundleDiscountRate(quantity: number): number {
  if (quantity >= 3) return 0.08;
  if (quantity === 2) return 0.05;
  return 0;
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function getBundleDiscountedUnitPrice(unitPrice: number, quantity: number): number {
  return roundMoney(unitPrice * (1 - bundleDiscountRate(quantity)));
}

export function getBundleDiscountedLineTotal(unitPrice: number, quantity: number): number {
  return roundMoney(getBundleDiscountedUnitPrice(unitPrice, quantity) * quantity);
}
