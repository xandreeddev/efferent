/**
 * The public API of the built packages, one file per published entry under `api/`:
 * `<package>.api.txt` for a package's root and `<package>--<subpath>.api.txt` for each other entry
 * (the import path without `@xandreed/`, every `/` a `--`: `@xandreed/evals/stats` is
 * `evals--stats.api.txt`). Each holds the sorted `kind name` lines of what its entry exports, the
 * kind one of `class`, `const`, `enum`, `function`, `interface`, `let`, `namespace`, `type` or `var`
 * (a name with a value and a type, like a schema and its type, has a line for each; a type-only
 * export keeps only its type: a class or an enum exported with `export type` is a `type`).
 *
 * The entries are the built manifests' `exports` (`.artifacts/packages/<dir>/package.json`); a
 * wildcard entry (`./*`) is one entry per module it publishes, and a module two keys reach is read
 * once, under the first. The names are read with the TypeScript checker from the declarations the
 * build emitted (`.artifacts/types/<dir>/src`). A root entry may not export a name declared under
 * a package's `src/internal/` or `src/engine/`: those modules have entries of their own, outside
 * semver.
 *
 *   bun run api:update   rebuild the packages, then rewrite api/ from that build
 *
 * `bun run verify:packages` fails when api/ differs from the build it verifies (`apiDifferences`),
 * so a change to what a package exports shows in the diff of the change that makes it.
 * api-snapshot.test.ts covers the reading over a declaration tree of its own.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { Result, Schema } from "effect"
import * as ts from "typescript"
import { BuildStamp } from "./publish-plan.js"

/** Where a build's API is read from. */
export interface ApiBuild {
  /** The built packages (`.artifacts/packages`): `<dir>/package.json` names a package's entries. */
  readonly packages: string
  /** The declarations the build emitted (`.artifacts/types`), at `<dir>/src/**`. */
  readonly types: string
  /** The package sources (`packages`): a declaration's imports of other packages resolve from its source, as in the build. */
  readonly sources: string
  /** The package folders to read: the build stamp's. */
  readonly dirs: ReadonlyArray<string>
}

/** The API of a build: each api/ file's text by its name, and why the build's API cannot be accepted. */
export interface ApiSnapshot {
  readonly files: ReadonlyMap<string, string>
  readonly problems: ReadonlyArray<string>
}

/**
 * One published import path: its api/ file, whether it is the root, its declaration, and whether it
 * is listed (the first path to reach that declaration; another one, such as `./x.js` beside `./x`,
 * only resolves).
 */
interface Entry { readonly path: string; readonly file: string; readonly root: boolean; readonly declaration: string; readonly listed: boolean }

/** The fields of a built manifest the snapshot reads; an export without `types` (a JSON file) has no API to list. */
interface BuiltManifest { readonly name: string; readonly exports?: Readonly<Record<string, { readonly types?: string }>> }

/** The folders of a package that only their own entries may export from. */
const UNLISTED_AT_ROOT: ReadonlyArray<string> = ["internal", "engine"]

/** Code-unit order, the same on every machine. */
const byText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

/** `@xandreed/evals/stats` is `evals--stats.api.txt`. */
const fileOf = (path: string): string => `${path.replace(/^@xandreed\//, "").split("/").join("--")}.api.txt`

/** The `*` of `pattern` matched against each file the built package publishes, `*` spanning folders as in Node. */
const matches = (build: ApiBuild, dir: string, pattern: string): ReadonlyArray<string> => {
  const [before = "", after = ""] = pattern.replace(/^\.\//, "").split("*")
  return Array.from(new Bun.Glob(`${before}**/*${after}`).scanSync({ cwd: join(build.packages, dir), onlyFiles: true }))
    .filter((file) => file.startsWith(before) && file.endsWith(after) && file.length > before.length + after.length)
    .map((file) => file.slice(before.length, file.length - after.length))
    .sort(byText)
}

/** A package's published import paths: a key's `types` (`./dist/x.d.ts`) is `<types>/<dir>/src/x.d.ts`. */
const entriesOf = (build: ApiBuild, dir: string): ReadonlyArray<Entry> => {
  const manifest = JSON.parse(readFileSync(join(build.packages, dir, "package.json"), "utf8")) as BuiltManifest
  const declarationOf = (types: string) => join(build.types, dir, types.replace(/^\.\/dist\//, "src/"))
  const keyed = Object.entries(manifest.exports ?? { ".": { types: "./dist/index.d.ts" } }).flatMap(([key, { types }]) =>
    types === undefined ? []
      : key.includes("*") ? matches(build, dir, types).map((match) => ({ key: key.replace("*", match), declaration: declarationOf(types.replace("*", match)) }))
      : [{ key, declaration: declarationOf(types) }])
  return keyed.map(({ key, declaration }, index) => {
    const path = key === "." ? manifest.name : `${manifest.name}/${key.replace(/^\.\//, "")}`
    return { path, file: fileOf(path), root: key === ".", declaration, listed: keyed.findIndex((other) => other.declaration === declaration) === index }
  })
}

/** The checker's program over the entries: an entry's import path resolves to its declaration, a relative import beside the importer, another import from the importer's source. */
const programOf = (build: ApiBuild, entries: ReadonlyArray<Entry>): ts.Program => {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true, skipLibCheck: true, types: [], resolveJsonModule: true,
  }
  const host = ts.createCompilerHost(options)
  const cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), host.getCanonicalFileName, options)
  const published = new Map(entries.map((entry) => [entry.path, entry.declaration]))
  const sourceOf = (file: string) => {
    const path = relative(build.types, file)
    return path.startsWith("..") ? file : join(build.sources, path)
  }
  host.resolveModuleNameLiterals = (literals, containingFile, redirected, compilerOptions, containingSourceFile) => literals.map((literal) => {
    const declaration = published.get(literal.text)
    const from = literal.text.startsWith(".") || literal.text.startsWith("@xandreed/") ? containingFile : sourceOf(containingFile)
    return declaration !== undefined
      ? { resolvedModule: { resolvedFileName: declaration, extension: ts.Extension.Dts } }
      : ts.resolveModuleName(literal.text, from, compilerOptions, host, cache, redirected, ts.getModeForUsageLocation(containingSourceFile, literal, compilerOptions))
  })
  return ts.createProgram({ rootNames: entries.filter((entry) => entry.listed).map((entry) => entry.declaration), options, host })
}

