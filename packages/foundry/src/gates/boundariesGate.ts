import { Array as Arr, Effect, Option, Order, Predicate, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as ts from "typescript"
import { GateName, RuleId } from "../domain/Brands.js"
import { GateCrash } from "../domain/Errors.js"
import { Finding } from "../domain/Finding.js"
import type { LayerConfig, LayerSpec } from "../domain/Rules.js"
import type { Gate, Workspace } from "../ports/Gate.js"
import { locationOf, matchesGlob, projectSourceFiles, toWorkspacePath, walk } from "./astWalk.js"
import { TsProject } from "./TsProject.port.js"

export const BOUNDARIES_GATE = GateName.make("boundaries")

const ILLEGAL_IMPORT = RuleId.make("boundaries/illegal-import")
const ILLEGAL_EXTERNAL = RuleId.make("boundaries/illegal-external")

/** Manifests read at once: one read per directory, none depending on another. */
const READ_CONCURRENCY = 8

const layerOf = (layers: LayerConfig, relPath: string): Option.Option<LayerSpec> =>
  Option.fromNullishOr(layers.layers.find((l) => matchesGlob(l.path, relPath)))

/** `./x.js` (the ESM authoring convention) resolves to `./x.ts` on disk. */
const asSource = (relPath: string): string => (relPath.endsWith(".ts") ? relPath : relPath.replace(/\.js$/, ".ts"))

const toSourceRelative = (importerRel: string, specifier: string): string =>
  asSource(path.posix.join(path.posix.dirname(importerRel), specifier))

/** The directory holding a workspace-relative path; `""` is the workspace root. */
const dirOf = (relPath: string): string => {
  const dir = path.posix.dirname(relPath)
  return dir === "." ? "" : dir
}

/** A directory and each one above it, up to the workspace root (`""`). */
const ancestry = (dir: string): ReadonlyArray<string> => (dir === "" ? [""] : [dir, ...ancestry(dirOf(dir))])

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value)
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => Predicate.isObject(value)

/** The fields of a `package.json` the gate reads. `exports` stays open JSON:
 *  a string, a subpath map, conditions or fallback arrays, read below. */
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.OptionFromOptional(Schema.NonEmptyString),
    main: Schema.OptionFromOptional(Schema.NonEmptyString),
    exports: Schema.OptionFromOptional(Schema.Json),
  }),
)

/** A directory holding a `package.json`: one package of the workspace. */
interface WorkspacePackage {
  /** Workspace-relative; `""` is the workspace root. */
  readonly dir: string
  readonly name: Option.Option<string>
  /** Its `exports` as subpath keys (`"."`, `"./stats"`, `"./*"`) and their
   *  targets. Without an `exports` map, the root alone: `main`, else `./index.js`. */
  readonly subpaths: ReadonlyArray<readonly [string, Schema.Json]>
}

/** The workspace's packages: each directory above a project source file
 *  that holds a `package.json`, by directory and by name. */
interface PackageIndex {
  readonly byDir: ReadonlyMap<string, WorkspacePackage>
  readonly byName: ReadonlyMap<string, WorkspacePackage>
}

const subpathEntries = (
  exports: Option.Option<Schema.Json>,
  main: Option.Option<string>,
): ReadonlyArray<readonly [string, Schema.Json]> =>
  Option.match(exports, {
    onNone: () => [[".", Option.getOrElse(main, () => "./index.js")]],
    // A map whose keys are subpaths; any other value is the root's target.
    onSome: (value) =>
      isJsonObject(value) && Object.keys(value).some((key) => key.startsWith("."))
        ? Object.entries(value)
        : [[".", value]],
  })

/** The file an export target names: a string, the first entry of a fallback
 *  array that names one, or the first condition (`types`, `import`,
 *  `default`…) that does. `null` names none: the subpath is excluded. */
const targetOf = (value: Schema.Json): Option.Option<string> =>
  typeof value === "string"
    ? Option.some(value)
    : isJsonArray(value)
      ? Arr.findFirst(value, targetOf)
      : isJsonObject(value)
        ? Arr.findFirst(Object.values(value), targetOf)
        : Option.none()

