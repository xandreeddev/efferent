import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
import { isMemberOf, matchesIn } from "./syntax.js"

const unparenthesized = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unparenthesized(node.expression) : node

type FunctionBody = ts.ConciseBody | undefined

/** `Effect.gen(…)` as the whole body: an expression body, or a block whose
 *  one statement returns it. */
const onlyReturnsGen = (body: FunctionBody): boolean => {
  if (body === undefined) return false
  const only = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : undefined
  const returned = ts.isBlock(body)
    ? only !== undefined && ts.isReturnStatement(only) ? only.expression : undefined
    : body
  if (returned === undefined) return false
  const call = unparenthesized(returned)
  return ts.isCallExpression(call) && isMemberOf(call.expression, "Effect", ["gen"])
}

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)

/** The body of `node` when it is a function value (an arrow or a function expression). */
const bodyOf = (node: ts.Expression | undefined): FunctionBody => {
  const fn = node === undefined ? undefined : unparenthesized(node)
  return fn !== undefined && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn.body : undefined
}

/** An object literal that implements a service: one built as a value (a
 *  variable, a `return`, an arrow body) or handed to `X.of(…)`,
 *  `Layer.succeed(…)` or `Effect.succeed(…)`. One passed to any other call
 *  is a handler table (`Match.tags`, `Option.match`, `Effect.catchTags`). */
const isServiceObject = (literal: ts.ObjectLiteralExpression): boolean => {
  const parent = ts.isParenthesizedExpression(literal.parent) ? literal.parent.parent : literal.parent
  if (!ts.isCallExpression(parent) || parent.expression === literal) return true
  const callee = parent.expression
  return ts.isPropertyAccessExpression(callee) && (callee.name.text === "of" || callee.name.text === "succeed")
}

const preferFnMatch = (node: ts.Node): ReadonlyArray<RuleMatch> => {
  if (ts.isFunctionDeclaration(node) && isExported(node) && node.name !== undefined && onlyReturnsGen(node.body)) {
    return [{ node, message: `exported function \`${node.name.text}\` only returns \`Effect.gen\`` }]
  }
  if (ts.isVariableStatement(node) && isExported(node)) {
    return node.declarationList.declarations.flatMap((declaration) =>
      onlyReturnsGen(bodyOf(declaration.initializer)) && ts.isIdentifier(declaration.name)
        ? [{ node: declaration, message: `exported function \`${declaration.name.text}\` only returns \`Effect.gen\`` }]
        : [],
    )
  }
  if (ts.isObjectLiteralExpression(node) && isServiceObject(node)) {
    return node.properties.flatMap((property) => {
      const name = property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : "method"
      const generated =
        (ts.isPropertyAssignment(property) && onlyReturnsGen(bodyOf(property.initializer))) ||
        (ts.isMethodDeclaration(property) && onlyReturnsGen(property.body))
      return generated ? [{ node: property, message: `service method \`${name}\` only returns \`Effect.gen\`` }] : []
    })
  }
  return []
}

/** `(…) => Effect.gen(function* () { … })` is a function with no name in a
 *  trace. `Effect.fn("area.op")` is the same function, and each call is a
 *  span carrying its failures. */
export const preferEffectFn: IdiomRule = {
  id: RuleId.make("effect/prefer-effect-fn"),
  defaultSeverity: "error",
  description: "exported functions and service methods that only return `Effect.gen` are `Effect.fn`",
  fixHint:
    "write it as `Effect.fn(\"area.op\")(function* (…) { … })`, named like the spans `agent.turn` and `engine.run`; a hot helper called per item uses `Effect.fnUntraced(function* (…) { … })`",
  check: ({ sourceFile }) => matchesIn(sourceFile, preferFnMatch),
}
