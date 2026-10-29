import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
import { walk } from "../astWalk.js"

/** The discriminants a union is branched on: `_tag`, and the literal
 *  `type`, `role` and `mode` fields. */
const DISCRIMINANTS = ["_tag", "type", "role", "mode"]

const unparenthesized = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unparenthesized(node.expression) : node

const discriminantOf = (node: ts.Expression): string | undefined =>
  ts.isPropertyAccessExpression(node) && DISCRIMINANTS.includes(node.name.text) ? node.name.text : undefined

/** `x.<discriminant> === …` (or `!==`): any operand for `_tag`, a string
 *  literal for the others (`x.mode === y.mode` compares two values). */
const comparedDiscriminant = (node: ts.Expression): string | undefined => {
  const comparison = unparenthesized(node)
  if (
    !ts.isBinaryExpression(comparison) ||
    (comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      comparison.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken)
  ) {
    return undefined
  }
  const sides: ReadonlyArray<readonly [ts.Expression, ts.Expression]> = [
    [comparison.left, comparison.right],
    [comparison.right, comparison.left],
  ]
  return sides
    .map(([subject, other]) => {
      const name = discriminantOf(subject)
      return name !== undefined && (name === "_tag" || ts.isStringLiteralLike(other)) ? name : undefined
    })
    .find((name) => name !== undefined)
}

/** The discriminants compared along the `if (…) … else if (…) …` chain
 *  starting at `node`, until a condition compares none. */
const ladder = (node: ts.IfStatement): ReadonlyArray<string> => {
  const name = comparedDiscriminant(node.expression)
  if (name === undefined) return []
  const next = node.elseStatement
  return [name, ...(next !== undefined && ts.isIfStatement(next) ? ladder(next) : [])]
}

/** The same chain for `a ? x : b ? y : z`. */
const ternaryChain = (node: ts.ConditionalExpression): ReadonlyArray<string> => {
  const name = comparedDiscriminant(node.condition)
  if (name === undefined) return []
  const next = unparenthesized(node.whenFalse)
  return [name, ...(ts.isConditionalExpression(next) ? ternaryChain(next) : [])]
}

const isLadderHead = (node: ts.IfStatement): boolean => {
  // Program-created source files may not have parent pointers bound yet.
  const parent: ts.Node | undefined = node.parent
  return parent === undefined || !(ts.isIfStatement(parent) && parent.elseStatement === node)
}

const isTernaryHead = (node: ts.ConditionalExpression): boolean => {
  const outer = (inner: ts.Node): ts.Node | undefined => {
    const parent: ts.Node | undefined = inner.parent
    return parent !== undefined && ts.isParenthesizedExpression(parent) ? outer(parent) : parent
  }
  const parent = outer(node)
  return parent === undefined || !(ts.isConditionalExpression(parent) && unparenthesized(parent.whenFalse) === node)
}

/**
 * `switch (x._tag)`, `_tag ===` else-if ladders and ternary chains don't tell
 * the compiler the union is covered — `Match.exhaustive` makes a missed (or
 * later-added) case a COMPILE error at every consumer. A single guard is
 * fine; branching over the union is what must go through `Match`.
 *
 * The `switch` and the ladder on `_tag` report everywhere. Ternary chains,
 * and the `type`, `role` and `mode` discriminants, came later: those matches
 * are tolerated in the files the rule's config names as its `boundary` (the
 * code not yet converted), so they can be enforced one package at a time.
 */
export const matchOverTagSwitch: IdiomRule = {
  id: RuleId.make("effect/match-over-tag-switch"),
  defaultSeverity: "error",
  description: "discriminated unions are branched with Match, not `switch`, else-if ladders or ternary chains on `_tag`, `type`, `role` or `mode`",
  fixHint:
    "Match.value(x).pipe(Match.tag(…), Match.exhaustive) or Match.valueTags(x, { … }) for `_tag`; Match.discriminators(\"type\")({ … }) for another field — or Option.match / Result.match / Exit.match",
  check: ({ sourceFile }) => {
    const matches: Array<RuleMatch> = []
    walk(sourceFile, (node) => {
      if (ts.isSwitchStatement(node)) {
        const name = discriminantOf(unparenthesized(node.expression))
        if (name !== undefined) {
          matches.push({ node, message: `\`switch\` on \`.${name}\` — use Match.exhaustive`, toleratedAtBoundary: name !== "_tag" })
        }
      }
      if (ts.isIfStatement(node) && isLadderHead(node)) {
        const names = ladder(node)
        if (names.length >= 2) {
          const name = names[0] ?? "_tag"
          matches.push({
            node,
            message: `\`.${name}\` else-if ladder — use Match.exhaustive`,
            toleratedAtBoundary: names.some((other) => other !== "_tag"),
          })
        }
      }
      if (ts.isConditionalExpression(node) && isTernaryHead(node)) {
        const names = ternaryChain(node)
        if (names.length >= 2) {
          matches.push({
            node,
            message: `\`.${names[0] ?? "_tag"}\` ternary chain — use Match.exhaustive`,
            toleratedAtBoundary: true,
          })
        }
      }
    })
    return matches
  },
}
