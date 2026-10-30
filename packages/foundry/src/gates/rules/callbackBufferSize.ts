import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule } from "../idiomGate.js"
import { isMemberOf, matchesIn } from "./syntax.js"

/** Whether the options argument of `Stream.callback` names a `bufferSize`. */
const namesBufferSize = (checker: ts.TypeChecker, options: ts.Expression): boolean =>
  ts.isObjectLiteralExpression(options) && !options.properties.some(ts.isSpreadAssignment)
    ? options.properties.some((property) => property.name !== undefined && ts.isIdentifier(property.name) && property.name.text === "bufferSize")
    : checker.getTypeAtLocation(options).getProperty("bufferSize") !== undefined

/** `Stream.callback` buffers without bound by default: a producer faster
 *  than its reader grows memory until the process dies. */
export const callbackBufferSize: IdiomRule = {
  id: RuleId.make("effect/callback-buffer-size"),
  defaultSeverity: "error",
  description: "`Stream.callback` states its `bufferSize`",
  fixHint:
    "pass `{ bufferSize }` (and a `strategy` if dropping is acceptable) as the second argument, so a slow reader holds the producer back",
  check: ({ sourceFile, checker }) =>
    matchesIn(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !isMemberOf(node.expression, "Stream", ["callback"])) return []
      const options = node.arguments[1]
      return options !== undefined && namesBufferSize(checker, options)
        ? []
        : [{ node, message: "`Stream.callback` without a `bufferSize` buffers without bound" }]
    }),
}

/** Whether a capacity argument is a literal infinity (`Infinity`, `Number.POSITIVE_INFINITY`), directly or as `{ capacity }`. */
const isInfiniteCapacity = (capacity: ts.Expression): boolean =>
  ts.isObjectLiteralExpression(capacity)
    ? capacity.properties.some((property) =>
        ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "capacity" && isInfiniteCapacity(property.initializer))
    : (ts.isIdentifier(capacity) && capacity.text === "Infinity") || isMemberOf(capacity, "Number", ["POSITIVE_INFINITY"])

/** A `PubSub` without a bound keeps every message a slow subscriber has not
 *  taken: one subscriber that stops reading grows memory until the process dies. */
export const boundedPubSub: IdiomRule = {
  id: RuleId.make("effect/bounded-pubsub"),
  defaultSeverity: "error",
  description: "a `PubSub` states a finite capacity: `bounded`, `sliding` or `dropping`, never `unbounded`",
  fixHint:
    "create it with a capacity: `PubSub.sliding(n)` when only the latest messages matter (a wake-up signal: `sliding(1)`), `PubSub.bounded(n)` when the publisher may wait for the slowest subscriber, `PubSub.dropping(n)` when the newest may be lost",
  check: ({ sourceFile }) =>
    matchesIn(sourceFile, (node) => {
      if (isMemberOf(node, "PubSub", ["unbounded"])) {
        return [{ node, message: "`PubSub.unbounded` keeps every message a slow subscriber has not taken" }]
      }
      if (!ts.isCallExpression(node) || !isMemberOf(node.expression, "PubSub", ["bounded", "sliding", "dropping"])) return []
      const capacity = node.arguments[0]
      return capacity !== undefined && isInfiniteCapacity(capacity)
        ? [{ node, message: `\`PubSub.${node.expression.name.text}\` with an infinite capacity keeps every message a slow subscriber has not taken` }]
        : []
    }),
}
