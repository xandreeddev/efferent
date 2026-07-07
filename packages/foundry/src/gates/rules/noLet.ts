import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
import { walk } from "../astWalk.js"

const BLOCK_SCOPED =
  ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing

/** Mutable bindings are how imperative loop state sneaks in — fold state
 *  through `Effect.iterate`/`Effect.reduce`/Array combinators instead. */
export const noLet: IdiomRule = {
  id: RuleId.make("effect/no-let"),
  defaultSeverity: "error",
  description: "`let` and `var` are banned",
  fixHint: "model evolving state as an immutable fold (Effect.iterate / Effect.reduce / Array combinators) or a Ref",
  check: ({ sourceFile }) => {
    const matches: Array<RuleMatch> = []
    walk(sourceFile, (node) => {
      if (ts.isVariableDeclarationList(node)) {
        if ((node.flags & ts.NodeFlags.Let) !== 0) {
          matches.push({ node, message: "`let` is banned" })
        }
        if ((node.flags & BLOCK_SCOPED) === 0) {
          matches.push({ node, message: "`var` is banned" })
        }
      }
    })
    return matches
  },
}
