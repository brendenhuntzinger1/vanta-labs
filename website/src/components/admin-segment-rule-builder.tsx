"use client";

import { useMemo } from "react";
import {
  FIELD_DEFS,
  describeSegmentRule,
  parseSegmentRule,
  OPERATOR_LABELS,
  type FieldDef,
  type FilterOperator,
  type SegmentFilter,
  type SegmentRule,
} from "@/lib/email/segment-rules";

/**
 * THE AUDIENCE RULE BUILDER.
 *
 * The nine presets answer nine questions in one click. This answers the rest,
 * and it is deliberately the last option in the list rather than the first.
 *
 * TWO LEVELS, NOT THREE. The engine supports groups of conditions of filters,
 * but a three-level nested UI is where every rule builder becomes unusable —
 * nobody can hold "or within an and within an or" in their head while also
 * thinking about who they are mailing. So one row is one condition: rows in a
 * block are ANDed, blocks are ORed. That covers essentially every real audience
 * and reads as a sentence, which is what the plain-English line underneath
 * checks.
 *
 * THE OPERATOR SEES THE RULE IN ENGLISH, ALWAYS. describeSegmentRule renders
 * the same structure the sender will evaluate, so what is on screen and what
 * ships are the same object. A builder that shows a rule it does not send is
 * worse than no builder.
 *
 * IT STORES JSON IN segment_param. That column is already free text by design;
 * the parent keeps it in form state and the live recipient count re-fetches on
 * every change, so the operator sees the audience shrink as they add
 * conditions.
 */

const MAX_BLOCKS = 5;
const MAX_ROWS_PER_BLOCK = 6;

function defFor(field: string): FieldDef {
  return FIELD_DEFS.find((def) => def.field === field) ?? FIELD_DEFS[0];
}

/** A blank row for a field, with an operator that field can actually answer. */
function blankFilter(field: string = FIELD_DEFS[0].field): SegmentFilter {
  const def = defFor(field);
  return { field: def.field, operator: def.operators[0], value: def.kind === "money" ? 0 : "" };
}

const selectClass =
  "rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-white focus:border-white/25 focus:outline-none";
const inputClass =
  "rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-white placeholder:text-zinc-600 focus:border-white/25 focus:outline-none";

