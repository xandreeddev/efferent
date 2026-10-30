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
  /** Dropped in the files a rule config names as its `boundary`. */
  readonly toleratedAtBoundary?: boolean
}

/** Depth-first visit of every node under (and including) `root`. */
const walk = (root: ts.Node, visit: (node: ts.Node) => void): void => {
  visit(root)
  ts.forEachChild(root, (child) => walk(child, visit))
}

/**
 * Whether `access` (`X.name`) resolves to a function the `effect` package
 * exports. Effect v4 names its handler `Effect.catch` (`Stream.catch`…),
 * which is not Promise#catch. Unresolved names count as foreign.
 */
const isEffectExport = (checker: ts.TypeChecker, access: ts.PropertyAccessExpression): boolean => {
  const symbol = checker.getSymbolAtLocation(access.name)
  const resolved = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
  return (resolved?.declarations ?? []).some((declaration) =>
    /[\\/]node_modules[\\/]effect[\\/]/.test(declaration.getSourceFile().fileName))
}

const BLOCK_SCOPED =
  ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing

export const noLet = {
  id: "effect/no-let",
  defaultSeverity: "error",
  description: "`let` and `var` are banned",
  fixHint:
    "model evolving state as an immutable fold (Effect.reduce / a recursive Effect step / Array combinators) or a Ref",
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
    "create errors with Effect.fail / Effect.die; handle them with Effect.catch / Effect.catchTag",
  check: ({ sourceFile, checker }: VendoredRuleContext): ReadonlyArray<VendoredMatch> => {
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
        node.expression.name.text === "catch" &&
        !isEffectExport(checker, node.expression)
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
    "a recursive Effect step or Effect.repeat for effectful loops; Effect.forEach for effectful iteration; Array combinators (map/filter/reduce/flatMap) for pure iteration",
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
    "return Option<A> (Option.fromNullishOr at the boundary); keep nullable unions for wire schemas only",
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

const DISCRIMINANTS = ["_tag", "type", "role", "mode"]

const unparenthesized = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unparenthesized(node.expression) : node

const discriminantOf = (node: ts.Expression): string | undefined =>
  ts.isPropertyAccessExpression(node) && DISCRIMINANTS.includes(node.name.text) ? node.name.text : undefined

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

const ladder = (node: ts.IfStatement): ReadonlyArray<string> => {
  const name = comparedDiscriminant(node.expression)
  if (name === undefined) return []
  const next = node.elseStatement
  return [name, ...(next !== undefined && ts.isIfStatement(next) ? ladder(next) : [])]
}

const ternaryChain = (node: ts.ConditionalExpression): ReadonlyArray<string> => {
  const name = comparedDiscriminant(node.condition)
  if (name === undefined) return []
  const next = unparenthesized(node.whenFalse)
  return [name, ...(ts.isConditionalExpression(next) ? ternaryChain(next) : [])]
}

const isLadderHead = (node: ts.IfStatement): boolean => {
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

/** The `switch` and the else-if ladder on `_tag` report everywhere; ternary
 *  chains and the `type`/`role`/`mode` discriminants are tolerated in the
 *  files a rule config names as its `boundary`. */
export const matchOverTagSwitch = {
  id: "effect/match-over-tag-switch",
  defaultSeverity: "error",
  description:
    "discriminated unions are branched with Match, not `switch`, else-if ladders or ternary chains on `_tag`, `type`, `role` or `mode`",
  fixHint:
    "Match.value(x).pipe(Match.tag(…), Match.exhaustive) or Match.valueTags(x, { … }) for `_tag`; Match.discriminators(\"type\")({ … }) for another field — or Option.match / Result.match / Exit.match",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> => {
    const matches: Array<VendoredMatch> = []
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
          matches.push({
            node,
            message: `\`.${names[0] ?? "_tag"}\` else-if ladder — use Match.exhaustive`,
            toleratedAtBoundary: names.some((other) => other !== "_tag"),
          })
        }
      }
      if (ts.isConditionalExpression(node) && isTernaryHead(node)) {
        const names = ternaryChain(node)
        if (names.length >= 2) {
          matches.push({ node, message: `\`.${names[0] ?? "_tag"}\` ternary chain — use Match.exhaustive`, toleratedAtBoundary: true })
        }
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

/** The cast `x as never` is a step of, past any parentheses: `(x as never) as T`. */
const castOf = (node: ts.Node): ts.Node =>
  ts.isParenthesizedExpression(node.parent) ? castOf(node.parent) : node.parent

export const noAsNever = {
  id: "effect/no-as-never",
  defaultSeverity: "error",
  description: "`as never` is banned outside the declared type-erasure boundary, and `as never as T` everywhere",
  fixHint: "fix the type, decode with Schema at the boundary, or name the file in the rule's `boundary` if erasure is the design there (never for `as never as T`: type the value instead)",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> => {
    const matches: Array<VendoredMatch> = []
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

/** The effect types whose third parameter is what they require. */
const REQUIRING = ["Effect", "Stream", "Layer"]

/** `Name` or `Namespace.Name`: the identifier that names the type. */
const nameOf = (typeName: ts.EntityName): ts.Identifier => (ts.isQualifiedName(typeName) ? typeName.right : typeName)

/** Whether `name` resolves to an interface the `effect` package declares. */
const isEffectInterface = (checker: ts.TypeChecker, name: ts.Identifier): boolean => {
  const symbol = checker.getSymbolAtLocation(name)
  const resolved = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
  return (resolved?.declarations ?? []).some((declaration) =>
    ts.isInterfaceDeclaration(declaration) && /[\\/]node_modules[\\/]effect[\\/]/.test(declaration.getSourceFile().fileName))
}

export const noUnknownRequirements = {
  id: "effect/no-unknown-requirements",
  defaultSeverity: "error",
  description: "an `Effect`, `Stream` or `Layer` type names what it requires: never `unknown` as its R",
  fixHint:
    "name the services in R (their identifiers, `never` for none) or keep R a type parameter; where a JSON config picks the services at run time, declare their keys and check them by key where they are provided",
  check: ({ sourceFile, checker }: VendoredRuleContext): ReadonlyArray<VendoredMatch> => {
    const matches: Array<VendoredMatch> = []
    walk(sourceFile, (node) => {
      if (!ts.isTypeReferenceNode(node)) return
      const name = nameOf(node.typeName)
      const requirements = node.typeArguments?.[2]
      if (
        REQUIRING.includes(name.text) &&
        requirements !== undefined &&
        (checker.getTypeFromTypeNode(requirements).flags & ts.TypeFlags.Unknown) !== 0 &&
        isEffectInterface(checker, name)
      ) {
        matches.push({ node, message: `\`${node.typeName.getText(sourceFile)}<…, unknown>\` hides what it requires: a service it reads compiles whether anything provides it or not` })
      }
    })
    return matches
  },
}

const ID_SHAPED = /^(id|[a-zA-Z]*Id)$/

/** Combinators that hold a field's schema without changing it: the id
 *  inside is branded exactly when the schema they wrap is. */
const WRAPPERS = new Set([
  "optionalKey",
  "optional",
  "OptionFromNullOr",
  "OptionFromOptionalKey",
  "NullOr",
  "Array",
  "withDecodingDefaultKey",
])

/** Method chains on a schema: `.pipe(…)` brands it only through a
 *  `Schema.brand(…)` step; `.check(…)` and `.annotate(…)` never do. */
const CHAINS = new Set(["pipe", "check", "annotate"])

/** Where an id field's schema stands: branded, an unbranded primitive, or a
 *  shape this rule does not judge (a struct, a union, a literal). */
type Branding = "branded" | "unbranded" | "unjudged"

const isSchemaNamespace = (expr: ts.Expression): boolean =>
  ts.isIdentifier(expr) && expr.text === "Schema"

/** A `Schema.<member>` access: bare (`Schema.String`, `Schema.Trimmed`, …)
 *  it is an unbranded primitive. */
const isSchemaMember = (expr: ts.Expression): expr is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(expr) && isSchemaNamespace(expr.expression)

const isBrandStep = (expr: ts.Expression): boolean =>
  ts.isCallExpression(expr) && isSchemaMember(expr.expression) && expr.expression.name.text === "brand"

/** The schema `Schema.optionalKey(inner)`, or curried
 *  `Schema.withDecodingDefaultKey(…)(inner)`, wraps. */
const wrapped = (call: ts.CallExpression): ts.Expression | undefined => {
  const callee = ts.isCallExpression(call.expression) ? call.expression.expression : call.expression
  return isSchemaMember(callee) && WRAPPERS.has(callee.name.text) ? call.arguments[0] : undefined
}

/** The file's top-level `const` initializers by name, so a field that
 *  names a local schema (`id: Id`) is judged by what `Id` holds. */
const localSchemas = (sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Expression> =>
  new Map(
    sourceFile.statements.flatMap((statement): ReadonlyArray<readonly [string, ts.Expression]> =>
      ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.flatMap((declaration): ReadonlyArray<readonly [string, ts.Expression]> =>
            ts.isIdentifier(declaration.name) && declaration.initializer !== undefined
              ? [[declaration.name.text, declaration.initializer]]
              : [],
          )
        : [],
    ),
  )

/** Syntactic on purpose (checker-free). An identifier declared elsewhere
 *  (`RuleId`) is assumed branded: the brand lives at ITS definition, which
 *  this rule also sees. `seen` stops a const that refers back to itself. */
const brandingOf = (
  expr: ts.Expression,
  locals: ReadonlyMap<string, ts.Expression>,
  seen: ReadonlySet<string>,
): Branding => {
  if (ts.isParenthesizedExpression(expr)) return brandingOf(expr.expression, locals, seen)
  if (isSchemaMember(expr)) return "unbranded"
  if (ts.isIdentifier(expr)) {
    const local = locals.get(expr.text)
    if (local === undefined) return "branded"
    return seen.has(expr.text) ? "unjudged" : brandingOf(local, locals, new Set([...seen, expr.text]))
  }
  if (!ts.isCallExpression(expr)) return "unjudged"
  if (isBrandStep(expr.expression)) return "branded"
  const callee = expr.expression
  if (ts.isPropertyAccessExpression(callee) && !isSchemaNamespace(callee.expression) && CHAINS.has(callee.name.text)) {
    const brands = callee.name.text === "pipe" && expr.arguments.some(isBrandStep)
    return brands || brandingOf(callee.expression, locals, seen) === "branded" ? "branded" : "unbranded"
  }
  const inner = wrapped(expr)
  return inner === undefined ? "unjudged" : brandingOf(inner, locals, seen)
}

export const brandedIdFields = {
  id: "effect/branded-id-fields",
  defaultSeverity: "error",
  description: "id-shaped Schema fields must be branded",
  fixHint:
    'mint a brand — const XId = Schema.UUID.pipe(Schema.brand("XId")) — and reference it',
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> => {
    const locals = localSchemas(sourceFile)
    const matches: Array<VendoredMatch> = []
    walk(sourceFile, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        ID_SHAPED.test(node.name.text) &&
        brandingOf(node.initializer, locals, new Set()) === "unbranded"
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

/** `owner.member` with `owner` a plain identifier and `member` one of `members`. */
const isMemberOf = (node: ts.Node, owner: string, members: ReadonlyArray<string>): node is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === owner &&
  members.includes(node.name.text)

/** A call whose callee is `<anything>.<method>`. */
const isMethodCall = (node: ts.Node, methods: ReadonlyArray<string>): node is ts.CallExpression =>
  ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && methods.includes(node.expression.name.text)

/** Every match `matchOf` finds, one node at a time, depth first. */
const matchesIn = (sourceFile: ts.SourceFile, matchOf: (node: ts.Node) => ReadonlyArray<VendoredMatch>): ReadonlyArray<VendoredMatch> => {
  const matches: Array<VendoredMatch> = []
  walk(sourceFile, (node) => {
    matches.push(...matchOf(node))
  })
  return matches
}

export const noJsonParse = {
  id: "effect/no-json-parse",
  defaultSeverity: "error",
  description: "JSON text is decoded with a Schema, never `JSON.parse`",
  fixHint:
    "decode with `Schema.decodeUnknownEffect(Schema.fromJsonString(S))` (`decodeUnknownResult`/`decodeUnknownOption` in pure code); `Schema.fromJsonString(Schema.Json)` (`Schema.JsonObject` for an object) when the shape is open",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) =>
      isMemberOf(node, "JSON", ["parse"])
        ? [{ node, message: "`JSON.parse` yields an unchecked value and throws on malformed text" }]
        : [],
    ),
}

const SYNC_CODECS = ["decodeSync", "decodeUnknownSync", "encodeSync", "encodeUnknownSync"]

export const noSyncCodec = {
  id: "effect/no-sync-codec",
  defaultSeverity: "error",
  description: "Schema codecs return their failure; the throwing `*Sync` forms are banned",
  fixHint:
    "use the Effect form (`decodeUnknownEffect`/`encodeEffect`), the Result form (`decodeUnknownResult`/`encodeResult`) or the Option form (`decodeUnknownOption`), and handle the failure",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) =>
      ts.isPropertyAccessExpression(node) && SYNC_CODECS.includes(node.name.text)
        ? [{ node, message: `\`${node.name.text}\` throws when the value does not ${node.name.text.startsWith("decode") ? "decode" : "encode"}` }]
        : [],
    ),
}

/** `Schema.<name>`, `node` absent being no match. */
const isSchema = (node: ts.Node | undefined, name: string): boolean =>
  node !== undefined && isMemberOf(node, "Schema", [name])

/** An argument of a `Schema.encode*` call: writing an open value out as JSON text trusts nothing. */
const isEncoded = (node: ts.Node): boolean =>
  ts.isCallExpression(node.parent) &&
  node.parent.arguments.some((argument) => argument === node) &&
  ts.isPropertyAccessExpression(node.parent.expression) &&
  node.parent.expression.name.text.startsWith("encode") &&
  isSchema(node.parent.expression, node.parent.expression.name.text)

const openSchemaMessage = (node: ts.Node): ReadonlyArray<string> =>
  !ts.isCallExpression(node)
    ? []
    : isSchema(node.expression, "Record") && isSchema(node.arguments[0], "String") && isSchema(node.arguments[1], "Unknown")
      ? ["`Schema.Record(Schema.String, Schema.Unknown)` checks the keys and lets every value through"]
      : isSchema(node.expression, "fromJsonString") && isSchema(node.arguments[0], "Unknown")
        ? ["`Schema.fromJsonString(Schema.Unknown)` checks that the text is JSON, not what it holds"]
        : []

export const noUnknownJson = {
  id: "effect/no-unknown-json",
  defaultSeverity: "error",
  description: "a decoded value has a schema: no `Record(String, Unknown)`, no `fromJsonString(Unknown)`",
  fixHint:
    "decode the shape you read (`Schema.Struct`, `Schema.Record(Schema.String, S)`); `Schema.Json` or `Schema.JsonObject` (`Schema.fromJsonString(Schema.JsonObject)`) for JSON that stays open; writing an open value as text may use `Schema.encode*(Schema.fromJsonString(Schema.Unknown))`",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) =>
      openSchemaMessage(node).flatMap((message) => (isEncoded(node) ? [] : [{ node, message }])),
    ),
}

/** `Name<…>` with `Name` a plain identifier: its type arguments, or none. */
const typeArgumentsOf = (type: ts.TypeNode, name: string): ReadonlyArray<ts.TypeNode> =>
  ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === name
    ? (type.typeArguments ?? [])
    : []

const OPEN_VALUES: ReadonlyArray<ts.SyntaxKind> = [ts.SyntaxKind.UnknownKeyword, ts.SyntaxKind.AnyKeyword]

/** What a cast to `type` asserts, past parentheses and `Readonly<…>`: an open record or an object type literal. */
const assertedShape = (type: ts.TypeNode): ReadonlyArray<string> => {
  if (ts.isParenthesizedTypeNode(type)) return assertedShape(type.type)
  const readonly = typeArgumentsOf(type, "Readonly")
  if (readonly.length === 1) return readonly.flatMap(assertedShape)
  if (ts.isTypeLiteralNode(type)) return ["`as { … }` asserts an object shape that nothing checked"]
  const [key, value] = typeArgumentsOf(type, "Record")
  return key?.kind === ts.SyntaxKind.StringKeyword && value !== undefined && OPEN_VALUES.includes(value.kind)
    ? [`\`as Record<string, ${value.kind === ts.SyntaxKind.AnyKeyword ? "any" : "unknown"}>\` asserts an object that nothing checked`]
    : []
}

export const noRecordCast = {
  id: "effect/no-record-cast",
  defaultSeverity: "error",
  description: "an object read from outside is decoded, never cast to `Record<string, unknown>` or `{ … }`",
  fixHint:
    "decode it (`Schema.decodeUnknownOption(Schema.Struct({ … }))`, `Schema.JsonObject`), narrow with `Predicate.hasProperty`/`Predicate.isObject`, or fix the type at its source",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) =>
      ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
        ? assertedShape(node.type).map((message) => ({ node, message }))
        : [],
    ),
}

/** The keys effect/ai's providers file their metadata and options under, and the one a model router kept its own fields under. */
const PROVIDER_NAMESPACES: ReadonlyArray<string> = ["anthropic", "openai", "google", "router"]

/** A key written as a name, a string or a computed string: `anthropic`, `"anthropic"`, `["anthropic"]`. */
const keyText = (name: ts.Node): ReadonlyArray<string> =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name)
    ? [name.text]
    : ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)
      ? [name.expression.text]
      : []

