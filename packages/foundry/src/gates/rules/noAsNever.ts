import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
import { walk } from "../astWalk.js"

/** The cast `x as never` is a step of, past any parentheses: `(x as never) as T`. */
const castOf = (node: ts.Node): ts.Node =>
  ts.isParenthesizedExpression(node.parent) ? castOf(node.parent) : node.parent

/** `as never` is `as any` with better manners: `never` is assignable to
 *  everything, so the cast turns the checker off at the call site exactly
 *  like `any` does — and it had become the codebase's sanctioned escape
 *  hatch. Where type erasure IS the design (a router wrapping arbitrary
 *  provider services, a bridge over dynamic tools), the profile names those
 *  files as the rule's `boundary`: a declared boundary, not a habit.
 *  `x as never as T` is `as unknown as T` under another name — it claims a
 *  type no erasure needs — so it fails on the boundary too. */
export const noAsNever: IdiomRule = {
  id: RuleId.make("effect/no-as-never"),
  defaultSeverity: "error",
  description: "`as never` is banned outside the declared type-erasure boundary, and `as never as T` everywhere",
  fixHint: "fix the type, decode with Schema at the boundary, or name the file in the rule's `boundary` if erasure is the design there (never for `as never as T`: type the value instead)",
  check: ({ sourceFile }) => {
    const matches: Array<RuleMatch> = []
    walk(sourceFile, (node) => {
      if (ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.NeverKeyword) {
        const outer = castOf(node)
        matches.push(
          ts.isAsExpression(outer)
            ? { node: outer, message: "`as never as T` launders the type like `as unknown as T`" }
            : { node, message: "`as never` launders the type like `as any`", toleratedAtBoundary: true },
        )
      }
    })
    return matches
  },
}
