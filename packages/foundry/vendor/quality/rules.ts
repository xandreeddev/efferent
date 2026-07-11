/**
 * The efferent "quality" rule pack, vendored — PROJECT-OWNED after `smith
 * profile` writes it into your workspace. Paradigm-neutral: each rule
 * defends the factory's own threat model (gaming the gates), not a style
 * opinion. Edit freely; plug in via `export const customRules = rules`.
 */
import * as ts from "typescript"

export interface VendoredRuleContext {
  readonly sourceFile: ts.SourceFile
  readonly checker: ts.TypeChecker
}

export interface VendoredMatch {
  readonly node: ts.Node
  readonly message: string
}

const walk = (root: ts.Node, visit: (node: ts.Node) => void): void => {
  visit(root)
  ts.forEachChild(root, (child) => walk(child, visit))
}

const SKIP_PROPS = new Set(["skip", "todo"])
const RUNNER_OBJECTS = new Set(["test", "it", "describe", "suite"])
const SKIP_IDENTIFIERS = new Set(["xit", "xdescribe", "xtest"])

export const noSkippedTests = {
  id: "quality/no-skipped-tests",
  defaultSeverity: "error",
  description: "skipped/todo tests are banned — a skipped test is invisible to the test gate",
  fixHint: "make the test pass or delete it deliberately — never park it where the gate can't see it",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> => {
    const matches: Array<VendoredMatch> = []
    walk(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return
      const callee = node.expression
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        RUNNER_OBJECTS.has(callee.expression.text) &&
        SKIP_PROPS.has(callee.name.text)
      ) {
        matches.push({
          node,
          message: `\`${callee.expression.text}.${callee.name.text}\` hides this test from the gate`,
        })
      }
      if (ts.isIdentifier(callee) && SKIP_IDENTIFIERS.has(callee.text)) {
        matches.push({ node, message: `\`${callee.text}\` hides this test from the gate` })
      }
    })
    return matches
  },
}

export const noEmptyCatch = {
  id: "quality/no-empty-catch",
  defaultSeverity: "error",
  description: "an empty catch block swallows errors silently",
  fixHint: "handle the error, rethrow it, or record it deliberately — an empty catch hides failures",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> => {
    const matches: Array<VendoredMatch> = []
    walk(sourceFile, (node) => {
      if (ts.isCatchClause(node) && node.block.statements.length === 0) {
        matches.push({ node, message: "empty catch block swallows the error" })
      }
    })
    return matches
  },
}

/** The whole pack — plug in via `export const customRules = rules`. */
export const rules = [noSkippedTests, noEmptyCatch]