/** The key a node names: an object literal's or a type's property, a destructured property, a property read. */
const keysOf = (node: ts.Node): ReadonlyArray<string> => {
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isPropertySignature(node)) {
    return keyText(node.name)
  }
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) return keyText(node.propertyName ?? node.name)
  if (ts.isPropertyAccessExpression(node)) return keyText(node.name)
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return [node.argumentExpression.text]
  return []
}

export const noProviderNamespace = {
  id: "effect/no-provider-namespace",
  defaultSeverity: "error",
  description: "provider-neutral code never names a provider's namespace (`anthropic`, `openai`, `google`, `router`)",
  fixHint:
    "carry provider metadata and options opaque (effect/ai's `ProviderMetadata` and `ProviderOptions`), keep code for one provider in that provider's adapter, and put your own fields under your own key",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) =>
      keysOf(node)
        .filter((key) => PROVIDER_NAMESPACES.includes(key))
        .map((key) => ({ node, message: `\`${key}\` names a provider's namespace` })),
    ),
}

const isEffectLog = (callee: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(callee) &&
  ts.isIdentifier(callee.expression) &&
  callee.expression.text === "Effect" &&
  /^log(?:[A-Z]\w*)?$/.test(callee.name.text)

const inLogArgument = (node: ts.Node): boolean => {
  const parent = node.parent
  if (ts.isCallExpression(parent) && parent.arguments.some((argument) => argument === node)) {
    return isEffectLog(parent.expression) || inLogArgument(parent)
  }
  return !ts.isFunctionLike(parent) && (ts.isExpression(parent) || ts.isTemplateSpan(parent)) ? inLogArgument(parent) : false
}

export const noCausePrettyData = {
  id: "effect/no-cause-pretty-data",
  defaultSeverity: "error",
  description: "`Cause.pretty` text goes to `Effect.log*` only, never into data",
  fixHint:
    "log the cause (`Effect.logError(\"…\", cause)`, or `Cause.pretty` inside the `Effect.log*` call); data keeps `Cause.prettyErrors(cause)` messages or a reason string",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) =>
      isMemberOf(node, "Cause", ["pretty"]) && !inLogArgument(node)
        ? [{ node, message: "`Cause.pretty` text (stack frames, file paths) kept as data" }]
        : [],
    ),
}

