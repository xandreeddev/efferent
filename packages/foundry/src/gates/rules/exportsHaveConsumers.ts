import { Array as Arr, Option, Order, Predicate, Result, Schema } from "effect"
import * as path from "node:path"
import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule, RuleMatch, RuleWorkspace } from "../idiomGate.js"
import { toWorkspacePath, walk } from "../astWalk.js"

/**
 * A package entry's exports are its contract, so each one is either used
 * by first-party code or documented host API (`@public`). The files the
 * rule's include names are judged as entries of the package whose
 * package.json holds them; a file no `exports` subpath points at is itself
 * a finding.
 *
 * A use is an import of the name by a specifier of that entry: named,
 * default, a namespace member (`ns.Name`), `import("…").Name`, or a named
 * re-export. It counts in another package's source, in a file under
 * `scripts/`, and in a TypeScript or JavaScript code block of the
 * workspace's markdown (but a changelog's, which records the API as each
 * release had it). `export * from` names nothing, so it is no use, and an
 * entry may not hold one. A `@deprecated` export needs no use, and fails
 * while first-party code still has one.
 *
 * The consumers are the whole workspace, not the checked file: the rule
 * builds one index of every use per gate run (the gate hands each call of
 * a run the same `workspace`), reading the scripts and the markdown, which
 * the program does not hold, through the compiler's own `ts.sys`.
 */

/** Where a use was found: a program file counts outside the entry's own
 *  package only; a script or a doc code block counts wherever it is. */
type Origin = "source" | "script" | "doc"

interface Use {
  readonly specifier: string
  readonly name: string
  /** Absolute path of the file holding the use. */
  readonly file: string
  /** Workspace-relative `path:line`. */
  readonly where: string
  readonly origin: Origin
}

interface Place {
  readonly file: string
  readonly origin: Origin
  /** The `path:line` of a 0-based line of the parsed code. */
  readonly where: (line: number) => string
}

type UseIndex = ReadonlyMap<string, ReadonlyArray<Use>>

const keyOf = (specifier: string, name: string): string => `${specifier}\n${name}`

const leftmost = (name: ts.EntityName): ts.Identifier => (ts.isIdentifier(name) ? name : leftmost(name.left))

/** The names a statement imports or re-exports by name, per specifier. */
const statementUses = (statement: ts.Statement, use: (specifier: string, name: string, node: ts.Node) => Use): ReadonlyArray<Use> => {
  if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) return []
  if (statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) return []
  const specifier = statement.moduleSpecifier.text
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause
    return clause !== undefined && ts.isNamedExports(clause)
      ? clause.elements.map((element) => use(specifier, (element.propertyName ?? element.name).text, element))
      : []
  }
  const clause = statement.importClause
  const bindings = clause?.namedBindings
  return [
    ...(clause?.name === undefined ? [] : [use(specifier, "default", clause.name)]),
    ...(bindings !== undefined && ts.isNamedImports(bindings)
      ? bindings.elements.map((element) => use(specifier, (element.propertyName ?? element.name).text, element))
      : []),
  ]
}

/** Each local name a namespace import binds → its specifier. */
const namespacesOf = (code: ts.SourceFile): ReadonlyMap<string, string> =>
  new Map(
    code.statements.flatMap((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return []
      const bindings = statement.importClause?.namedBindings
      return bindings !== undefined && ts.isNamespaceImport(bindings)
        ? [[bindings.name.text, statement.moduleSpecifier.text] as const]
        : []
    }),
  )

/** The uses only a walk finds: `ns.Name` of a namespace import (in values
 *  and in types), and `import("…").Name`. */
const walkedUses = (
  code: ts.SourceFile,
  namespaces: ReadonlyMap<string, string>,
  use: (specifier: string, name: string, node: ts.Node) => Use,
): ReadonlyArray<Use> => {
  const found: Array<Use> = []
  walk(code, (node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const specifier = namespaces.get(node.expression.text)
      if (specifier !== undefined) found.push(use(specifier, node.name.text, node))
    }
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left)) {
      const specifier = namespaces.get(node.left.text)
      if (specifier !== undefined) found.push(use(specifier, node.right.text, node))
    }
    if (
      ts.isImportTypeNode(node) &&
      node.qualifier !== undefined &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      found.push(use(node.argument.literal.text, leftmost(node.qualifier).text, node))
    }
  })
  return found
}

const usesIn = (code: ts.SourceFile, place: Place): ReadonlyArray<Use> => {
  const use = (specifier: string, name: string, node: ts.Node): Use => ({
    specifier,
    name,
    file: place.file,
    origin: place.origin,
    where: place.where(code.getLineAndCharacterOfPosition(node.getStart(code)).line),
  })
  const namespaces = namespacesOf(code)
  return [
    ...code.statements.flatMap((statement) => statementUses(statement, use)),
    ...(namespaces.size > 0 || code.text.includes("import(") ? walkedUses(code, namespaces, use) : []),
  ]
}