/**
 * The declarations an export names, through its chain of aliases (none when a link does not
 * resolve), and whether a link of the chain is type-only.
 */
const targetOf = (checker: ts.TypeChecker, symbol: ts.Symbol, typeOnly: boolean): { readonly target: ts.Symbol; readonly files: ReadonlyArray<string>; readonly typeOnly: boolean } => {
  const only = typeOnly || (symbol.declarations ?? []).some(ts.isTypeOnlyImportOrExportDeclaration)
  const alias = (symbol.flags & ts.SymbolFlags.Alias) !== 0
  const next = alias ? checker.getImmediateAliasedSymbol(symbol) : undefined
  return next !== undefined ? targetOf(checker, next, only)
    : { target: symbol, files: alias ? [] : (symbol.declarations ?? []).map((declaration) => declaration.getSourceFile().fileName), typeOnly: only }
}

/** `const`, `let` or `var`, as the variable is declared. */
const variableKind = (symbol: ts.Symbol): string => {
  const flags = (symbol.declarations ?? []).filter(ts.isVariableDeclaration).map((declaration) => ts.getCombinedNodeFlags(declaration))[0] ?? 0
  return flags & ts.NodeFlags.Const ? "const" : flags & ts.NodeFlags.Let ? "let" : "var"
}

/** Every kind of declaration `symbol` has; a type-only export keeps the type meanings alone (a value exported type-only is a `type`). */
const kindsOf = (symbol: ts.Symbol, typeOnly: boolean): ReadonlyArray<string> => {
  const has = (flag: ts.SymbolFlags) => (symbol.flags & flag) !== 0
  const kinds = [
    ...(has(ts.SymbolFlags.Class) ? [typeOnly ? "type" : "class"] : []),
    ...(has(ts.SymbolFlags.Enum) ? [typeOnly ? "type" : "enum"] : []),
    ...(has(ts.SymbolFlags.Function) && !typeOnly ? ["function"] : []),
    ...(has(ts.SymbolFlags.Variable) && !typeOnly ? [variableKind(symbol)] : []),
    ...(has(ts.SymbolFlags.Interface) ? ["interface"] : []),
    ...(has(ts.SymbolFlags.TypeAlias) ? ["type"] : []),
    ...(has(ts.SymbolFlags.Module) ? ["namespace"] : []),
  ]
  return kinds.length === 0 ? ["type"] : Array.from(new Set(kinds))
}

/** The folder of a package's `src` a declaration file is in (`internal` for `core/src/internal/json.d.ts`), if it is one of the build's. */
const folderOf = (build: ApiBuild, file: string): string | undefined => {
  const [dir, src, folder] = relative(build.types, file).split(sep)
  return dir === undefined || dir === ".." || src !== "src" ? undefined : folder
}