export const noEffectPromise = {
  id: "effect/no-effect-promise",
  defaultSeverity: "error",
  description: "foreign promises enter through `Effect.tryPromise`, never `Effect.promise`",
  fixHint:
    "use `Effect.tryPromise({ try, catch })` with a typed error, and log or handle the failure where it is expected",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) =>
      isMemberOf(node, "Effect", ["promise"])
        ? [{ node, message: "`Effect.promise` turns a rejection into a defect" }]
        : [],
    ),
}

export const noPromiseAll = {
  id: "effect/no-promise-all",
  defaultSeverity: "error",
  description: "concurrent work is an Effect with a stated `concurrency`, never `Promise.all`",
  fixHint:
    "use `Effect.forEach(items, f, { concurrency })` or `Effect.all(effects, { concurrency })`, each foreign promise wrapped in `Effect.tryPromise`",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) =>
      isMemberOf(node, "Promise", ["all", "allSettled"])
        ? [{ node, message: `\`Promise.${node.name.text}\` runs unbounded and cannot be interrupted` }]
        : [],
    ),
}

const namesBufferSize = (checker: ts.TypeChecker, options: ts.Expression): boolean =>
  ts.isObjectLiteralExpression(options) && !options.properties.some(ts.isSpreadAssignment)
    ? options.properties.some((property) => property.name !== undefined && ts.isIdentifier(property.name) && property.name.text === "bufferSize")
    : checker.getTypeAtLocation(options).getProperty("bufferSize") !== undefined

