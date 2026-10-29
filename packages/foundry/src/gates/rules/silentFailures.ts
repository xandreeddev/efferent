import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
import { isMemberOf, matchesIn } from "./syntax.js"

const unparenthesized = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unparenthesized(node.expression) : node

/** `Effect.log`, `Effect.logWarning`…, called or passed as a value, anywhere under `node`. */
const logs = (node: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Effect" &&
    /^log(?:[A-Z]\w*)?$/.test(node.name.text)) ||
  (ts.forEachChild(node, (child) => (logs(child) ? true : undefined)) ?? false)

/** A step that sees the failure before it is dropped and logs it:
 *  `Effect.tapError(…)`, `Effect.tapCause(…)`, `Effect.onError(…)`… */
const isLoggingTap = (step: ts.Expression): boolean =>
  ts.isCallExpression(step) &&
  ts.isPropertyAccessExpression(step.expression) &&
  ts.isIdentifier(step.expression.expression) &&
  step.expression.expression.text === "Effect" &&
  /^(?:tap(?:Error|Cause|Defect)\w*|onError\w*|onExit)$/.test(step.expression.name.text) &&
  logs(step)

const isPipe = (call: ts.CallExpression): boolean =>
  (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "pipe") ||
  (ts.isIdentifier(call.expression) && call.expression.text === "pipe")

/** Whether the failure `step` drops was logged first: an earlier step of
 *  the same `pipe`, or (data-first) a `pipe` on the effect it is given. */
const loggedBefore = (step: ts.Expression): boolean => {
  const parent = step.parent
  if (ts.isCallExpression(parent) && isPipe(parent)) {
    const index = parent.arguments.findIndex((argument) => argument === step)
    return parent.arguments.slice(0, Math.max(index, 0)).some(isLoggingTap)
  }
  const subject = ts.isCallExpression(step) ? step.arguments[0] : undefined
  return subject !== undefined && ts.isCallExpression(subject) && isPipe(subject) && subject.arguments.some(isLoggingTap)
}

/** The step `access` stands for: the call when it is called, else the bare reference. */
const stepOf = (access: ts.PropertyAccessExpression): ts.Expression =>
  ts.isCallExpression(access.parent) && access.parent.expression === access ? access.parent : access

/** `{ log: "Warn" }`, `{ log: true }`: an options object that turns logging on. */
const statesLog = (checker: ts.TypeChecker, argument: ts.Expression): boolean => {
  const options = unparenthesized(argument)
  if (ts.isObjectLiteralExpression(options) && !options.properties.some(ts.isSpreadAssignment)) {
    return options.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "log" &&
        property.initializer.kind !== ts.SyntaxKind.FalseKeyword &&
        !(ts.isIdentifier(property.initializer) && property.initializer.text === "undefined"),
    )
  }
  return !ts.isObjectLiteralExpression(options) && checker.getTypeAtLocation(options).getProperty("log") !== undefined
}

/** `() => Effect.void`, whatever its parameters, or a block that only returns it. */
const answersVoid = (handler: ts.Expression | undefined): boolean => {
  if (handler === undefined) return false
  const fn = unparenthesized(handler)
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  const only = ts.isBlock(fn.body) ? fn.body.statements[0] : undefined
  const returned = ts.isBlock(fn.body)
    ? fn.body.statements.length === 1 && only !== undefined && ts.isReturnStatement(only) ? only.expression : undefined
    : fn.body
  return returned !== undefined && isMemberOf(unparenthesized(returned), "Effect", ["void"])
}

const silentMatch = (checker: ts.TypeChecker, node: ts.Node): ReadonlyArray<RuleMatch> => {
  if (!isMemberOf(node, "Effect", ["ignore", "ignoreCause", "catch", "catchCause", "orElseSucceed"])) return []
  const member = node.name.text
  const step = stepOf(node)
  const args = ts.isCallExpression(step) ? step.arguments : []
  if (member === "ignore" || member === "ignoreCause") {
    return args.some((argument) => statesLog(checker, argument)) || loggedBefore(step)
      ? []
      : [{ node, message: `\`Effect.${member}\` drops the failure without logging it` }]
  }
  if (member === "catch" || member === "catchCause") {
    // Data-last `catch(handler)`, data-first `catch(effect, handler)`.
    return answersVoid(args[args.length - 1]) && !loggedBefore(step)
      ? [{ node, message: `\`Effect.${member}(() => Effect.void)\` drops the failure without logging it` }]
      : []
  }
  return loggedBefore(step) ? [] : [{ node, message: "`Effect.orElseSucceed` replaces the failure without logging it" }]
}

/** A dropped failure leaves no trace: a lost write, a closed transport or a
 *  failed probe looks exactly like success. Whatever is dropped is logged,
 *  at `Debug` for an expected miss and `Warning` for lost work. */
export const noSilentIgnore: IdiomRule = {
  id: RuleId.make("effect/no-silent-ignore"),
  defaultSeverity: "error",
  description: "a failure that is dropped is logged first",
  fixHint:
    "log what is dropped: `Effect.ignore({ log: \"Warn\", message: \"what was lost\" })` (`ignoreCause` likewise; `\"Debug\"` for an expected miss), or an `Effect.tapError`/`Effect.tapCause` step that calls `Effect.log*` earlier in the same pipe; or recover only the expected failure with `Effect.catchTag`/`Effect.catchIf`",
  check: ({ sourceFile, checker }) => matchesIn(sourceFile, (node) => silentMatch(checker, node)),
}