const SCRIPT_KINDS: ReadonlyMap<string, ts.ScriptKind> = new Map([
  [".ts", ts.ScriptKind.TS],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
  [".js", ts.ScriptKind.JS],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
])

/** The languages of the code blocks read, as a fence names them. */
const BLOCK_KINDS: ReadonlyMap<string, ts.ScriptKind> = new Map([
  ["ts", ts.ScriptKind.TS],
  ["typescript", ts.ScriptKind.TS],
  ["mts", ts.ScriptKind.TS],
  ["cts", ts.ScriptKind.TS],
  ["tsx", ts.ScriptKind.TSX],
  ["js", ts.ScriptKind.JS],
  ["javascript", ts.ScriptKind.JS],
  ["mjs", ts.ScriptKind.JS],
  ["cjs", ts.ScriptKind.JS],
  ["jsx", ts.ScriptKind.JSX],
])

const CODE_BLOCK = /^[ \t]*```([A-Za-z]+)[^\n]*\n([\s\S]*?)^[ \t]*```/gm

interface CodeBlock {
  readonly code: string
  readonly kind: ts.ScriptKind
  /** The 1-based line of the block's first line of code. */
  readonly firstLine: number
}

const codeBlocks = (text: string): ReadonlyArray<CodeBlock> =>
  Array.from(text.matchAll(CODE_BLOCK)).flatMap((match) =>
    Option.match(Option.fromNullishOr(BLOCK_KINDS.get((match[1] ?? "").toLowerCase())), {
      onNone: () => [],
      onSome: (kind) => [{ code: match[2] ?? "", kind, firstLine: text.slice(0, match.index).split("\n").length + 1 }],
    }),
  )

const readText = (file: string): Option.Option<string> => Option.fromNullishOr(ts.sys.readFile(file))

/** Every script under `<root>/scripts` (`ts.sys.readDirectory` skips
 *  `node_modules` and dot-directories), in a stable order. */
const scriptFiles = (rootDir: string): ReadonlyArray<string> =>
  Arr.sort(
    ts.sys
      .readDirectory(path.join(rootDir, "scripts"), [...SCRIPT_KINDS.keys()], undefined, ["**/*"])
      .filter((file) => !/\.d\.[cm]?ts$/.test(file)),
    Order.String,
  )

/** Every markdown file of the workspace but a changelog. */
const docFiles = (rootDir: string): ReadonlyArray<string> =>
  Arr.sort(
    ts.sys
      .readDirectory(rootDir, [".md", ".mdx"], undefined, ["**/*"])
      .filter((file) => path.basename(file).toLowerCase() !== "changelog.md"),
    Order.String,
  )

const buildIndex = (workspace: RuleWorkspace): UseIndex => {
  const lineOf = (file: string) => (line: number) => `${toWorkspacePath(workspace.rootDir, file)}:${line + 1}`
  const inProgram = new Set(workspace.sourceFiles.map((sourceFile) => sourceFile.fileName))
  const sources = workspace.sourceFiles.flatMap((sourceFile) =>
    usesIn(sourceFile, { file: sourceFile.fileName, origin: "source", where: lineOf(sourceFile.fileName) }),
  )
  const scripts = scriptFiles(workspace.rootDir)
    .filter((file) => !inProgram.has(file))
    .flatMap((file) =>
      Option.match(readText(file), {
        onNone: () => [],
        onSome: (text) =>
          usesIn(
            ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS.get(path.extname(file)) ?? ts.ScriptKind.TS),
            { file, origin: "script", where: lineOf(file) },
          ),
      }),
    )
  const docs = docFiles(workspace.rootDir).flatMap((file) =>
    Option.match(readText(file), {
      onNone: () => [],
      onSome: (text) =>
        codeBlocks(text).flatMap((block) =>
          usesIn(ts.createSourceFile(file, block.code, ts.ScriptTarget.Latest, true, block.kind), {
            file,
            origin: "doc",
            where: (line) => `${toWorkspacePath(workspace.rootDir, file)}:${block.firstLine + line}`,
          }),
        ),
    }),
  )
  return new Map(Object.entries(Arr.groupBy([...sources, ...scripts, ...docs], (use) => keyOf(use.specifier, use.name))))
}

/** One index per gate run, keyed by the run's workspace object. */
const indexes = new WeakMap<RuleWorkspace, UseIndex>()

const indexOf = (workspace: RuleWorkspace): UseIndex =>
  Option.getOrElse(Option.fromNullishOr(indexes.get(workspace)), () => {
    const built = buildIndex(workspace)
    indexes.set(workspace, built)
    return built
  })

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.NonEmptyString,
    main: Schema.OptionFromOptional(Schema.String),
    exports: Schema.OptionFromOptional(Schema.Json),
  }),
)