export const callbackBufferSize = {
  id: "effect/callback-buffer-size",
  defaultSeverity: "error",
  description: "`Stream.callback` states its `bufferSize`",
  fixHint:
    "pass `{ bufferSize }` (and a `strategy` if dropping is acceptable) as the second argument, so a slow reader holds the producer back",
  check: ({ sourceFile, checker }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !isMemberOf(node.expression, "Stream", ["callback"])) return []
      const options = node.arguments[1]
      return options !== undefined && namesBufferSize(checker, options)
        ? []
        : [{ node, message: "`Stream.callback` without a `bufferSize` buffers without bound" }]
    }),
}

const isInfiniteCapacity = (capacity: ts.Expression): boolean =>
  ts.isObjectLiteralExpression(capacity)
    ? capacity.properties.some((property) =>
        ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "capacity" && isInfiniteCapacity(property.initializer))
    : (ts.isIdentifier(capacity) && capacity.text === "Infinity") || isMemberOf(capacity, "Number", ["POSITIVE_INFINITY"])

export const boundedPubSub = {
  id: "effect/bounded-pubsub",
  defaultSeverity: "error",
  description: "a `PubSub` states a finite capacity: `bounded`, `sliding` or `dropping`, never `unbounded`",
  fixHint:
    "create it with a capacity: `PubSub.sliding(n)` when only the latest messages matter (a wake-up signal: `sliding(1)`), `PubSub.bounded(n)` when the publisher may wait for the slowest subscriber, `PubSub.dropping(n)` when the newest may be lost",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) => {
      if (isMemberOf(node, "PubSub", ["unbounded"])) {
        return [{ node, message: "`PubSub.unbounded` keeps every message a slow subscriber has not taken" }]
      }
      if (!ts.isCallExpression(node) || !isMemberOf(node.expression, "PubSub", ["bounded", "sliding", "dropping"])) return []
      const capacity = node.arguments[0]
      return capacity !== undefined && isInfiniteCapacity(capacity)
        ? [{ node, message: `\`PubSub.${node.expression.name.text}\` with an infinite capacity keeps every message a slow subscriber has not taken` }]
        : []
    }),
}

