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
