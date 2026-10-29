import * as ts from "typescript"
import type { RuleMatch } from "../idiomGate.js"
import { walk } from "../astWalk.js"

/** `owner.member` with `owner` a plain identifier and `member` one of `members`:
 *  `JSON.parse`, `Effect.promise`, `process.env`. */
export const isMemberOf = (
  node: ts.Node,
  owner: string,
  members: ReadonlyArray<string>,
): node is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === owner &&
  members.includes(node.name.text)

/** A call whose callee is `<anything>.<method>`. */
export const isMethodCall = (node: ts.Node, methods: ReadonlyArray<string>): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  methods.includes(node.expression.name.text)

/** Every match `matchOf` finds, one node at a time, depth first. */
export const matchesIn = (
  sourceFile: ts.SourceFile,
  matchOf: (node: ts.Node) => ReadonlyArray<RuleMatch>,
): ReadonlyArray<RuleMatch> => {
  const matches: Array<RuleMatch> = []
  walk(sourceFile, (node) => {
    matches.push(...matchOf(node))
  })
  return matches
}
