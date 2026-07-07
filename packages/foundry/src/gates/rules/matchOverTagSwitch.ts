import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
import { walk } from "../astWalk.js"

const isTagAccess = (node: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(node) && node.name.text === "_tag"

const isTagComparison = (node: ts.Expression): boolean =>
  ts.isBinaryExpression(node) &&
  (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
  (isTagAccess(node.left) || isTagAccess(node.right))

/** Length of the `if (x._tag === …) … else if (x._tag === …) …` chain
 *  starting at `node` (0 when `node` isn't a tag-comparison if). */
const tagChainLength = (node: ts.IfStatement): number =>
  isTagComparison(node.expression)
    ? 1 +
      (node.elseStatement !== undefined && ts.isIfStatement(node.elseStatement)
        ? tagChainLength(node.elseStatement)
        : 0)
    : 0

const isChainHead = (node: ts.IfStatement): boolean => {
  // Program-created source files may not have parent pointers bound yet.
  const parent: ts.Node | undefined = node.parent
  return parent === undefined || !(ts.isIfStatement(parent) && parent.elseStatement === node)
}

/**
 * `switch (x._tag)` and `_tag ===` else-if ladders don't tell the compiler
 * the union is covered — `Match.exhaustive` makes a missed (or later-added)
 * case a COMPILE error at every consumer. A single `_tag` guard is fine;
 * branching over the union is what must go through `Match`.
 */
export const matchOverTagSwitch: IdiomRule = {
  id: RuleId.make("effect/match-over-tag-switch"),
  defaultSeverity: "error",
  description: "discriminated unions are branched with Match, not `switch (x._tag)` / else-if ladders",
  fixHint: "Match.value(x).pipe(Match.tag(…), Match.exhaustive) — or Option.match / Either.match / Exit.match",
  check: ({ sourceFile }) => {
    const matches: Array<RuleMatch> = []
    walk(sourceFile, (node) => {
      if (ts.isSwitchStatement(node) && isTagAccess(node.expression)) {
        matches.push({ node, message: "`switch` on `._tag` — use Match.exhaustive" })
      }
      if (ts.isIfStatement(node) && isChainHead(node) && tagChainLength(node) >= 2) {
        matches.push({
          node,
          message: "`._tag` else-if ladder — use Match.exhaustive",
        })
      }
    })
    return matches
  },
}
