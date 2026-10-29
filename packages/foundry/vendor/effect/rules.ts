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
    "Match.value(x).pipe(Match.tag(…), Match.exhaustive) — or Option.match / Result.match / Exit.match",
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
    "decode with `Schema.decodeUnknownEffect(Schema.fromJsonString(S))` (`decodeUnknownResult`/`decodeUnknownOption` in pure code); `Schema.fromJsonString(Schema.Unknown)` when the shape is open",
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
    "use `Schema.is(X)`, the owning module's guard (`isHarnessError`), `Predicate.isTagged(e, \"X\")`, `Match.tag` or `Effect.catchTag`",
  check: ({ sourceFile, checker }: VendoredRuleContext): ReadonlyArray<VendoredMatch> =>
    matchesIn(sourceFile, (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      isTaggedClass(checker, node.right)
        ? [{ node, message: `\`instanceof ${node.right.getText(sourceFile)}\` checks identity; a decoded or second-copy error fails it` }]
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
  brandedIdFields,
  noParallelInterface,
  noJsonParse,
  noSyncCodec,
  noCausePrettyData,
  noEffectPromise,
  noPromiseAll,
  callbackBufferSize,
  noProcessEnv,
  noAmbientTimeRandom,
  noLocaleCompare,
  requireSortComparator,
  noInstanceofTaggedError,
]