interface PatternMatch {
  readonly prefix: string
  readonly target: Schema.Json
  /** What the key's `*` stands for. */
  readonly matched: string
}

/** A `*` subpath pattern (`"./*"`, `"./kits/*.js"`) that matches `key`. */
const patternMatch =
  (key: string) =>
  ([pattern, target]: readonly [string, Schema.Json]): ReadonlyArray<PatternMatch> => {
    const star = pattern.indexOf("*")
    if (star < 0) return []
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    return key !== prefix && key.startsWith(prefix) && key.endsWith(suffix) && key.length >= pattern.length
      ? [{ prefix, target, matched: key.slice(prefix.length, key.length - suffix.length) }]
      : []
  }

const longestPrefixFirst: Order.Order<PatternMatch> = Order.flip(
  Order.mapInput(Order.Number, (match: PatternMatch) => match.prefix.length),
)

/** What a package's `exports` maps a subpath key (`"."`, `"./stats"`) to: its
 *  exact key, else the `*` pattern with the longest prefix that matches it
 *  (Node's order), `*` replaced. None when nothing maps it, or it maps to
 *  `null`. */
const exportedTarget = (pkg: WorkspacePackage, key: string): Option.Option<string> =>
  Option.match(Arr.findFirst(pkg.subpaths, ([subpath]) => subpath === key), {
    onSome: ([, target]) => targetOf(target),
    onNone: () =>
      Arr.head(Arr.sort(pkg.subpaths.flatMap(patternMatch(key)), longestPrefixFirst)).pipe(
        Option.flatMap((match) => Option.map(targetOf(match.target), (target) => target.replaceAll("*", match.matched))),
      ),
  })

/** `@scope/name/sub/path` names the package `@scope/name` and its subpath
 *  `sub/path`; `name/sub` the package `name`. */
const splitBare = (specifier: string): { readonly name: string; readonly subpath: Option.Option<string> } => {
  const segments = specifier.split("/")
  const size = specifier.startsWith("@") ? 2 : 1
  return {
    name: segments.slice(0, size).join("/"),
    subpath: Option.liftPredicate(segments.slice(size).join("/"), (rest) => rest !== ""),
  }
}

/** A `testing` module (`testing`, `<name>.testing`, `testing.port`) or a file
 *  in a `testing/` folder: test scaffolding, which no `exports` lists. */
const isTestingModule = (subpath: string): boolean => {
  const segments = subpath.replace(/\.(js|ts)$/, "").split("/")
  return segments.includes("testing") || /^(.+\.)?testing(\.port)?$/.test(segments.at(-1) ?? "")
}

/** The package holding a workspace-relative directory: the nearest directory
 *  at or above it with a `package.json`, else the workspace root. */
const packageDirOf = (index: PackageIndex, dir: string): string =>
  Option.getOrElse(Arr.findFirst(ancestry(dir), (candidate) => index.byDir.has(candidate)), () => "")

const readPackage = (rootDir: string, dir: string): Effect.Effect<Option.Option<WorkspacePackage>, GateCrash> => {
  const manifest = path.posix.join(dir, "package.json")
  return Effect.tryPromise({ try: () => fs.readFile(path.join(rootDir, manifest), "utf8"), catch: () => "absent" as const }).pipe(
    Effect.map(Option.some),
    Effect.tapError(() => Effect.logDebug(`${manifest} is absent or unreadable`)),
    Effect.orElseSucceed(() => Option.none<string>()),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<WorkspacePackage>()),
        onSome: (text) =>
          Schema.decodeUnknownEffect(Manifest)(text).pipe(
            Effect.mapError(
              (cause) => new GateCrash({ gate: BOUNDARIES_GATE, message: `${manifest} is not a package manifest the gate can read`, cause }),
            ),
            Effect.map((parsed) => Option.some({ dir, name: parsed.name, subpaths: subpathEntries(parsed.exports, parsed.main) })),
          ),
      }),
    ),
  )
}

