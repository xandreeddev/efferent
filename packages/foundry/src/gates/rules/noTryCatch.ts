import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch } from "../idiomGate.js"
import { walk } from "../astWalk.js"

/** The `banTryCatch.ts` rule, generalized: errors are values, never control
 *  flow. (`Effect.try`/`Effect.tryPromise` never trip this — the WRAPPED api
 *  throws, our code doesn't.) */
export const noTryCatch: IdiomRule = {
  id: RuleId.make("effect/no-try-catch"),
  defaultSeverity: "error",
  description: "try/catch, throw, and .catch() are banned",
  fixHint: "create errors with Effect.fail / Effect.die; handle them with Effect.catchAll / Effect.catchTag",
  check: ({ sourceFile }) => {
    const matches: Array<RuleMatch> = []
    walk(sourceFile, (node) => {
      if (ts.isTryStatement(node)) {
        matches.push({ node, message: "try/catch is banned" })
      }
      if (ts.isThrowStatement(node)) {
        matches.push({ node, message: "throw is banned" })
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "catch"
      ) {
        matches.push({ node, message: ".catch() is banned" })
      }
    })
    return matches
  },
}
