import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
import { walk } from "../astWalk.js"

const label = (node: ts.Node): string =>
  ts.isForOfStatement(node)
    ? "for…of"
    : ts.isForInStatement(node)
      ? "for…in"
      : ts.isForStatement(node)
        ? "for"
        : ts.isWhileStatement(node)
          ? "while"
          : "do…while"

/** Imperative loops are where the `let` accumulators live — the audit's
 *  agent loop was one `while` with 10 mutable bindings. Iteration is a fold. */
export const noLoopStatements: IdiomRule = {
  id: RuleId.make("effect/no-loop-statements"),
  defaultSeverity: "error",
  description: "loop statements are banned; iteration is a fold",
  fixHint: "Effect.iterate / Effect.loop for effectful loops; Effect.forEach for effectful iteration; Array combinators (map/filter/reduce/flatMap) for pure iteration",
  check: ({ sourceFile }) => {
    const matches: Array<RuleMatch> = []
    walk(sourceFile, (node) => {
      if (
        ts.isForStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node)
      ) {
        matches.push({ node, message: `\`${label(node)}\` loop — fold instead` })
      }
    })
    return matches
  },
}