const decodeManifest = Schema.decodeUnknownOption(Manifest)

interface Entry {
  /** Absolute directory of the entry's package. */
  readonly packageDir: string
  /** The bare specifiers that import the entry: `@scope/pkg`, `@scope/pkg/sub`. */
  readonly specifiers: ReadonlyArray<string>
}

/** `file` is strictly inside `dir`. */
const isWithin = (dir: string, file: string): boolean => {
  const rel = path.relative(dir, file)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/** The nearest directory at or above `dir`, inside the workspace, that holds a package.json. */
const packageDirOf = (dir: string, rootDir: string): Option.Option<string> =>
  ts.sys.fileExists(path.join(dir, "package.json"))
    ? Option.some(dir)
    : isWithin(rootDir, dir)
      ? packageDirOf(path.dirname(dir), rootDir)
      : Option.none()

/** The paths an export value names: a string, or the strings under its
 *  conditions and fallbacks (`null` blocks a subpath, so names none). */
const targetsOf = (value: unknown): ReadonlyArray<string> =>
  Predicate.isString(value)
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(targetsOf)
      : Predicate.isObject(value)
        ? Object.values(value).flatMap(targetsOf)
        : []

interface Subpath {
  /** `.`, `./sub` or a pattern `./sub/*`. */
  readonly key: string
  readonly targets: ReadonlyArray<string>
}

const subpathsOf = (main: Option.Option<string>, exports: Option.Option<Schema.Json>): ReadonlyArray<Subpath> =>
  Option.match(exports, {
    onNone: (): ReadonlyArray<Subpath> =>
      Option.match(main, { onNone: () => [], onSome: (file) => [{ key: ".", targets: [file] }] }),
    onSome: (value): ReadonlyArray<Subpath> =>
      Predicate.isObject(value) && Object.keys(value).some((key) => key.startsWith("."))
        ? Object.entries(value).map(([key, conditions]) => ({ key, targets: targetsOf(conditions) }))
        : [{ key: ".", targets: targetsOf(value) }],
  })

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The subpaths `subpath` maps onto `relPath` (package-relative): its key
 *  for an exact target, its key with the `*` filled in for a pattern. */
const keysFor = (subpath: Subpath, relPath: string): ReadonlyArray<string> =>
  subpath.targets.flatMap((target) => {
    const normalized = path.posix.normalize(target)
    if (!normalized.includes("*")) return normalized === relPath ? [subpath.key] : []
    const pattern = new RegExp(`^${normalized.split("*").map(escapeRegExp).join("(.+)")}$`)
    return Option.match(Option.fromNullishOr(pattern.exec(relPath)), {
      onNone: () => [],
      onSome: (match) => [subpath.key.replace("*", match[1] ?? "")],
    })
  })

const entryOf = (sourceFile: ts.SourceFile, rootDir: string): Result.Result<Entry, string> => {
  const rel = toWorkspacePath(rootDir, sourceFile.fileName)
  return Option.match(packageDirOf(path.dirname(sourceFile.fileName), rootDir), {
    onNone: () => Result.fail(`${rel} is in no package: no package.json above it inside the workspace`),
    onSome: (packageDir) =>
      Option.match(Option.flatMap(readText(path.join(packageDir, "package.json")), decodeManifest), {
        onNone: () => Result.fail(`${toWorkspacePath(rootDir, path.join(packageDir, "package.json"))} has no usable "name"`),
        onSome: (manifest) => {
          const relPath = path.relative(packageDir, sourceFile.fileName).split(path.sep).join("/")
          const specifiers = Arr.dedupe(
            subpathsOf(manifest.main, manifest.exports)
              .flatMap((subpath) => keysFor(subpath, relPath))
              .map((key) => (key === "." ? manifest.name : `${manifest.name}/${key.replace(/^\.\//, "")}`)),
          )
          return specifiers.length === 0
            ? Result.fail(`${rel} is not an entry of ${manifest.name}: no "exports" subpath of its package.json points at it`)
            : Result.succeed({ packageDir, specifiers })
        },
      }),
  })
}

interface Exported {
  readonly name: string
  readonly node: ts.Node
  /** The nodes whose JSDoc speaks for the export: its own and its
   *  statement's, and for a re-export the declarations it names. */
  readonly documented: ReadonlyArray<ts.Node>
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)

const bindingNames = (name: ts.BindingName): ReadonlyArray<ts.Identifier> =>
  ts.isIdentifier(name)
    ? [name]
    : name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)))

/** The declarations an export specifier names, through every alias. */
const targetDeclarations = (checker: ts.TypeChecker, element: ts.ExportSpecifier): ReadonlyArray<ts.Node> => {
  const symbol = checker.getSymbolAtLocation(element.name)
  const target = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
  return target?.declarations ?? []
}

