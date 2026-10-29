import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule } from "../idiomGate.js"
import { isMethodCall, matchesIn } from "./syntax.js"

/** `localeCompare` orders by the host's locale and ICU data, so the same
 *  input sorts differently on another machine. */
export const noLocaleCompare: IdiomRule = {
  id: RuleId.make("effect/no-locale-compare"),
  defaultSeverity: "error",
  description: "strings are ordered with `Order.String`, never the host's locale",
  fixHint: "compare with `Order.String` (code-unit order, the same on every host), e.g. `Arr.sort(xs, Order.String)`",
  check: ({ sourceFile }) =>
    matchesIn(sourceFile, (node) =>
      ts.isPropertyAccessExpression(node) && node.name.text === "localeCompare"
        ? [{ node, message: "`localeCompare` depends on the host's locale" }]
        : [],
    ),
}

/** A bare `.sort()` compares the elements' STRING forms: numbers sort as
 *  text (10 before 9), and the reader cannot tell whether that was meant. */
export const requireSortComparator: IdiomRule = {
  id: RuleId.make("effect/require-sort-comparator"),
  defaultSeverity: "error",
  description: "every sort names its order",
  fixHint: "pass the order: `Arr.sort(xs, Order.String)` / `Order.Number`, or a comparator `(a, b) => …`",
  check: ({ sourceFile }) =>
    matchesIn(sourceFile, (node) =>
      isMethodCall(node, ["sort", "toSorted"]) && node.arguments.length === 0
        ? [{ node, message: "`.sort()` without a comparator orders elements as strings" }]
        : [],
    ),
}
