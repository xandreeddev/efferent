import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
import { walk } from "../astWalk.js"

/** An empty catch block swallows the error silently — the failure vanishes
 *  instead of failing. The paradigm-neutral opener for workspaces where
 *  try/catch itself is idiomatic (where `effect/no-try-catch` would be
 *  absurd). */
export const noEmptyCatch: IdiomRule = {
  id: RuleId.make("quality/no-empty-catch"),
  defaultSeverity: "error",
  description: "an empty catch block swallows errors silently",
  fixHint: "handle the error, rethrow it, or record it deliberately — an empty catch hides failures",
  check: ({ sourceFile }) => {
    const matches: Array<RuleMatch> = []
    walk(sourceFile, (node) => {
      if (ts.isCatchClause(node) && node.block.statements.length === 0) {
        matches.push({ node, message: "empty catch block swallows the error" })
      }
    })
    return matches
  },
}