/** Every package that holds one of `dirs`, read once per directory. */
const indexPackages = (rootDir: string, dirs: ReadonlyArray<string>): Effect.Effect<PackageIndex, GateCrash> =>
  Effect.forEach(Arr.dedupe(dirs.flatMap(ancestry)), (dir) => readPackage(rootDir, dir), { concurrency: READ_CONCURRENCY }).pipe(
    Effect.map((found) => {
      const packages = Arr.getSomes(found)
      return {
        byDir: new Map(packages.map((pkg) => [pkg.dir, pkg] as const)),
        byName: new Map(
          packages.flatMap((pkg) => Option.match(pkg.name, { onNone: () => [], onSome: (name) => [[name, pkg] as const] })),
        ),
      }
    }),
  )

/** Effect v4 folds packages that were separate in v3 (`@effect/ai`,
 * `@effect/platform`, `@effect/sql`…) into these `effect/<module>` barrels
 * (the migration guide's unstable modules), and ships its test services
 * (`TestClock`, `TestConsole`…) as the `effect/testing` barrel. Each stays
 * its own allowance: `effect` admits the core modules only, so a layer
 * allowed `effect` alone cannot reach `effect/ai` any more than it could
 * reach `@effect/ai`, nor `effect/testing` unless it lists it, as a test
 * layer does.
 */
const EFFECT_BARRELS: ReadonlySet<string> = new Set([
  "ai", "cli", "cluster", "devtools", "eventlog", "graphql", "http", "http-api", "jsonschema", "net",
  "observability", "persistence", "process", "reactivity", "rpc", "schema", "socket", "sql", "testing",
  "workflow", "workers",
])

const effectBarrelOf = (specifier: string): Option.Option<string> => {
  const name = /^effect\/([a-z][a-z-]*)(?:\/|$)/.exec(specifier)?.[1]
  return name !== undefined && EFFECT_BARRELS.has(name) ? Option.some(`effect/${name}`) : Option.none()
}

/** Whether one `externals` entry admits a specifier. A prefix ending in `/`
 *  or `:` is a raw prefix (`@effect/` → `@effect/ai-openai`, `effect/` →
 *  `effect/ai`, `node:` → `node:path`); otherwise it matches the exact
 *  package or its subpaths (`effect` → `effect`, `effect/Function` — never
 *  `effect-foo`, and never an Effect barrel, which is named itself). */
const admits = (prefix: string, specifier: string): boolean => {
  if (prefix.endsWith("/") || prefix.endsWith(":")) return specifier.startsWith(prefix)
  const within = specifier === prefix || specifier.startsWith(`${prefix}/`)
  return within && Option.match(effectBarrelOf(specifier), {
    onNone: () => true,
    onSome: (barrel) => prefix === barrel || prefix.startsWith(`${barrel}/`),
  })
}

const externalAllowed = (layer: LayerSpec, specifier: string): boolean =>
  layer.externals.some((prefix) => admits(prefix, specifier))

/** Every module a source file names, with its node: each import and
 *  re-export clause, and each `import("…")` of a literal specifier wherever
 *  it is, a dynamic import or an import type. */
const moduleSpecifiers = (
  sourceFile: ts.SourceFile,
): ReadonlyArray<{ readonly node: ts.Node; readonly specifier: string }> => {
  const named: Array<{ readonly node: ts.Node; readonly specifier: string }> = []
  walk(sourceFile, (node) => {
    const literal =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : undefined
    if (literal !== undefined && ts.isStringLiteralLike(literal)) named.push({ node, specifier: literal.text })
  })
  return named
}

/** One import clause of a file in `layer`. */
interface ImportSite {
  readonly layers: LayerConfig
  readonly index: PackageIndex
  readonly layer: LayerSpec
  readonly importerRel: string
  readonly specifier: string
  readonly sourceFile: ts.SourceFile
  readonly node: ts.Node
  readonly rootDir: string
}

const findingAt = (site: ImportSite, rule: RuleId, message: string, fixHint: string): Finding =>
  new Finding({
    rule,
    severity: "error",
    message,
    location: Option.some(locationOf(site.sourceFile, site.node, site.rootDir)),
    fixHint: Option.some(fixHint),
  })

const mayImport = (layer: LayerSpec, target: LayerSpec): boolean =>
  target.name === layer.name || layer.canImport.includes(target.name)

