import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
import { walk } from "../astWalk.js"

const ID_SHAPED = /^(id|[a-zA-Z]*Id)$/

/** Combinators that hold a field's schema without changing it: the id
 *  inside is branded exactly when the schema they wrap is. */
const WRAPPERS = new Set([
  "optionalKey",
  "optional",
  "OptionFromNullOr",
  "OptionFromOptionalKey",
  "NullOr",
  "Array",
  "withDecodingDefaultKey",
])

/** Method chains on a schema: `.pipe(…)` brands it only through a
 *  `Schema.brand(…)` step; `.check(…)` and `.annotate(…)` never do. */
const CHAINS = new Set(["pipe", "check", "annotate"])

/** Where an id field's schema stands: branded, an unbranded primitive, or a
 *  shape this rule does not judge (a struct, a union, a literal). */
type Branding = "branded" | "unbranded" | "unjudged"

const isSchemaNamespace = (expr: ts.Expression): boolean =>
  ts.isIdentifier(expr) && expr.text === "Schema"

/** A `Schema.<member>` access: bare (`Schema.String`, `Schema.Trimmed`, …)
 *  it is an unbranded primitive. */
const isSchemaMember = (expr: ts.Expression): expr is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(expr) && isSchemaNamespace(expr.expression)

const isBrandStep = (expr: ts.Expression): boolean =>
  ts.isCallExpression(expr) && isSchemaMember(expr.expression) && expr.expression.name.text === "brand"

/** The schema `Schema.optionalKey(inner)`, or curried
 *  `Schema.withDecodingDefaultKey(…)(inner)`, wraps. */
const wrapped = (call: ts.CallExpression): ts.Expression | undefined => {
  const callee = ts.isCallExpression(call.expression) ? call.expression.expression : call.expression
  return isSchemaMember(callee) && WRAPPERS.has(callee.name.text) ? call.arguments[0] : undefined
}

/** The file's top-level `const` initializers by name, so a field that
 *  names a local schema (`id: Id`) is judged by what `Id` holds. */
const localSchemas = (sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Expression> =>
  new Map(
    sourceFile.statements.flatMap((statement): ReadonlyArray<readonly [string, ts.Expression]> =>
      ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.flatMap((declaration): ReadonlyArray<readonly [string, ts.Expression]> =>
            ts.isIdentifier(declaration.name) && declaration.initializer !== undefined
              ? [[declaration.name.text, declaration.initializer]]
              : [],
          )
        : [],
    ),
  )

/** Syntactic on purpose (checker-free). An identifier declared elsewhere
 *  (`RuleId`) is assumed branded: the brand lives at ITS definition, which
 *  this rule also sees. `seen` stops a const that refers back to itself. */
const brandingOf = (
  expr: ts.Expression,
  locals: ReadonlyMap<string, ts.Expression>,
  seen: ReadonlySet<string>,
): Branding => {
  if (ts.isParenthesizedExpression(expr)) return brandingOf(expr.expression, locals, seen)
  if (isSchemaMember(expr)) return "unbranded"
  if (ts.isIdentifier(expr)) {
    const local = locals.get(expr.text)
    if (local === undefined) return "branded"
    return seen.has(expr.text) ? "unjudged" : brandingOf(local, locals, new Set([...seen, expr.text]))
  }
  if (!ts.isCallExpression(expr)) return "unjudged"
  if (isBrandStep(expr.expression)) return "branded"
  const callee = expr.expression
  if (ts.isPropertyAccessExpression(callee) && !isSchemaNamespace(callee.expression) && CHAINS.has(callee.name.text)) {
    const brands = callee.name.text === "pipe" && expr.arguments.some(isBrandStep)
    return brands || brandingOf(callee.expression, locals, seen) === "branded" ? "branded" : "unbranded"
  }
  const inner = wrapped(expr)
  return inner === undefined ? "unjudged" : brandingOf(inner, locals, seen)
}

/**
 * The branding rubric (docs/branded-types-roadmap.md), codified — first
 * slice: id-shaped Schema fields are maximal-confusability values (any id
 * fits any id-typed hole), so they must be branded at the definition. The
 * rule looks through optionality, nullability and array wrappers, refining
 * chains and local consts to the schema a field holds.
 */
export const brandedIdFields: IdiomRule = {
  id: RuleId.make("effect/branded-id-fields"),
  defaultSeverity: "error",
  description: "id-shaped Schema fields must be branded",
  fixHint: "mint a brand — const XId = Schema.UUID.pipe(Schema.brand(\"XId\")) — and reference it",
  check: ({ sourceFile }) => {
    const locals = localSchemas(sourceFile)
    const matches: Array<RuleMatch> = []
    walk(sourceFile, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        ID_SHAPED.test(node.name.text) &&
        brandingOf(node.initializer, locals, new Set()) === "unbranded"
      ) {
        matches.push({
          node,
          message: `id-shaped field \`${node.name.text}\` is an unbranded primitive`,
        })
      }
    })
    return matches
  },
}