export function SegmentRuleBuilder({
  value,
  onChange,
  categories,
}: {
  /** The JSON currently in segment_param. Empty string means "not built yet". */
  value: string;
  onChange: (json: string) => void;
  categories: string[];
}) {
  // The stored JSON is the source of truth, not a parallel React state: a
  // builder that keeps its own copy is a builder that can show one rule and
  // send another.
  const rule = useMemo<SegmentRule>(() => {
    const parsed = parseSegmentRule(value);
    return parsed ?? { groups: [{ conditions: [{ junction: "and", filters: [blankFilter()] }] }] };
  }, [value]);

  const description = useMemo(() => describeSegmentRule(parseSegmentRule(value)), [value]);
  const usable = parseSegmentRule(value) !== null;

  function commit(next: SegmentRule) {
    onChange(JSON.stringify(next));
  }

  function updateFilter(groupIndex: number, rowIndex: number, patch: Partial<SegmentFilter>) {
    const next: SegmentRule = { groups: rule.groups.map((group, gi) => ({
      conditions: group.conditions.map((condition, ci) =>
        gi === groupIndex && ci === rowIndex
          ? { ...condition, filters: [{ ...condition.filters[0], ...patch }] }
          : condition),
    })) };
    commit(next);
  }

  function changeField(groupIndex: number, rowIndex: number, field: string) {
    // Changing the field resets the operator and value: keeping "is more than"
    // after switching to an email address would leave a rule that parses and
    // matches nobody.
    updateFilter(groupIndex, rowIndex, blankFilter(field));
  }

  function addRow(groupIndex: number) {
    const next: SegmentRule = { groups: rule.groups.map((group, gi) =>
      gi === groupIndex && group.conditions.length < MAX_ROWS_PER_BLOCK
        ? { conditions: [...group.conditions, { junction: "and" as const, filters: [blankFilter()] }] }
        : group) };
    commit(next);
  }

  function removeRow(groupIndex: number, rowIndex: number) {
    const next: SegmentRule = { groups: rule.groups
      .map((group, gi) => gi === groupIndex
        ? { conditions: group.conditions.filter((_, ci) => ci !== rowIndex) }
        : group)
      // A block with no rows is not a block that matches everyone — it is a
      // block that should not exist. Dropping it here keeps the stored rule
      // parseable, which is what stops an empty block reaching the sender.
      .filter((group) => group.conditions.length > 0) };
    commit(next.groups.length > 0 ? next : { groups: [{ conditions: [{ junction: "and", filters: [blankFilter()] }] }] });
  }

  function addBlock() {
    if (rule.groups.length >= MAX_BLOCKS) return;
    commit({ groups: [...rule.groups, { conditions: [{ junction: "and", filters: [blankFilter()] }] }] });
  }

  return (
    <div className="space-y-3">
      {rule.groups.map((group, groupIndex) => (
        <div key={groupIndex} className="space-y-2">
          {groupIndex > 0 ? (
            <div className="flex items-center gap-2">
              <span className="h-px flex-1 bg-white/10" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">or</span>
              <span className="h-px flex-1 bg-white/10" />
            </div>
          ) : null}

          <div className="rounded-xl border border-white/10 bg-black/20 p-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
              Match all of these
            </p>

            <div className="space-y-2">
              {group.conditions.map((condition, rowIndex) => {
                const filter = condition.filters[0] ?? blankFilter();
                const def = defFor(filter.field);
                const choices = def.field === "category" ? categories : def.choices ?? [];
                const needsValue = filter.operator !== "exists" && filter.operator !== "doesNotExist";

                return (
                  <div key={rowIndex} className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="Field"
                      className={selectClass}
                      value={filter.field}
                      onChange={(event) => changeField(groupIndex, rowIndex, event.target.value)}
                    >
                      {FIELD_DEFS.map((option) => (
                        <option key={option.field} value={option.field} className="bg-zinc-900">
                          {option.label}
                        </option>
                      ))}
                    </select>

                    <select
                      aria-label="Operator"
                      className={selectClass}
                      value={filter.operator}
                      onChange={(event) => updateFilter(groupIndex, rowIndex, {
                        operator: event.target.value as FilterOperator,
                      })}
                    >
                      {def.operators.map((operator) => (
                        <option key={operator} value={operator} className="bg-zinc-900">
                          {/* The same map describeSegmentRule uses, so the dropdown
                              and the sentence underneath cannot drift apart. */}
                          {OPERATOR_LABELS[operator] ?? operator}
                        </option>
                      ))}
                    </select>

                    {needsValue && (def.kind === "choice" || def.kind === "multiChoice") ? (
                      <select
                        aria-label="Value"
                        className={selectClass}
                        value={(filter.values ?? [])[0] ?? ""}
                        onChange={(event) => updateFilter(groupIndex, rowIndex, {
                          values: event.target.value ? [event.target.value] : [],
                          value: undefined,
                        })}
                      >
                        <option value="" className="bg-zinc-900">Choose…</option>
                        {choices.map((choice) => (
                          <option key={choice} value={choice} className="bg-zinc-900">{choice}</option>
                        ))}
                      </select>
                    ) : null}

                    {needsValue && def.kind === "date" && (filter.operator === "inTheLast" || filter.operator === "notInTheLast") ? (
                      <>
                        <input
                          aria-label="Amount"
                          type="number"
                          min={1}
                          className={`${inputClass} w-20`}
                          value={typeof filter.value === "number" ? filter.value : ""}
                          onChange={(event) => updateFilter(groupIndex, rowIndex, { value: Number(event.target.value) })}
                        />
                        <select
                          aria-label="Unit"
                          className={selectClass}
                          value={filter.unit ?? "days"}
                          onChange={(event) => updateFilter(groupIndex, rowIndex, {
                            unit: event.target.value as SegmentFilter["unit"],
                          })}
                        >
                          {["days", "weeks", "months", "years"].map((unit) => (
                            <option key={unit} value={unit} className="bg-zinc-900">{unit}</option>
                          ))}
                        </select>
                      </>
                    ) : null}

                    {needsValue && def.kind === "date" && (filter.operator === "before" || filter.operator === "after") ? (
                      <input
                        aria-label="Date"
                        type="date"
                        className={inputClass}
                        value={typeof filter.value === "string" ? filter.value : ""}
                        onChange={(event) => updateFilter(groupIndex, rowIndex, { value: event.target.value })}
                      />
                    ) : null}

                    {needsValue && (def.kind === "number" || def.kind === "money") ? (
                      filter.operator === "between" ? (
                        <>
                          <input
                            aria-label="From"
                            type="number"
                            className={`${inputClass} w-24`}
                            value={def.kind === "money" ? (filter.valueFrom ?? 0) / 100 || "" : filter.valueFrom ?? ""}
                            onChange={(event) => updateFilter(groupIndex, rowIndex, {
                              valueFrom: def.kind === "money"
                                ? Math.round(Number(event.target.value) * 100)
                                : Number(event.target.value),
                            })}
                          />
                          <span className="text-xs text-zinc-500">and</span>
                          <input
                            aria-label="To"
                            type="number"
                            className={`${inputClass} w-24`}
                            value={def.kind === "money" ? (filter.valueTo ?? 0) / 100 || "" : filter.valueTo ?? ""}
                            onChange={(event) => updateFilter(groupIndex, rowIndex, {
                              valueTo: def.kind === "money"
                                ? Math.round(Number(event.target.value) * 100)
                                : Number(event.target.value),
                            })}
                          />
                        </>
                      ) : (
                        <div className="flex items-center gap-1">
                          {/* MONEY IS ASKED IN DOLLARS AND STORED IN CENTS. The engine
                              compares cents; an operator typing "200" meaning $200 into
                              a cents field builds a rule that is wrong by 100x and still
                              looks plausible. */}
                          {def.kind === "money" ? <span className="text-sm text-zinc-500">$</span> : null}
                          <input
                            aria-label="Value"
                            type="number"
                            className={`${inputClass} w-24`}
                            value={def.kind === "money"
                              ? (typeof filter.value === "number" ? filter.value / 100 : "")
                              : (typeof filter.value === "number" ? filter.value : "")}
                            onChange={(event) => updateFilter(groupIndex, rowIndex, {
                              value: def.kind === "money"
                                ? Math.round(Number(event.target.value) * 100)
                                : Number(event.target.value),
                            })}
                          />
                        </div>
                      )
                    ) : null}

                    {needsValue && def.kind === "text" ? (
                      <input
                        aria-label="Value"
                        type="text"
                        placeholder=".edu"
                        className={`${inputClass} w-36`}
                        value={typeof filter.value === "string" ? filter.value : ""}
                        onChange={(event) => updateFilter(groupIndex, rowIndex, { value: event.target.value })}
                      />
                    ) : null}

                    <button
                      type="button"
                      onClick={() => removeRow(groupIndex, rowIndex)}
                      className="ml-auto rounded-lg border border-white/10 px-2 py-1.5 text-xs text-zinc-400 hover:border-white/25 hover:text-white"
                      aria-label="Remove condition"
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>

            {group.conditions.length < MAX_ROWS_PER_BLOCK ? (
              <button
                type="button"
                onClick={() => addRow(groupIndex)}
                className="mt-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:border-white/25 hover:text-white"
              >
                + And…
              </button>
            ) : null}
          </div>
        </div>
      ))}

      {rule.groups.length < MAX_BLOCKS ? (
        <button
          type="button"
          onClick={addBlock}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:border-white/25 hover:text-white"
        >
          + Or a different kind of customer…
        </button>
      ) : null}

      {/* THE SENTENCE THE SENDER WILL ACTUALLY EVALUATE. Rendered from the same
          parsed rule, so there is no way for the screen and the send to differ. */}
      <div
        className={`rounded-xl border px-3 py-2 text-xs leading-relaxed ${
          usable ? "border-white/10 bg-black/20 text-zinc-300" : "border-amber-400/30 bg-amber-400/5 text-amber-200"
        }`}
      >
        <span className="font-semibold uppercase tracking-[0.14em] text-zinc-500">This audience: </span>
        {description}
      </div>
    </div>
  );
}