export const noProcessEnv = {
  id: "effect/no-process-env",
  defaultSeverity: "error",
  description: "the environment is read through `Config`; only the process edge reads `process.env`",
  fixHint:
    "read the variable with `Config` (`Config.String(name)`, `Config.Redacted(name)`, `Config.option`) so a ConfigProvider can supply it; only a `main.ts` edge, or an adapter the profile names, reads `process.env` itself",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) =>
      isMemberOf(node, "process", ["env"])
        ? [{ node, message: "`process.env` is an ambient dependency the types do not show" }]
        : [],
    ),
}

const ambientMatch = (node: ts.Node): ReadonlyArray<VendoredMatch> => {
  if (isMemberOf(node, "Date", ["now"])) return [{ node, message: "`Date.now` reads the wall clock" }]
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date" && (node.arguments ?? []).length === 0) {
    return [{ node, message: "`new Date()` reads the wall clock" }]
  }
  if (isMemberOf(node, "Math", ["random"])) return [{ node, message: "`Math.random` is a generator no seed or test controls" }]
  if (
    (ts.isPropertyAccessExpression(node) && node.name.text === "randomUUID") ||
    (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "randomUUID")
  ) {
    return [{ node, message: "`randomUUID` is a generator no seed or test controls" }]
  }
  return []
}

export const noAmbientTimeRandom = {
  id: "effect/no-ambient-time-random",
  defaultSeverity: "error",
  description: "time comes from `Clock` and randomness from `Random`, outside adapters",
  fixHint:
    "read the time with `Clock.currentTimeMillis` (or `DateTime.now`) and draw from `Random`, so a TestClock or a seed drives them; only an adapter (`*.adapter.ts`) touches the platform clock and generator",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> => matchesIn(sourceFile, ambientMatch),
}

export const noLocaleCompare = {
  id: "effect/no-locale-compare",
  defaultSeverity: "error",
  description: "strings are ordered with `Order.String`, never the host's locale",
  fixHint: "compare with `Order.String` (code-unit order, the same on every host), e.g. `Arr.sort(xs, Order.String)`",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) =>
      ts.isPropertyAccessExpression(node) && node.name.text === "localeCompare"
        ? [{ node, message: "`localeCompare` depends on the host's locale" }]
        : [],
    ),
}

export const requireSortComparator = {
  id: "effect/require-sort-comparator",
  defaultSeverity: "error",
  description: "every sort names its order",
  fixHint: "pass the order: `Arr.sort(xs, Order.String)` / `Order.Number`, or a comparator `(a, b) => …`",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) =>
      isMethodCall(node, ["sort", "toSorted"]) && node.arguments.length === 0
        ? [{ node, message: "`.sort()` without a comparator orders elements as strings" }]
        : [],
    ),
}

