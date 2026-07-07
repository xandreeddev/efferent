import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
import { walk } from "../astWalk.js"

/** `as any` (and the `as unknown as T` laundering chain) turns the type
 *  system off exactly where generated code is most likely to be wrong. */
export const noAsAny: IdiomRule = {
  id: RuleId.make("effect/no-as-any"),
  defaultSeverity: "error",
  description: "`as any` and `as unknown as T` are banned",
  fixHint: "decode with Schema at the boundary, or fix the type — never launder it",
  check: ({ sourceFile }) => {
    const matches: Array<RuleMatch> = []
    walk(sourceFile, (node) => {
      if (ts.isAsExpression(node)) {
        if (node.type.kind === ts.SyntaxKind.AnyKeyword) {
          matches.push({ node, message: "`as any` is banned" })
        }
        if (
          node.type.kind === ts.SyntaxKind.UnknownKeyword &&
          ts.isAsExpression(node.parent)
        ) {
          matches.push({ node: node.parent, message: "`as unknown as T` laundering is banned" })
        }
      }
    })
    return matches
  },
}
