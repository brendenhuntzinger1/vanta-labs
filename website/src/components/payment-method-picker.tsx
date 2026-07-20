"use client";

import { formatCartCurrency } from "@/components/cart-context";
import {
  calculateCardProcessingFee,
  cardProcessingFeeNotice,
  type CardProcessingFeeConfig,
  type PaymentMethodConfig,
} from "@/lib/payment-methods";

function MethodCard({
  method,
  selected,
  onSelect,
  trailing,
}: {
  method: PaymentMethodConfig;
  selected: boolean;
  onSelect: () => void;
  trailing?: React.ReactNode;
}) {
  const recommended = method.recommended;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`vl-focus-ring group relative flex w-full items-center gap-4 rounded-xl border p-4 text-left transition-all duration-300 ${
        selected
          ? recommended
            ? "border-[color:var(--accent-gold)] bg-[color:var(--accent-gold-soft)] shadow-[0_0_0_1px_var(--accent-gold)]"
            : "border-white/70 bg-white/[0.06]"
          : recommended
            ? "border-[color:var(--accent-gold-soft)] bg-white/[0.02] hover:border-[color:var(--accent-gold)] hover:bg-[color:var(--accent-gold-soft)]"
            : "border-white/12 bg-white/[0.02] hover:border-white/30"
      }`}
    >
      <span
        className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg text-xl ${
          selected ? "bg-white/10" : "bg-white/[0.04]"
        }`}
        aria-hidden
      >
        {method.icon}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-white sm:text-base">{method.label}</span>
          {method.badges.map((badge) => (
            <span
              key={badge}
              className="rounded-full border border-[color:var(--accent-gold-soft)] bg-[color:var(--accent-gold-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--accent-gold)]"
            >
              {badge}
            </span>
          ))}
        </span>
        {method.description ? (
          <span className="mt-1 block text-xs text-white/55">{method.description}</span>
        ) : null}
        {trailing}
      </span>

      <span
        className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border transition ${
          selected ? "border-white bg-white" : "border-white/30"
        }`}
        aria-hidden
      >
        {selected ? <span className="h-2 w-2 rounded-full bg-black" /> : null}
      </span>
    </button>
  );
}

export function PaymentMethodPicker({
  methods,
  cardFeeConfig,
  baseTotal,
  selectedMethodId,
  onSelect,
}: {
  methods: PaymentMethodConfig[];
  cardFeeConfig: CardProcessingFeeConfig | null;
  baseTotal: number;
  selectedMethodId: string;
  onSelect: (methodId: string) => void;
}) {
  const recommended = methods.filter((m) => m.recommended);
  const others = methods.filter((m) => !m.recommended);
  const feeConfig = cardFeeConfig;
  const cardFee = feeConfig ? calculateCardProcessingFee(baseTotal, feeConfig) : { amount: 0, percentage: 0 };

  return (
    <div role="radiogroup" aria-label="Payment method">
      {recommended.length > 0 ? (
        <>
          <div className="flex items-center justify-between">
            <p className="vl2-eyebrow">Recommended — No Processing Fee</p>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent-gold)]">Save on fees</span>
          </div>
          <div className="mt-3 grid gap-3">
            {recommended.map((method) => (
              <MethodCard
                key={method.id}
                method={method}
                selected={selectedMethodId === method.id}
                onSelect={() => onSelect(method.id)}
                trailing={
                  <span className="mt-1 block text-xs font-medium text-emerald-300">
                    ✅ No processing fee · You pay {formatCartCurrency(baseTotal)}
                  </span>
                }
              />
            ))}
          </div>
        </>
      ) : null}

      {others.length > 0 ? (
        <>
          <p className="vl2-eyebrow mt-6">Other Payment Methods</p>
          <div className="mt-3 grid gap-3">
            {others.map((method) => {
              const isCard = method.kind === "card";
              const showsFee = isCard && cardFee.amount > 0;
              return (
                <MethodCard
                  key={method.id}
                  method={method}
                  selected={selectedMethodId === method.id}
                  onSelect={() => onSelect(method.id)}
                  trailing={
                    showsFee ? (
                      <span className="mt-1 block text-xs text-white/55">
                        {cardFee.percentage}% processing fee (+{formatCartCurrency(cardFee.amount)}) · Total {formatCartCurrency(baseTotal + cardFee.amount)}
                      </span>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
          {feeConfig && feeConfig.enabled && feeConfig.percentage > 0 ? (
            <p className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs leading-5 text-white/50">
              {cardProcessingFeeNotice(feeConfig)}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
