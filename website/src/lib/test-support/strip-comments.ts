/**
 * Source code with its comments removed, for the suites that assert on file
 * TEXT rather than on behaviour.
 *
 * WHY THIS EXISTS AT ALL. Several guards here work by reading a component and
 * asserting a banned string is absent from it — that is how "no page re-declares
 * its own trust claims" is enforced. But this codebase explains a decision by
 * NAMING the thing it rejected, right where it used to be, so raw text cannot
 * tell a rendered claim from the note recording its removal. Scanning raw source
 * makes the honest record of a fix indistinguishable from the defect, which
 * means either the comment goes or the guard does.
 *
 * WHY IT IS A SCANNER AND NOT A REGEX. Two obvious one-liners were tried and
 * both silently deleted real code, which for a `not.toContain` assertion means
 * passing for the wrong reason — the exact failure these guards exist to catch:
 *
 *   blocks first, then whole-line `//`
 *     A `/*` inside a LINE comment opens a block that the regex closes at the
 *     next `*​/` hundreds of lines below, taking the code between with it. Not
 *     hypothetical: the note in app/layout.tsx contains the literal
 *     "/api/account/​*", and it swallowed the very line the suite checks.
 *
 *   whole-line `//` first, then blocks
 *     The line filter has to drop lines beginning with `*` to remove JSDoc
 *     interiors — and that includes the closing `*​/`. The opening `/**` then
 *     survives with no terminator, and the block regex again runs on until the
 *     next one. This gutted app/checkout/page.tsx.
 *
 * A single left-to-right pass has neither problem, because it knows which state
 * it is in: a `/*` inside a line comment is text, and a `*​/` is only a
 * terminator when a block is actually open.
 *
 * STRING LITERALS ARE TRACKED, because `"https://example.com"` is not a
 * comment and truncating the line at `//` would delete whatever followed it —
 * and this codebase is full of URLs. Quotes, apostrophes and template literals
 * are all handled, with backslash escapes.
 *
 * REGEX LITERALS ARE NOT. Distinguishing `/foo/` from division needs real
 * tokenizer context, and a regex containing `//` or an unpaired `/*` is rare
 * enough that the cost — one over-stripped file — is worth less than the
 * complexity. `assertNotGutted` below turns that into a loud failure rather
 * than a silent one.
 */
export function stripComments(source: string): string {
  let out = "";
  let index = 0;
  const length = source.length;

  while (index < length) {
    const character = source[index];
    const next = source[index + 1];

    // A quoted string: copy it verbatim, so a `//` or `/*` inside it is text.
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      out += character;
      index += 1;
      while (index < length) {
        if (source[index] === "\\") {
          out += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        out += source[index];
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (character === "/" && next === "/") {
      // Line comment: skip to the newline, which is KEPT so line-oriented
      // assertions and error messages still line up with the real file.
      while (index < length && source[index] !== "\n") index += 1;
      continue;
    }

    if (character === "/" && next === "*") {
      index += 2;
      while (index < length && !(source[index] === "*" && source[index + 1] === "/")) {
        // Newlines inside a block are preserved for the same reason.
        if (source[index] === "\n") out += "\n";
        index += 1;
      }
      index += 2;
      // A space, so `foo/*x*/bar` does not become the identifier `foobar`.
      out += " ";
      continue;
    }

    out += character;
    index += 1;
  }

  return out;
}

/**
 * Guard against the stripper eating the file.
 *
 * A gutted file makes every `not.toContain` assertion pass, so a broken
 * stripper does not fail loudly — it quietly disables every guard built on it.
 * Callers pass an anchor they know must survive.
 */
export function assertNotGutted(path: string, stripped: string, anchor = "export"): string {
  if (!stripped.includes(anchor)) {
    throw new Error(
      `stripComments removed too much of ${path}: the anchor ${JSON.stringify(anchor)} is gone. ` +
        "Every text assertion built on this would now pass against an empty file.",
    );
  }
  return stripped;
}
