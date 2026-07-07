import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
import { walk } from "../astWalk.js"

const ID_SHAPED = /^(id|[a-zA-Z]*Id)$/

/** A bare `Schema.<Primitive>` member access (`Schema.String`, `Schema.UUID`,
 *  `Schema.Number`, …) — the unbranded shapes an id field must not be. */
const isBareSchemaPrimitive = (expr: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(expr) &&
  ts.isIdentifier(expr.expression) &&
  expr.expression.text === "Schema"

/** A `X.pipe(…)` call that never passes through `Schema.brand`. Syntactic on
 *  purpose (checker-free): an identifier reference (`RuleId`) is assumed
 *  branded — the brand lives at ITS definition, which this rule also sees. */
const isUnbrandedPipe = (expr: ts.Expression): boolean =>
  ts.isCallExpression(expr) &&
  ts.isPropertyAccessExpression(expr.expression) &&
  expr.expression.name.text === "pipe" &&
  !expr.getText().includes("Schema.brand(")

/**
 * The branding rubric (docs/branded-types-roadmap.md), codified — first
 * slice: id-shaped Schema fields are maximal-confusability values (any id
 * fits any id-typed hole), so they must be branded at the definition.
 */
export const brandedIdFields: IdiomRule = {
  id: RuleId.make("effect/branded-id-fields"),
  defaultSeverity: "error",
  description: "id-shaped Schema fields must be branded",
  fixHint: "mint a brand — const XId = Schema.UUID.pipe(Schema.brand(\"XId\")) — and reference it",
  check: ({ sourceFile }) => {
    const matches: Array<RuleMatch> = []
    walk(sourceFile, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        ID_SHAPED.test(node.name.text) &&
        (isBareSchemaPrimitive(node.initializer) || isUnbrandedPipe(node.initializer))
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