/** What one top-level statement of an entry exports by name. */
const exportsOf = (statement: ts.Statement, checker: ts.TypeChecker): ReadonlyArray<Exported> => {
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause
    if (clause === undefined) return []
    return ts.isNamespaceExport(clause)
      ? [{ name: clause.name.text, node: clause, documented: [statement] }]
      : clause.elements.map((element) => ({
          name: element.name.text,
          node: element,
          documented: [element, statement, ...targetDeclarations(checker, element)],
        }))
  }
  if (ts.isExportAssignment(statement)) {
    return statement.isExportEquals === true ? [] : [{ name: "default", node: statement, documented: [statement] }]
  }
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return []
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name).map((name) => ({ name: name.text, node: name, documented: [statement] })),
    )
  }
  if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) return [{ name: "default", node: statement, documented: [statement] }]
  return (ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement) ||
    ts.isImportEqualsDeclaration(statement)) &&
    statement.name !== undefined &&
    ts.isIdentifier(statement.name)
    ? [{ name: statement.name.text, node: statement.name, documented: [statement] }]
    : []
}

/** An entry's named exports, one per name (overloads and a value beside
 *  its same-named type are one export, documented by all of them). */
const namedExports = (sourceFile: ts.SourceFile, checker: ts.TypeChecker): ReadonlyArray<Exported> =>
  Object.values(Arr.groupBy(sourceFile.statements.flatMap((statement) => exportsOf(statement, checker)), (exported) => exported.name)).map(
    (group) => ({ name: group[0].name, node: group[0].node, documented: group.flatMap((exported) => exported.documented) }),
  )

const starExports = (sourceFile: ts.SourceFile): ReadonlyArray<RuleMatch> =>
  sourceFile.statements.flatMap((statement) =>
    ts.isExportDeclaration(statement) &&
    statement.exportClause === undefined &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier)
      ? [
          {
            node: statement,
            message: `\`export *\` from "${statement.moduleSpecifier.text}" publishes whatever that module exports: an entry names each of its exports`,
          },
        ]
      : [],
  )

const tagged = (nodes: ReadonlyArray<ts.Node>, tag: string): boolean =>
  nodes.some((node) => ts.getJSDocTags(node).some((jsDocTag) => jsDocTag.tagName.text === tag))

/** The places a message names before it only counts the rest. */
const SHOWN = 3

const listed = (uses: ReadonlyArray<Use>): string => {
  const wheres = Arr.sort(Arr.dedupe(uses.map((use) => use.where)), Order.String)
  const shown = wheres.slice(0, SHOWN).join(", ")
  return wheres.length > SHOWN ? `${shown} and ${wheres.length - SHOWN} more` : shown
}

const byPosition = Order.mapInput(Order.Number, (match: RuleMatch) => match.node.pos)

export const exportsHaveConsumers: IdiomRule = {
  id: RuleId.make("quality/exports-have-consumers"),
  defaultSeverity: "error",
  description:
    "each export of a package entry has a first-party consumer (another package, a script, a doc code block) or a `@public` tag; an entry names its exports, and first-party code imports none it marks `@deprecated`",
  fixHint:
    "import it where it is used, tag documented host API `@public`, or stop exporting it; name each export instead of `export *`; move the importers of a `@deprecated` export to its replacement",
  check: ({ sourceFile, checker, workspace }) =>
    Result.match(entryOf(sourceFile, workspace.rootDir), {
      onFailure: (reason): ReadonlyArray<RuleMatch> => [{ node: sourceFile, message: reason }],
      onSuccess: (entry) => {
        const index = indexOf(workspace)
        const from = entry.specifiers.map((specifier) => `"${specifier}"`).join(" or ")
        const counts = (use: Use): boolean => use.origin !== "source" || !isWithin(entry.packageDir, use.file)
        const judged = namedExports(sourceFile, checker).flatMap((exported): ReadonlyArray<RuleMatch> => {
          const uses = entry.specifiers.flatMap((specifier) => index.get(keyOf(specifier, exported.name)) ?? []).filter(counts)
          if (tagged(exported.documented, "deprecated")) {
            return uses.length === 0
              ? []
              : [{ node: exported.node, message: `"${exported.name}" is @deprecated, but first-party code still imports it from ${from}: ${listed(uses)}` }]
          }
          return uses.length > 0 || tagged(exported.documented, "public")
            ? []
            : [
                {
                  node: exported.node,
                  message: `"${exported.name}" has no first-party consumer: no other package, script or doc code block imports it from ${from}, and it is not tagged @public`,
                },
              ]
        })
        return Arr.sort([...starExports(sourceFile), ...judged], byPosition)
      },
    }),
}