const isTaggedClass = (checker: ts.TypeChecker, expression: ts.Expression): boolean =>
  checker
    .getTypeAtLocation(expression)
    .getConstructSignatures()
    .some((signature) => signature.getReturnType().getProperty("_tag") !== undefined)

export const noInstanceofTaggedError = {
  id: "effect/no-instanceof-tagged-error",
  defaultSeverity: "error",
  description: "tagged errors are recognized by their tag, never `instanceof`",
  fixHint:
    "use the owning module's guard (`isHarnessError`), `Predicate.isTagged(e, \"X\")`, `Match.tag` or `Effect.catchTag`; not `Schema.is(X)` of the class, which checks identity too",
  check: ({ sourceFile, checker }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      isTaggedClass(checker, node.right)
        ? [{ node, message: `\`instanceof ${node.right.getText(sourceFile)}\` checks identity; a decoded or second-copy error fails it` }]
        : [],
    ),
}

const logs = (node: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Effect" &&
    /^log(?:[A-Z]\w*)?$/.test(node.name.text)) ||
  (ts.forEachChild(node, (child) => (logs(child) ? true : undefined)) ?? false)

const isLoggingTap = (step: ts.Expression): boolean =>
  ts.isCallExpression(step) &&
  ts.isPropertyAccessExpression(step.expression) &&
  ts.isIdentifier(step.expression.expression) &&
  step.expression.expression.text === "Effect" &&
  /^(?:tap(?:Error|Cause|Defect)\w*|onError\w*|onExit)$/.test(step.expression.name.text) &&
  logs(step)

const isPipe = (call: ts.CallExpression): boolean =>
  (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "pipe") ||
  (ts.isIdentifier(call.expression) && call.expression.text === "pipe")

const loggedBefore = (step: ts.Expression): boolean => {
  const parent = step.parent
  if (ts.isCallExpression(parent) && isPipe(parent)) {
    const index = parent.arguments.findIndex((argument) => argument === step)
    return parent.arguments.slice(0, Math.max(index, 0)).some(isLoggingTap)
  }
  const subject = ts.isCallExpression(step) ? step.arguments[0] : undefined
  return subject !== undefined && ts.isCallExpression(subject) && isPipe(subject) && subject.arguments.some(isLoggingTap)
}

const stepOf = (access: ts.PropertyAccessExpression): ts.Expression =>
  ts.isCallExpression(access.parent) && access.parent.expression === access ? access.parent : access

const statesLog = (checker: ts.TypeChecker, argument: ts.Expression): boolean => {
  const options = unparenthesized(argument)
  if (ts.isObjectLiteralExpression(options) && !options.properties.some(ts.isSpreadAssignment)) {
    return options.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "log" &&
        property.initializer.kind !== ts.SyntaxKind.FalseKeyword &&
        !(ts.isIdentifier(property.initializer) && property.initializer.text === "undefined"),
    )
  }
  return !ts.isObjectLiteralExpression(options) && checker.getTypeAtLocation(options).getProperty("log") !== undefined
}

const answersVoid = (handler: ts.Expression | undefined): boolean => {
  if (handler === undefined) return false
  const fn = unparenthesized(handler)
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  const only = ts.isBlock(fn.body) ? fn.body.statements[0] : undefined
  const returned = ts.isBlock(fn.body)
    ? fn.body.statements.length === 1 && only !== undefined && ts.isReturnStatement(only) ? only.expression : undefined
    : fn.body
  return returned !== undefined && isMemberOf(unparenthesized(returned), "Effect", ["void"])
}

const silentMatch = (checker: ts.TypeChecker, node: ts.Node): ReadonlyArray<VendoredMatch> => {
  if (!isMemberOf(node, "Effect", ["ignore", "ignoreCause", "catch", "catchCause", "orElseSucceed"])) return []
  const member = node.name.text
  const step = stepOf(node)
  const args = ts.isCallExpression(step) ? step.arguments : []
  if (member === "ignore" || member === "ignoreCause") {
    return args.some((argument) => statesLog(checker, argument)) || loggedBefore(step)
      ? []
      : [{ node, message: `\`Effect.${member}\` drops the failure without logging it` }]
  }
  if (member === "catch" || member === "catchCause") {
    return answersVoid(args[args.length - 1]) && !loggedBefore(step)
      ? [{ node, message: `\`Effect.${member}(() => Effect.void)\` drops the failure without logging it` }]
      : []
  }
  return loggedBefore(step) ? [] : [{ node, message: "`Effect.orElseSucceed` replaces the failure without logging it" }]
}

export const noSilentIgnore = {
  id: "effect/no-silent-ignore",
  defaultSeverity: "error",
  description: "a failure that is dropped is logged first",
  fixHint:
    "log what is dropped: `Effect.ignore({ log: \"Warn\", message: \"what was lost\" })` (`ignoreCause` likewise; `\"Debug\"` for an expected miss), or an `Effect.tapError`/`Effect.tapCause` step that calls `Effect.log*` earlier in the same pipe; or recover only the expected failure with `Effect.catchTag`/`Effect.catchIf`",
  check: ({ sourceFile, checker }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) => silentMatch(checker, node)),
}

