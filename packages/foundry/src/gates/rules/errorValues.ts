import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
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
    "use the owning module's guard (`isHarnessError`), `Predicate.isTagged(e, \"X\")`, `Match.tag` or `Effect.catchTag`; not `Schema.is(X)` of the class, which checks identity too",
  check: ({ sourceFile, checker }) =>
    matchesIn(sourceFile, (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      isTaggedClass(checker, node.right)
        ? [{ node, message: `\`instanceof ${node.right.getText(sourceFile)}\` checks identity; a decoded or second-copy error fails it` }]
        : [],
    ),
}

/** A failure value, as far as its type tells: `unknown`/`any` (a caught
 *  value), an `Error`, a tagged error or a `Cause`. */
const isFailureValue = (checker: ts.TypeChecker, expression: ts.Expression): boolean => {
  const type = checker.getTypeAtLocation(expression)
  const failureLike = (part: ts.Type): boolean =>
    (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
    (part.flags & ts.TypeFlags.Object) !== 0 &&
      ["message", "_tag", "reasons"].some((name) => part.getProperty(name) !== undefined)
  return type.isUnion() ? type.types.some(failureLike) : failureLike(type)
}

/** The ways a failure becomes text: `String(e)`, `${e}`, `"…" + e`. */
const stringified = (sourceFile: ts.SourceFile, checker: ts.TypeChecker, node: ts.Node): ReadonlyArray<RuleMatch> => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "String") {
    const [argument] = node.arguments
    return argument !== undefined && isFailureValue(checker, argument)
      ? [{ node, message: `\`String(${argument.getText(sourceFile)})\` keeps only the text of the failure it wraps` }]
      : []
  }
  if (ts.isTemplateSpan(node) && isFailureValue(checker, node.expression)) {
    return [{ node: node.expression, message: `\`\${${node.expression.getText(sourceFile)}}\` keeps only the text of the failure it wraps` }]
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [node.left, node.right].some(
      (side) => !ts.isStringLiteralLike(side) && !ts.isTemplateExpression(side) && isFailureValue(checker, side),
    )
      ? [{ node, message: "a failure concatenated into a string keeps only its text" }]
      : []
  }
  return []
}

/** Every stringified failure under `node`, without entering nested functions. */
const stringifiedUnder = (sourceFile: ts.SourceFile, checker: ts.TypeChecker, node: ts.Node): ReadonlyArray<RuleMatch> => {
  if (ts.isFunctionLike(node)) return []
  const nested: Array<RuleMatch> = []
  ts.forEachChild(node, (child) => {
    nested.push(...stringifiedUnder(sourceFile, checker, child))
  })
  return [...stringified(sourceFile, checker, node), ...nested]
}

/** A tagged error built from `String(e)` loses what it wraps: the inner
 *  error's tag and fields, its own cause, the stack an operator needs. The
 *  error keeps the failure as a value; its message says what failed. */
export const noStringifiedCause: IdiomRule = {
  id: RuleId.make("effect/no-stringified-cause"),
  defaultSeverity: "error",
  description: "a tagged error keeps the failure it wraps as a value, not as `String(e)`",
  fixHint:
    "keep the failure as a value (a `cause` field, `Schema.Defect`) and write a message that says what failed; text for a person or the model comes from `reasonOf(cause)` or a decoded error's own `message`",
  check: ({ sourceFile, checker }) =>
    matchesIn(sourceFile, (node) =>
      ts.isNewExpression(node) && isTaggedClass(checker, node.expression)
        ? (node.arguments ?? []).flatMap((argument) => stringifiedUnder(sourceFile, checker, argument))
        : [],
    ),
}

const isEquality = (kind: ts.SyntaxKind): boolean =>
  kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
  kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
  kind === ts.SyntaxKind.EqualsEqualsToken ||
  kind === ts.SyntaxKind.ExclamationEqualsToken

const isCodeAccess = (node: ts.Expression): node is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(node) && node.name.text === "code"

/** The files that declare `access`'s `code` field, when they are this
 *  project's own source: a foreign code (Node's `ENOENT`, a narrowed
 *  `unknown`) has no owner here. */
const ownersOf = (checker: ts.TypeChecker, access: ts.PropertyAccessExpression): ReadonlyArray<string> => {
  const files = (checker.getSymbolAtLocation(access.name)?.declarations ?? []).map(
    (declaration) => declaration.getSourceFile().fileName,
  )
  return files.some((file) => file.endsWith(".d.ts") || /[\\/]node_modules[\\/]/.test(file)) ? [] : files
}

/** A code is the owning module's vocabulary: the file that declares the
 *  error, and its `.functions.ts` companion, may compare it. Everywhere
 *  else a renamed or retired code would compare false in silence. */
export const noErrorCodeCompare: IdiomRule = {
  id: RuleId.make("effect/no-error-code-compare"),
  defaultSeverity: "error",
  description: "an error code is compared only in the module that declares the error",
  fixHint:
    "ask the owning module: a guard it exports (`isTurnClosed(error)`), or a tagged error for that case handled with `Effect.catchTag`/`Match.tag`",
  check: ({ sourceFile, checker }) =>
    matchesIn(sourceFile, (node) => {
      if (!ts.isBinaryExpression(node) || !isEquality(node.operatorToken.kind)) return []
      const access = isCodeAccess(node.left) && ts.isStringLiteralLike(node.right)
        ? node.left
        : isCodeAccess(node.right) && ts.isStringLiteralLike(node.left)
          ? node.right
          : undefined
      if (access === undefined) return []
      const owners = ownersOf(checker, access)
      const here = sourceFile.fileName
      return owners.length === 0 || owners.some((owner) => here === owner || here === owner.replace(/\.ts$/, ".functions.ts"))
        ? []
        : [{ node, message: `\`${node.getText(sourceFile)}\` compares a code another module declares` }]
    }),
}