const layerRefused = (site: ImportSite, target: LayerSpec): Finding =>
  findingAt(
    site,
    ILLEGAL_IMPORT,
    `layer "${site.layer.name}" must not import layer "${target.name}" (${site.specifier})`,
    `allowed from "${site.layer.name}": ${[site.layer.name, ...site.layer.canImport].join(", ")} — invert the dependency or move the code`,
  )

/** A relative import stays inside its own package, then inside the layers
 *  its own layer may import. */
const checkRelative = (site: ImportSite): ReadonlyArray<Finding> => {
  const targetRel = toSourceRelative(site.importerRel, site.specifier)
  const home = packageDirOf(site.index, dirOf(site.importerRel))
  const leaves = targetRel === ".." || targetRel.startsWith("../") || packageDirOf(site.index, dirOf(targetRel)) !== home
  if (leaves) {
    return [
      findingAt(
        site,
        ILLEGAL_IMPORT,
        `relative import "${site.specifier}" leaves its package (${home === "" ? "the workspace root" : home})`,
        "import the other package by its name, as a dependency its package.json declares, or move the code",
      ),
    ]
  }
  return Option.match(layerOf(site.layers, targetRel), {
    // A file outside every declared layer is unconstrained.
    onNone: () => [],
    onSome: (target) => (mayImport(site.layer, target) ? [] : [layerRefused(site, target)]),
  })
}

/** A workspace package's layer grants its root and its exported subpaths to
 *  `canImport: [layer]`; each of its `restricted` subpaths only to
 *  `canImport: ["<layer>/<subpath>"]`. */
const checkGrant = (site: ImportSite, name: string, target: LayerSpec, subpath: Option.Option<string>): ReadonlyArray<Finding> =>
  Option.match(
    Option.flatMap(subpath, (sub) => Arr.findFirst(target.restricted, (restricted) => sub === restricted || sub.startsWith(`${restricted}/`))),
    {
      onNone: () => (mayImport(site.layer, target) ? [] : [layerRefused(site, target)]),
      onSome: (restricted) => {
        const grant = `${target.name}/${restricted}`
        return target.name === site.layer.name || site.layer.canImport.includes(grant)
          ? []
          : [
              findingAt(
                site,
                ILLEGAL_IMPORT,
                `layer "${site.layer.name}" must not import "${site.specifier}": "${restricted}" is a restricted subpath of layer "${target.name}"`,
                `import "${name}" itself, or grant "${grant}" in "${site.layer.name}"'s canImport (a reviewed change)`,
              ),
            ]
      },
    },
  )

/** A bare import of a workspace package by name: the subpath must be one its
 *  `exports` lists (a `-tests` layer may also reach a testing module), and
 *  the layer holding its entry must be one this layer may import. */
const checkPackageImport = (site: ImportSite, pkg: WorkspacePackage, name: string, subpath: Option.Option<string>): ReadonlyArray<Finding> => {
  const key = Option.match(subpath, { onNone: () => ".", onSome: (sub) => `./${sub}` })
  const reachesTesting = site.layer.name.endsWith("-tests") && Option.exists(subpath, isTestingModule)
  const unexported =
    Option.isNone(exportedTarget(pkg, key)) && !reachesTesting
      ? [
          findingAt(
            site,
            ILLEGAL_IMPORT,
            `"${site.specifier}": ${name} does not export "${key}"`,
            `import what its package.json "exports" lists (${pkg.subpaths.map(([subpath]) => subpath).join(", ")}); only a "-tests" layer may reach a testing module it leaves out`,
          ),
        ]
      : []
  const entry = exportedTarget(pkg, ".").pipe(Option.map((target) => asSource(path.posix.join(pkg.dir, target))))
  return [
    ...unexported,
    ...Option.match(Option.flatMap(entry, (file) => layerOf(site.layers, file)), {
      onNone: () => [
        findingAt(
          site,
          ILLEGAL_IMPORT,
          `"${site.specifier}" names ${name}, whose entry no layer covers`,
          `add a boundaries layer whose path covers ${Option.getOrElse(entry, () => `${pkg.dir}/package.json's entry`)}`,
        ),
      ],
      onSome: (target) => checkGrant(site, name, target, subpath),
    }),
  ]
}