const isFailureValue = (checker: ts.TypeChecker, expression: ts.Expression): boolean => {
  const type = checker.getTypeAtLocation(expression)
  const failureLike = (part: ts.Type): boolean =>
    (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
    (part.flags & ts.TypeFlags.Object) !== 0 &&
      ["message", "_tag", "reasons"].some((name) => part.getProperty(name) !== undefined)
  return type.isUnion() ? type.types.some(failureLike) : failureLike(type)
}

const stringified = (sourceFile: ts.SourceFile, checker: ts.TypeChecker, node: ts.Node): ReadonlyArray<VendoredMatch> => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "String") {
    const [argument] = node.arguments
    return argument !== undefined && isFailureValue(checker, argument)
      ? [{ node, message: `\`String(${argument.getText(sourceFile)})\` keeps only the text of the failure it wraps` }]
      : []
  }
  if (ts.isTemplateSpan(node) && isFailureValue(checker, node.expression)) {
    return [{ node: node.expression, message: `\`\${${node.expression.getText(sourceFile)}}\` keeps only the text of the failure it wraps` }]
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [node.left, node.right].some(
      (side) => !ts.isStringLiteralLike(side) && !ts.isTemplateExpression(side) && isFailureValue(checker, side),
    )
      ? [{ node, message: "a failure concatenated into a string keeps only its text" }]
      : []
  }
  return []
}

const stringifiedUnder = (sourceFile: ts.SourceFile, checker: ts.TypeChecker, node: ts.Node): ReadonlyArray<VendoredMatch> => {
  if (ts.isFunctionLike(node)) return []
  const nested: Array<VendoredMatch> = []
  ts.forEachChild(node, (child) => {
    nested.push(...stringifiedUnder(sourceFile, checker, child))
  })
  return [...stringified(sourceFile, checker, node), ...nested]
}

export const noStringifiedCause = {
  id: "effect/no-stringified-cause",
  defaultSeverity: "error",
  description: "a tagged error keeps the failure it wraps as a value, not as `String(e)`",
  fixHint:
    "keep the failure as a value (a `cause` field, `Schema.Defect`) and write a message that says what failed; text for a person or the model comes from `reasonOf(cause)` or a decoded error's own `message`",
  check: ({ sourceFile, checker }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) =>
      ts.isNewExpression(node) && isTaggedClass(checker, node.expression)
        ? (node.arguments ?? []).flatMap((argument) => stringifiedUnder(sourceFile, checker, argument))
        : [],
    ),
}

const isEquality = (kind: ts.SyntaxKind): boolean =>
  kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
  kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
  kind === ts.SyntaxKind.EqualsEqualsToken ||
  kind === ts.SyntaxKind.ExclamationEqualsToken

const isCodeAccess = (node: ts.Expression): node is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(node) && node.name.text === "code"

const ownersOf = (checker: ts.TypeChecker, access: ts.PropertyAccessExpression): ReadonlyArray<string> => {
  const files = (checker.getSymbolAtLocation(access.name)?.declarations ?? []).map(
    (declaration) => declaration.getSourceFile().fileName,
  )
  return files.some((file) => file.endsWith(".d.ts") || /[\\/]node_modules[\\/]/.test(file)) ? [] : files
}

export const noErrorCodeCompare = {
  id: "effect/no-error-code-compare",
  defaultSeverity: "error",
  description: "an error code is compared only in the module that declares the error",
  fixHint:
    "ask the owning module: a guard it exports (`isTurnClosed(error)`), or a tagged error for that case handled with `Effect.catchTag`/`Match.tag`",
  check: ({ sourceFile, checker }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) => {
      if (!ts.isBinaryExpression(node) || !isEquality(node.operatorToken.kind)) return []
      const access = isCodeAccess(node.left) && ts.isStringLiteralLike(node.right)
        ? node.left
        : isCodeAccess(node.right) && ts.isStringLiteralLike(node.left)
          ? node.right
          : undefined
      if (access === undefined) return []
      const owners = ownersOf(checker, access)
      const here = sourceFile.fileName
      return owners.length === 0 || owners.some((owner) => here === owner || here === owner.replace(/\.ts$/, ".functions.ts"))
        ? []
        : [{ node, message: `\`${node.getText(sourceFile)}\` compares a code another module declares` }]
    }),
}

type FunctionBody = ts.ConciseBody | undefined

const onlyReturnsGen = (body: FunctionBody): boolean => {
  if (body === undefined) return false
  const only = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : undefined
  const returned = ts.isBlock(body)
    ? only !== undefined && ts.isReturnStatement(only) ? only.expression : undefined
    : body
  if (returned === undefined) return false
  const call = unparenthesized(returned)
  return ts.isCallExpression(call) && isMemberOf(call.expression, "Effect", ["gen"])
}

const bodyOf = (node: ts.Expression | undefined): FunctionBody => {
  const fn = node === undefined ? undefined : unparenthesized(node)
  return fn !== undefined && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn.body : undefined
}

const isServiceObject = (literal: ts.ObjectLiteralExpression): boolean => {
  const parent = ts.isParenthesizedExpression(literal.parent) ? literal.parent.parent : literal.parent
  if (!ts.isCallExpression(parent) || parent.expression === literal) return true
  const callee = parent.expression
  return ts.isPropertyAccessExpression(callee) && (callee.name.text === "of" || callee.name.text === "succeed")
}

