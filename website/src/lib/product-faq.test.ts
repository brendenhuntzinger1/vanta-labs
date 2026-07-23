import { describe, expect, it } from "vitest";
import { parseProductFaq } from "@/lib/product-faq";

describe("parseProductFaq", () => {
  it("keeps well-formed items", () => {
    const input = [
      { question: "Q1", answer: "A1" },
      { question: "Q2", answer: "A2" },
    ];
    expect(parseProductFaq(input)).toEqual(input);
  });

  it("parses a JSON string", () => {
    expect(parseProductFaq('[{"question":"Q","answer":"A"}]')).toEqual([{ question: "Q", answer: "A" }]);
  });

  it("trims whitespace and drops rows missing a question or answer", () => {
    const input = [
      { question: "  Q1  ", answer: "  A1  " },
      { question: "", answer: "A2" },
      { question: "Q3", answer: "" },
      { question: "Q4" },
    ];
    expect(parseProductFaq(input)).toEqual([{ question: "Q1", answer: "A1" }]);
  });

  it("returns an empty array for null, non-arrays, and malformed JSON", () => {
    expect(parseProductFaq(null)).toEqual([]);
    expect(parseProductFaq(undefined)).toEqual([]);
    expect(parseProductFaq("")).toEqual([]);
    expect(parseProductFaq("not json")).toEqual([]);
    expect(parseProductFaq({ question: "Q", answer: "A" })).toEqual([]);
    expect(parseProductFaq(42)).toEqual([]);
  });

  it("ignores non-object entries inside the array", () => {
    expect(parseProductFaq(["x", 1, null, { question: "Q", answer: "A" }])).toEqual([
      { question: "Q", answer: "A" },
    ]);
  });
});