/** The API of every published entry of the build, and every reason to refuse it. */
export const apiSnapshot = (build: ApiBuild): ApiSnapshot => {
  const paths = build.dirs.flatMap((dir) => entriesOf(build, dir))
  const absent = paths.filter((entry) => entry.listed && !existsSync(entry.declaration))
  const program = programOf(build, paths.filter((entry) => existsSync(entry.declaration)))
  const present = paths.filter((entry) => entry.listed && !absent.includes(entry))
  const checker = program.getTypeChecker()
  const shown = (file: string) => relative(build.types, file).split(sep).join("/")
  const unresolved = program.getSourceFiles().filter((file) => !relative(build.types, file.fileName).startsWith("..")).flatMap((file) =>
    file.statements.filter(ts.isExportDeclaration).flatMap((statement) =>
      statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) && checker.getSymbolAtLocation(statement.moduleSpecifier) === undefined
        ? [`${shown(file.fileName)} re-exports "${statement.moduleSpecifier.text}", which does not resolve`] : []))
  const read = present.map((entry) => {
    const source = program.getSourceFile(entry.declaration)
    const module = source === undefined ? undefined : checker.getSymbolAtLocation(source)
    const declared = module === undefined ? [] : checker.getExportsOfModule(module).map((symbol) => ({ name: symbol.name, ...targetOf(checker, symbol, false) }))
    const lines = declared.flatMap(({ name, target, typeOnly, files }) => files.length === 0 ? [] : kindsOf(target, typeOnly).map((kind) => `${kind} ${name}`)).sort(byText)
    const problems = [
      ...(module === undefined ? [`${entry.path}: ${shown(entry.declaration)} is not a module`] : []),
      ...declared.filter(({ files }) => files.length === 0).map(({ name }) => `${entry.path} exports ${name}, whose declaration does not resolve`),
      ...(entry.root ? declared.flatMap(({ name, files }) => files.filter((file) => UNLISTED_AT_ROOT.includes(folderOf(build, file) ?? "")).slice(0, 1)
        .map((file) => `${entry.path} exports ${name}, declared in ${shown(file)}: a root entry may not export what src/internal/ or src/engine/ declares; export it from its own entry`)) : []),
    ].sort(byText)
    return { file: entry.file, text: lines.length === 0 ? "" : `${lines.join("\n")}\n`, problems }
  })
  return {
    files: new Map(read.map(({ file, text }) => [file, text] as const).sort(([a], [b]) => byText(a, b))),
    problems: [
      ...absent.map((entry) => `${entry.path}: the build emitted no ${shown(entry.declaration)}; rebuild`),
      ...unresolved,
      ...read.flatMap((entry) => entry.problems),
    ],
  }
}

const linesOf = (text: string): ReadonlyArray<string> => text.split("\n").filter((line) => line.length > 0)

/** How the committed api/ differs from the build's (empty when it does not), each file's added and removed lines named. */
export const apiDifferences = (committed: ReadonlyMap<string, string>, built: ReadonlyMap<string, string>): ReadonlyArray<string> =>
  Array.from(new Set([...committed.keys(), ...built.keys()])).sort(byText).flatMap((file) => {
    const was = committed.get(file)
    const now = built.get(file)
    const added = linesOf(now ?? "").filter((line) => !linesOf(was ?? "").includes(line))
    const removed = linesOf(was ?? "").filter((line) => !linesOf(now ?? "").includes(line))
    const changes = [...added.map((line) => `+${line}`), ...removed.map((line) => `-${line}`)]
    return was === now ? []
      : was === undefined ? [`api/${file} is missing: a new entry (${added.length} lines)`]
      : now === undefined ? [`api/${file} is for an entry the build does not publish`]
      : [`api/${file} differs from the build: ${changes.length === 0 ? "in order or blank lines" : `${changes.slice(0, 20).join(", ")}${changes.length > 20 ? `, and ${changes.length - 20} more` : ""}`}`]
  })

/** The committed api/ files, by name. */
export const committedApi = (folder: string): ReadonlyMap<string, string> =>
  new Map(existsSync(folder) ? Array.from(new Bun.Glob("*.api.txt").scanSync({ cwd: folder }), (file) => [file, readFileSync(join(folder, file), "utf8")] as const) : [])

/** The build under `<root>/.artifacts` of the packages the stamp lists. */
export const apiBuildOf = (root: string, dirs: ReadonlyArray<string>): ApiBuild =>
  ({ packages: join(root, ".artifacts/packages"), types: join(root, ".artifacts/types"), sources: join(root, "packages"), dirs })

if (import.meta.main) {
  const root = join(import.meta.dir, "..")
  const stampFile = join(root, ".artifacts/packages/build.json")
  const stamp = Schema.decodeUnknownResult(Schema.fromJsonString(BuildStamp))(existsSync(stampFile) ? readFileSync(stampFile, "utf8") : "")
  if (Result.isFailure(stamp)) {
    console.error("Refusing to write api/: .artifacts/packages/build.json is missing or not valid; run bun run build:packages first")
    process.exit(1)
  }
  const snapshot = apiSnapshot(apiBuildOf(root, stamp.success.packages.map((entry) => entry.dir)))
  if (snapshot.problems.length > 0) {
    console.error(`Refusing to write api/:\n${snapshot.problems.map((problem) => `  - ${problem}`).join("\n")}`)
    process.exit(1)
  }
  const folder = join(root, "api")
  const stale = Array.from(committedApi(folder).keys()).filter((file) => !snapshot.files.has(file))
  const changed = apiDifferences(committedApi(folder), snapshot.files)
  mkdirSync(folder, { recursive: true })
  stale.forEach((file) => rmSync(join(folder, file)))
  snapshot.files.forEach((text, file) => writeFileSync(join(folder, file), text))
  console.log(changed.length === 0
    ? `api/ already matches the build (${snapshot.files.size} entries)`
    : `Wrote api/ for ${snapshot.files.size} entries:\n${changed.map((change) => `  - ${change}`).join("\n")}`)
}