const checkExternal = (site: ImportSite): ReadonlyArray<Finding> =>
  externalAllowed(site.layer, site.specifier)
    ? []
    : [
        findingAt(
          site,
          ILLEGAL_EXTERNAL,
          `layer "${site.layer.name}" must not depend on external "${site.specifier}"`,
          `externals allowed in "${site.layer.name}": ${site.layer.externals.join(", ")} — declare a port instead`,
        ),
      ]

/** A bare specifier that names no workspace package. */
const isExternal = (site: ImportSite): boolean =>
  !site.specifier.startsWith(".") && !site.index.byName.has(splitBare(site.specifier).name)

const checkSpecifier = (site: ImportSite): ReadonlyArray<Finding> => {
  if (site.specifier.startsWith(".")) return checkRelative(site)
  const { name, subpath } = splitBare(site.specifier)
  return Option.match(Option.fromNullishOr(site.index.byName.get(name)), {
    onNone: () => checkExternal(site),
    onSome: (pkg) => checkPackageImport(site, pkg, name, subpath),
  })
}

/** The externals a layer lists that none of its files import: each one
 *  fails, so a list, like an allow list, only shrinks. A layer is every
 *  entry of its name (a glob takes no alternatives), so an external one
 *  entry lists counts as used when a file of another entry imports it. */
const unusedExternals = (layers: LayerConfig, sites: ReadonlyArray<ImportSite>): ReadonlyArray<Finding> =>
  Arr.dedupe(layers.layers.map((layer) => layer.name)).flatMap((name) => {
    const imported = sites.filter((site) => site.layer.name === name && isExternal(site)).map((site) => site.specifier)
    const listed = Arr.dedupe(layers.layers.filter((layer) => layer.name === name).flatMap((layer) => layer.externals))
    return listed
      .filter((prefix) => !imported.some((specifier) => admits(prefix, specifier)))
      .map(
        (prefix) =>
          new Finding({
            rule: ILLEGAL_EXTERNAL,
            severity: "error",
            message: `layer "${name}" lists external "${prefix}", which none of its files imports`,
            location: Option.none(),
            fixHint: Option.some(`remove "${prefix}" from the externals of layer "${name}" in the profile; the list only shrinks`),
          }),
      )
  })

/**
 * Dependency direction as a GATE, not a convention: each layer declares what
 * it may import (internal layers by name, externals by prefix); everything
 * else is a finding, and so is an external the layer lists but none of its
 * files imports. A bare import that names a package of the workspace (a
 * directory above a project file holding a `package.json`) is internal, not
 * external: it reaches the layer holding that package's entry, and only the
 * subpaths its `exports` lists. A relative import never leaves its package.
 * Pointing the layer globs at package dirs generalizes this to the
 * monorepo's `cli → adapters → core` rule.
 */
export const makeBoundariesGate = (
  layers: LayerConfig,
  tsconfigRel: string,
): Gate<TsProject> => ({
  name: BOUNDARIES_GATE,
  kind: "static",
  deterministic: true,
  run: Effect.fnUntraced(
    function* (workspace: Workspace) {
      const tsp = yield* TsProject
      const project = yield* tsp
        .load(path.resolve(workspace.rootDir, tsconfigRel))
        .pipe(
          Effect.mapError(
            (e) => new GateCrash({ gate: BOUNDARIES_GATE, message: e.message }),
          ),
        )
      const sourceFiles = projectSourceFiles(project, workspace.rootDir)
      const index = yield* indexPackages(
        workspace.rootDir,
        sourceFiles.map((sourceFile) => dirOf(toWorkspacePath(workspace.rootDir, sourceFile.fileName))),
      )
      const sites = sourceFiles.flatMap((sourceFile) => {
        const importerRel = toWorkspacePath(workspace.rootDir, sourceFile.fileName)
        return Option.match(layerOf(layers, importerRel), {
          onNone: () => [] as ReadonlyArray<ImportSite>,
          onSome: (layer) =>
            moduleSpecifiers(sourceFile).map(({ node, specifier }): ImportSite => ({
              layers,
              index,
              layer,
              importerRel,
              specifier,
              sourceFile,
              node,
              rootDir: workspace.rootDir,
            })),
        })
      })
      return [...sites.flatMap(checkSpecifier), ...unusedExternals(layers, sites)]
    },
  ),
})