const preferFnMatch = (node: ts.Node): ReadonlyArray<VendoredMatch> => {
  if (ts.isFunctionDeclaration(node) && isExported(node) && node.name !== undefined && onlyReturnsGen(node.body)) {
    return [{ node, message: `exported function \`${node.name.text}\` only returns \`Effect.gen\`` }]
  }
  if (ts.isVariableStatement(node) && isExported(node)) {
    return node.declarationList.declarations.flatMap((declaration) =>
      onlyReturnsGen(bodyOf(declaration.initializer)) && ts.isIdentifier(declaration.name)
        ? [{ node: declaration, message: `exported function \`${declaration.name.text}\` only returns \`Effect.gen\`` }]
        : [],
    )
  }
  if (ts.isObjectLiteralExpression(node) && isServiceObject(node)) {
    return node.properties.flatMap((property) => {
      const name = property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : "method"
      const generated =
        (ts.isPropertyAssignment(property) && onlyReturnsGen(bodyOf(property.initializer))) ||
        (ts.isMethodDeclaration(property) && onlyReturnsGen(property.body))
      return generated ? [{ node: property, message: `service method \`${name}\` only returns \`Effect.gen\`` }] : []
    })
  }
  return []
}

export const preferEffectFn = {
  id: "effect/prefer-effect-fn",
  defaultSeverity: "error",
  description: "exported functions and service methods that only return `Effect.gen` are `Effect.fn`",
  fixHint:
    "write it as `Effect.fn(\"area.op\")(function* (…) { … })`, named like the spans `agent.turn` and `engine.run`; a hot helper called per item uses `Effect.fnUntraced(function* (…) { … })`",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> => matchesIn(sourceFile, preferFnMatch),
}

const namesConcurrency = (checker: ts.TypeChecker, options: ts.Expression): boolean =>
  ts.isObjectLiteralExpression(options) && !options.properties.some(ts.isSpreadAssignment)
    ? options.properties.some((property) => property.name !== undefined && ts.isIdentifier(property.name) && property.name.text === "concurrency")
    : checker.getTypeAtLocation(options).getProperty("concurrency") !== undefined

const atMostOne = (collection: ts.Expression | undefined): boolean =>
  collection !== undefined &&
  ((ts.isArrayLiteralExpression(collection) && collection.elements.length <= 1 && !collection.elements.some(ts.isSpreadElement)) ||
    (ts.isObjectLiteralExpression(collection) && collection.properties.length <= 1 && !collection.properties.some(ts.isSpreadAssignment)))

const forEachParts = (checker: ts.TypeChecker, call: ts.CallExpression): { readonly items: ts.Expression | undefined; readonly options: ts.Expression | undefined } => {
  const [first, second, third] = call.arguments
  const dataLast = first !== undefined && checker.getTypeAtLocation(first).getCallSignatures().length > 0
  return dataLast ? { items: undefined, options: second } : { items: first, options: third }
}

const concurrencyMatch = (checker: ts.TypeChecker, node: ts.Node): ReadonlyArray<VendoredMatch> => {
  if (!ts.isCallExpression(node) || !isMemberOf(node.expression, "Effect", ["forEach", "all"])) return []
  const { items, options } = node.expression.name.text === "forEach"
    ? forEachParts(checker, node)
    : { items: node.arguments[0], options: node.arguments[1] }
  return atMostOne(items) || (options !== undefined && namesConcurrency(checker, options))
    ? []
    : [{ node, message: `\`Effect.${node.expression.name.text}\` does not state its \`concurrency\`` }]
}

export const requireConcurrencyOption = {
  id: "effect/require-concurrency-option",
  defaultSeverity: "error",
  description: "`Effect.forEach` and `Effect.all` state their `concurrency`",
  fixHint:
    "pass `{ concurrency }`: `1` when the effects must run in order, a number or a config value (`digestConcurrency`) for I/O, `\"unbounded\"` only over a small fixed set",
  check: ({ sourceFile, checker }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) => concurrencyMatch(checker, node)),
}

export const noOptionUnwrap = {
  id: "effect/no-option-unwrap",
  defaultSeverity: "error",
  description: "an `Option` stays an `Option` until an adapter hands it to a foreign API or the wire",
  fixHint:
    "keep the `Option`: `Option.match`, `Option.map`, `Option.getOrElse` with a real default, or an optional field spread from `Option.match`; unwrap to `null`/`undefined` only in a `*.adapter.ts` that writes to the wire or calls a foreign API",
  check: ({ sourceFile }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) =>
      isMemberOf(node, "Option", ["getOrNull", "getOrUndefined"])
        ? [{ node, message: `\`Option.${node.name.text}\` turns absence back into a nullable` }]
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
  noAsNever,
  noUnknownRequirements,
  brandedIdFields,
  noParallelInterface,
  noJsonParse,
  noSyncCodec,
  noUnknownJson,
  noRecordCast,
  noProviderNamespace,
  noCausePrettyData,
  noEffectPromise,
  noPromiseAll,
  callbackBufferSize,
  boundedPubSub,
  noProcessEnv,
  noAmbientTimeRandom,
  noLocaleCompare,
  requireSortComparator,
  noInstanceofTaggedError,
  noSilentIgnore,
  noStringifiedCause,
  noErrorCodeCompare,
  preferEffectFn,
  requireConcurrencyOption,
  noOptionUnwrap,
]
