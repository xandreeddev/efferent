/**
 * The efferent "effect" rule pack, vendored — PROJECT-OWNED after `smith
 * profile` writes it into your workspace. Edit freely: rename ids, tune
 * messages, delete rules, add your own. Your `foundry.config.ts` plugs these
 * in via `export const customRules = rules` (or spread a subset).
 *
 * Shape contract (structural — no efferent imports needed):
 *   { id: "<ns>/<name>", defaultSeverity: "error"|"warning"|"info",
 *     description, fixHint, check: ({sourceFile, checker}) => [{node, message}] }
 * A rule that throws reports itself as a finding (the runner wraps it) —
 * never a silent pass.
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

/** Depth-first visit of every node under (and including) `root`. */
const walk = (root: ts.Node, visit: (node: ts.Node) => void): void => {
  visit(root)
  ts.forEachChild(root, (child) => walk(child, visit))
}

const BLOCK_SCOPED =
  ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing

export const noLet = {
  id: "effect/no-let",
  defaultSeverity: "error",
  description: "`let` and `var` are banned",
  fixHint:
    "model evolving state as an immutable fold (Effect.iterate / Effect.reduce / Array combinators) or a Ref",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> => {
    const matches: Array<VendoredMatch> = []
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

export const noTryCatch = {
  id: "effect/no-try-catch",
  defaultSeverity: "error",
  description: "try/catch, throw, and .catch() are banned",
  fixHint:
    "create errors with Effect.fail / Effect.die; handle them with Effect.catchAll / Effect.catchTag",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> => {
    const matches: Array<VendoredMatch> = []
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

const loopLabel = (node: ts.Node): string =>
  ts.isForOfStatement(node)
    ? "for…of"
    : ts.isForInStatement(node)
      ? "for…in"
      : ts.isForStatement(node)
        ? "for"
        : ts.isWhileStatement(node)
          ? "while"
          : "do…while"

export const noLoopStatements = {
  id: "effect/no-loop-statements",
  defaultSeverity: "error",
  description: "loop statements are banned; iteration is a fold",
  fixHint:
    "Effect.iterate / Effect.loop for effectful loops; Effect.forEach for effectful iteration; Array combinators (map/filter/reduce/flatMap) for pure iteration",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> => {
    const matches: Array<VendoredMatch> = []
    walk(sourceFile, (node) => {
      if (
        ts.isForStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node)
      ) {
        matches.push({ node, message: `\`${loopLabel(node)}\` loop — fold instead` })
      }
    })
    return matches
  },
}

const NULLISH = ts.TypeFlags.Undefined | ts.TypeFlags.Null
const NEVERISH =
  ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

type ExportedFunction = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression

const exportedFunctions = (sourceFile: ts.SourceFile): ReadonlyArray<ExportedFunction> =>
  sourceFile.statements.flatMap((statement): ReadonlyArray<ExportedFunction> => {
    if (ts.isFunctionDeclaration(statement) && isExported(statement)) return [statement]
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      return statement.declarationList.declarations.flatMap((decl) =>
        decl.initializer !== undefined &&
        (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          ? [decl.initializer]
          : [],
      )
    }
    return []
  })

export const noNullableReturn = {
  id: "effect/no-nullable-return",
  defaultSeverity: "error",
  description: "exported functions must not return `A | undefined` / `A | null`",
  fixHint:
    "return Option<A> (Option.fromNullable at the boundary); keep nullable unions for wire schemas only",
  check: ({ sourceFile, checker }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    exportedFunctions(sourceFile).flatMap((fn): ReadonlyArray<VendoredMatch> => {
      const signature = checker.getSignatureFromDeclaration(fn)
      if (signature === undefined) return []
      const returnType = signature.getReturnType()
      if (!returnType.isUnion()) return []
      const hasNullish = returnType.types.some((t) => (t.flags & NULLISH) !== 0)
      const hasValue = returnType.types.some((t) => (t.flags & NEVERISH) === 0)
      return hasNullish && hasValue
        ? [
            {
              node: fn,
              message: `returns \`${checker.typeToString(returnType)}\` — absence should be Option`,
            },
          ]
        : []
    }),
}

const isTagAccess = (node: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(node) && node.name.text === "_tag"

const isTagComparison = (node: ts.Expression): boolean =>
  ts.isBinaryExpression(node) &&
  (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
  (isTagAccess(node.left) || isTagAccess(node.right))

const tagChainLength = (node: ts.IfStatement): number =>
  isTagComparison(node.expression)
    ? 1 +
      (node.elseStatement !== undefined && ts.isIfStatement(node.elseStatement)
        ? tagChainLength(node.elseStatement)
        : 0)
    : 0

const isChainHead = (node: ts.IfStatement): boolean => {
  const parent: ts.Node | undefined = node.parent
  return parent === undefined || !(ts.isIfStatement(parent) && parent.elseStatement === node)
}

export const matchOverTagSwitch = {
  id: "effect/match-over-tag-switch",
  defaultSeverity: "error",
  description:
    "discriminated unions are branched with Match, not `switch (x._tag)` / else-if ladders",
  fixHint:
    "Match.value(x).pipe(Match.tag(…), Match.exhaustive) — or Option.match / Either.match / Exit.match",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> => {
    const matches: Array<VendoredMatch> = []
    walk(sourceFile, (node) => {
      if (ts.isSwitchStatement(node) && isTagAccess(node.expression)) {
        matches.push({ node, message: "`switch` on `._tag` — use Match.exhaustive" })
      }
      if (ts.isIfStatement(node) && isChainHead(node) && tagChainLength(node) >= 2) {
        matches.push({ node, message: "`._tag` else-if ladder — use Match.exhaustive" })
      }
    })
    return matches
  },
}

export const noAsAny = {
  id: "effect/no-as-any",
  defaultSeverity: "error",
  description: "`as any` and `as unknown as T` are banned",
  fixHint: "decode with Schema at the boundary, or fix the type — never launder it",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> => {
    const matches: Array<VendoredMatch> = []
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

const ID_SHAPED = /^(id|[a-zA-Z]*Id)$/

const isBareSchemaPrimitive = (expr: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(expr) &&
  ts.isIdentifier(expr.expression) &&
  expr.expression.text === "Schema"

const isUnbrandedPipe = (expr: ts.Expression): boolean =>
  ts.isCallExpression(expr) &&
  ts.isPropertyAccessExpression(expr.expression) &&
  expr.expression.name.text === "pipe" &&
  !expr.getText().includes("Schema.brand(")

export const brandedIdFields = {
  id: "effect/branded-id-fields",
  defaultSeverity: "error",
  description: "id-shaped Schema fields must be branded",
  fixHint:
    'mint a brand — const XId = Schema.UUID.pipe(Schema.brand("XId")) — and reference it',
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> => {
    const matches: Array<VendoredMatch> = []
    walk(sourceFile, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        ID_SHAPED.test(node.name.text) &&
        (isBareSchemaPrimitive(node.initializer) || isUnbrandedPipe(node.initializer))
      ) {
        matches.push({
          node,
          message: `id-shaped field \`${node.name.text}\` is an unbranded primitive`,
        })
      }
    })
    return matches
  },
}

const isSchemaValueDeclaration = (statement: ts.Statement, name: string): boolean => {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some(
      (decl) =>
        ts.isIdentifier(decl.name) &&
        decl.name.text === name &&
        decl.initializer !== undefined &&
        decl.initializer.getText().startsWith("Schema."),
    )
  }
  if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
    return (statement.heritageClauses ?? []).some((clause) =>
      clause.types.some((t) => t.expression.getText().startsWith("Schema.")),
    )
  }
  return false
}

export const noParallelInterface = {
  id: "effect/no-parallel-interface",
  defaultSeverity: "error",
  description: "a hand-written interface must not shadow a same-named Schema declaration",
  fixHint: "derive the type from the schema — `export type X = typeof X.Type` — one source of truth",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    sourceFile.statements.flatMap((statement): ReadonlyArray<VendoredMatch> =>
      ts.isInterfaceDeclaration(statement) &&
      sourceFile.statements.some((other) => isSchemaValueDeclaration(other, statement.name.text))
        ? [
            {
              node: statement,
              message: `interface \`${statement.name.text}\` shadows the Schema declaration of the same name`,
            },
          ]
        : [],
    ),
}

/** The whole pack — plug in via `export const customRules = rules` (or a subset). */
export const rules = [
  noTryCatch,
  noLet,
  noLoopStatements,
  noNullableReturn,
  matchOverTagSwitch,
  noAsAny,
  brandedIdFields,
  noParallelInterface,
]
