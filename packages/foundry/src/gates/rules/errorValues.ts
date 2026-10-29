import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule } from "../idiomGate.js"
import { isMemberOf, matchesIn } from "./syntax.js"

/** `Effect.log`, `Effect.logError`, `Effect.logWarning`… */
const isEffectLog = (callee: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(callee) &&
  ts.isIdentifier(callee.expression) &&
  callee.expression.text === "Effect" &&
  /^log(?:[A-Z]\w*)?$/.test(callee.name.text)

/** Whether `node` is (part of) an argument of an `Effect.log*` call, within one expression. */
const inLogArgument = (node: ts.Node): boolean => {
  const parent = node.parent
  if (ts.isCallExpression(parent) && parent.arguments.some((argument) => argument === node)) {
    return isEffectLog(parent.expression) || inLogArgument(parent)
  }
  return !ts.isFunctionLike(parent) && (ts.isExpression(parent) || ts.isTemplateSpan(parent)) ? inLogArgument(parent) : false
}

/** `Cause.pretty` renders stack frames and file paths: right for an
 *  operator's log, wrong in anything a user, a model or a store keeps. */
export const noCausePrettyData: IdiomRule = {
  id: RuleId.make("effect/no-cause-pretty-data"),
  defaultSeverity: "error",
  description: "`Cause.pretty` text goes to `Effect.log*` only, never into data",
  fixHint:
    "log the cause (`Effect.logError(\"…\", cause)`, or `Cause.pretty` inside the `Effect.log*` call); data keeps `Cause.prettyErrors(cause)` messages or a reason string",
  check: ({ sourceFile }) =>
    matchesIn(sourceFile, (node) =>
      isMemberOf(node, "Cause", ["pretty"]) && !inLogArgument(node)
        ? [{ node, message: "`Cause.pretty` text (stack frames, file paths) kept as data" }]
        : [],
    ),
}

/** A class whose instances carry a `_tag`: a tagged error or tagged class. */
const isTaggedClass = (checker: ts.TypeChecker, expression: ts.Expression): boolean =>
  checker
    .getTypeAtLocation(expression)
    .getConstructSignatures()
    .some((signature) => signature.getReturnType().getProperty("_tag") !== undefined)

/** `instanceof` on a tagged error is identity, not shape: a second copy of
 *  the package, or an error decoded from the wire, fails it. The tag is
 *  what the error is. Plain `instanceof Error` stays fine. */
export const noInstanceofTaggedError: IdiomRule = {
  id: RuleId.make("effect/no-instanceof-tagged-error"),
  defaultSeverity: "error",
  description: "tagged errors are recognized by their tag, never `instanceof`",
  fixHint:
    "use `Schema.is(X)`, the owning module's guard (`isHarnessError`), `Predicate.isTagged(e, \"X\")`, `Match.tag` or `Effect.catchTag`",
  check: ({ sourceFile, checker }) =>
    matchesIn(sourceFile, (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      isTaggedClass(checker, node.right)
        ? [{ node, message: `\`instanceof ${node.right.getText(sourceFile)}\` checks identity; a decoded or second-copy error fails it` }]
        : [],
    ),
}
