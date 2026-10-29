import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
import { isMemberOf, matchesIn } from "./syntax.js"

const namesConcurrency = (checker: ts.TypeChecker, options: ts.Expression): boolean =>
  ts.isObjectLiteralExpression(options) && !options.properties.some(ts.isSpreadAssignment)
    ? options.properties.some((property) => property.name !== undefined && ts.isIdentifier(property.name) && property.name.text === "concurrency")
    : checker.getTypeAtLocation(options).getProperty("concurrency") !== undefined

/** A literal collection of at most one effect: nothing to run side by side. */
const atMostOne = (collection: ts.Expression | undefined): boolean =>
  collection !== undefined &&
  ((ts.isArrayLiteralExpression(collection) && collection.elements.length <= 1 && !collection.elements.some(ts.isSpreadElement)) ||
    (ts.isObjectLiteralExpression(collection) && collection.properties.length <= 1 && !collection.properties.some(ts.isSpreadAssignment)))

/** `Effect.forEach(items, f, options?)` or, data-last, `Effect.forEach(f, options?)`. */
const forEachParts = (checker: ts.TypeChecker, call: ts.CallExpression): { readonly items: ts.Expression | undefined; readonly options: ts.Expression | undefined } => {
  const [first, second, third] = call.arguments
  const dataLast = first !== undefined && checker.getTypeAtLocation(first).getCallSignatures().length > 0
  return dataLast ? { items: undefined, options: second } : { items: first, options: third }
}

const concurrencyMatch = (checker: ts.TypeChecker, node: ts.Node): ReadonlyArray<RuleMatch> => {
  if (!ts.isCallExpression(node) || !isMemberOf(node.expression, "Effect", ["forEach", "all"])) return []
  const { items, options } = node.expression.name.text === "forEach"
    ? forEachParts(checker, node)
    : { items: node.arguments[0], options: node.arguments[1] }
  return atMostOne(items) || (options !== undefined && namesConcurrency(checker, options))
    ? []
    : [{ node, message: `\`Effect.${node.expression.name.text}\` does not state its \`concurrency\`` }]
}

/** `Effect.forEach` and `Effect.all` run one effect at a time unless told
 *  otherwise: over I/O that is either a hidden serialization or, once
 *  someone adds `"unbounded"`, an unbounded fan-out. The call says which. */
export const requireConcurrencyOption: IdiomRule = {
  id: RuleId.make("effect/require-concurrency-option"),
  defaultSeverity: "error",
  description: "`Effect.forEach` and `Effect.all` state their `concurrency`",
  fixHint:
    "pass `{ concurrency }`: `1` when the effects must run in order, a number or a config value (`digestConcurrency`) for I/O, `\"unbounded\"` only over a small fixed set",
  check: ({ sourceFile, checker }) => matchesIn(sourceFile, (node) => concurrencyMatch(checker, node)),
}
