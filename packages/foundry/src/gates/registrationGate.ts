import { Array as Arr, Effect, Match, Option, Order, Predicate, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as ts from "typescript"
import { GateName, RuleId } from "../domain/Brands.js"
import { GateCrash } from "../domain/Errors.js"
import { Finding } from "../domain/Finding.js"
import type {
  ConstRegistry,
  GateSuiteConfig,
  JsonKeysRegistry,
  ProfileRegistry,
  RegistrationConfig,
  RegistrySpec,
} from "../domain/Rules.js"
import type { Gate, Workspace } from "../ports/Gate.js"
import { includedBy, matchesGlob } from "./astWalk.js"

export const REGISTRATION_GATE = GateName.make("registration")

const PACKAGE_REGISTERED = RuleId.make("quality/package-registered")

/** One package as the templates see it. */
interface WorkspacePackage {
  /** Workspace-relative directory, `packages/core`. */
  readonly path: string
  /** The directory's own name, `core`. */
  readonly dir: string
  /** The `package.json` name. */
  readonly name: string
}

const fill = (template: string, pkg: WorkspacePackage): string =>
  template.replaceAll("{path}", pkg.path).replaceAll("{dir}", pkg.dir).replaceAll("{name}", pkg.name)

const crash = (message: string): GateCrash => new GateCrash({ gate: REGISTRATION_GATE, message })

const Manifest = Schema.fromJsonString(Schema.Struct({ name: Schema.NonEmptyString }))

/** A directory without a readable `package.json` is not a package. */
const isFile = (file: string): Effect.Effect<boolean> =>
  Effect.tryPromise({ try: () => fs.stat(file), catch: () => "absent" as const }).pipe(
    Effect.map((stat) => stat.isFile()),
    Effect.tapError(() => Effect.logDebug(`${file} is absent or unreadable`)),
    Effect.orElseSucceed(() => false),
  )

/** Each child directory of a root that holds a `package.json`, by path. */
const discoverPackages = (
  rootDir: string,
  roots: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<WorkspacePackage>, GateCrash> =>
  Effect.forEach(roots, (root) =>
    Effect.tryPromise({
      try: () => fs.readdir(path.join(rootDir, root), { withFileTypes: true }),
      catch: (cause) => crash(`cannot list package root "${root}": ${String(cause)}`),
    }).pipe(
      Effect.map((entries) => Arr.sort(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name), Order.String)),
      Effect.flatMap((dirs) =>
        Effect.forEach(dirs, (dir) => {
          const pkgPath = path.posix.join(root, dir)
          const manifest = path.join(rootDir, pkgPath, "package.json")
          return isFile(manifest).pipe(
            Effect.flatMap((exists) =>
              exists
                ? Effect.tryPromise({
                    try: () => fs.readFile(manifest, "utf8"),
                    catch: (cause) => crash(`cannot read ${pkgPath}/package.json: ${String(cause)}`),
                  }).pipe(
                    Effect.flatMap((text) =>
                      Schema.decodeUnknownEffect(Manifest)(text).pipe(
                        Effect.mapError((e) => crash(`${pkgPath}/package.json has no usable "name": ${e.message}`)),
                      ),
                    ),
                    Effect.map((parsed): ReadonlyArray<WorkspacePackage> => [{ path: pkgPath, dir, name: parsed.name }]),
                  )
                : Effect.succeed<ReadonlyArray<WorkspacePackage>>([]),
            ),
          )
        }, { concurrency: 1 }),
      ),
      Effect.map((found) => found.flat()),
    ),
    { concurrency: 1 },
  ).pipe(Effect.map((found) => found.flat()))

const readWorkspaceFile = (rootDir: string, file: string): Effect.Effect<string, GateCrash> =>
  Effect.tryPromise({
    try: () => fs.readFile(path.join(rootDir, file), "utf8"),
    catch: (cause) => crash(`cannot read registry file ${file}: ${String(cause)}`),
  })

const unwrap = (expression: ts.Expression): ts.Expression =>
  ts.isAsExpression(expression) ||
  ts.isSatisfiesExpression(expression) ||
  ts.isParenthesizedExpression(expression) ||
  ts.isTypeAssertionExpression(expression)
    ? unwrap(expression.expression)
    : expression

/** `x`, `x.y`, `x.y.z` → `x`. */
const rootIdentifier = (expression: ts.Expression): Option.Option<string> =>
  ts.isIdentifier(expression)
    ? Option.some(expression.text)
    : ts.isPropertyAccessExpression(expression)
      ? rootIdentifier(expression.expression)
      : Option.none()

/** Each local name an import binds → the module it comes from. */
const importedModules = (sourceFile: ts.SourceFile): ReadonlyMap<string, string> =>
  new Map(
    sourceFile.statements.flatMap((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return []
      const from = statement.moduleSpecifier.text
      const clause = statement.importClause
      const bindings = clause?.namedBindings
      const locals = [
        ...(clause?.name === undefined ? [] : [clause.name.text]),
        ...(bindings === undefined
          ? []
          : ts.isNamespaceImport(bindings)
            ? [bindings.name.text]
            : bindings.elements.map((element) => element.name.text)),
      ]
      return locals.map((local) => [local, from] as const)
    }),
  )

/** The entries of a top-level `const <name> = [...]`: its string elements,
 *  and the module of each imported binding an element names. */
const constEntries = (sourceFile: ts.SourceFile, name: string): Option.Option<ReadonlyArray<string>> => {
  const imports = importedModules(sourceFile)
  return Option.fromNullishOr(
    sourceFile.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => statement.declarationList.declarations)
      .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name)?.initializer,
  ).pipe(
    Option.map(unwrap),
    Option.filter(ts.isArrayLiteralExpression),
    Option.map((array) =>
      array.elements.flatMap((element) =>
        ts.isStringLiteralLike(element)
          ? [element.text]
          : Option.match(
              rootIdentifier(element).pipe(Option.flatMap((local) => Option.fromNullishOr(imports.get(local)))),
              { onNone: () => [], onSome: (module) => [module] },
            ),
      ),
    ),
  )
}

/** The keys of the object at `keys` in a JSON (comments allowed) text. */
const jsonKeys = (file: string, text: string, keys: ReadonlyArray<string>): Option.Option<ReadonlyArray<string>> => {
  const parsed: { readonly config?: unknown; readonly error?: ts.Diagnostic } = ts.parseConfigFileTextToJson(file, text)
  return parsed.error !== undefined
    ? Option.none()
    : keys
        .reduce<Option.Option<unknown>>(
          (current, key) =>
            current.pipe(
              Option.filter(Predicate.isObject),
              Option.flatMap((object) => Option.fromNullishOr(object[key])),
            ),
          Option.some(parsed.config),
        )
        .pipe(
          Option.filter(Predicate.isObject),
          Option.map((object) => Object.keys(object)),
        )
}

const missing = (pkg: WorkspacePackage, message: string, hint: string): Finding =>
  new Finding({
    rule: PACKAGE_REGISTERED,
    severity: "error",
    message: `${pkg.path} (${pkg.name}) ${message}`,
    location: Option.none(),
    fixHint: Option.some(hint),
  })

const hintFor = (registry: { readonly hint: Option.Option<string> }, pkg: WorkspacePackage, fallback: string): string =>
  Option.match(registry.hint, { onNone: () => fallback, onSome: (hint) => fill(hint, pkg) })

const checkProfile = (
  registry: ProfileRegistry,
  config: GateSuiteConfig,
  packages: ReadonlyArray<WorkspacePackage>,
): ReadonlyArray<Finding> =>
  packages.flatMap((pkg) => {
    const probe = fill(registry.probe, pkg)
    return Match.value(registry.source).pipe(
      Match.when("rules", () =>
        config.rules.some((rule) => includedBy(rule.include, rule.exclude, probe))
          ? []
          : [
              missing(
                pkg,
                `is gated by none of this profile's rules: no rule's include covers ${probe}, so its sources get no rule findings`,
                hintFor(registry, pkg, `add a glob covering ${probe} to the rules' include`),
              ),
            ],
      ),
      Match.when("boundaries", () =>
        Option.exists(config.boundaries, (boundaries) => boundaries.layers.some((layer) => matchesGlob(layer.path, probe)))
          ? []
          : [
              missing(
                pkg,
                `is in none of this profile's boundaries layers: no layer's path covers ${probe}, so its imports are never checked`,
                hintFor(registry, pkg, `add a boundaries layer whose path covers ${probe}`),
              ),
            ],
      ),
      Match.exhaustive,
    )
  })

const checkEntries = (
  registry: ConstRegistry | JsonKeysRegistry,
  where: string,
  entries: ReadonlyArray<string>,
  packages: ReadonlyArray<WorkspacePackage>,
): ReadonlyArray<Finding> =>
  packages.flatMap((pkg) => {
    const entry = fill(registry.entry, pkg)
    return entries.includes(entry)
      ? []
      : [missing(pkg, `is missing from ${where} (expected "${entry}")`, hintFor(registry, pkg, `add "${entry}" to ${where}`))]
  })

const checkRegistry = (
  rootDir: string,
  config: GateSuiteConfig,
  registration: RegistrationConfig,
  registry: RegistrySpec,
  allPackages: ReadonlyArray<WorkspacePackage>,
): Effect.Effect<ReadonlyArray<Finding>, GateCrash> => {
  const packages = allPackages.filter((pkg) =>
    includedBy(registry.include, [...registration.exclude, ...registry.exclude], pkg.path),
  )
  return Match.value(registry).pipe(
    Match.discriminator("source")("rules", "boundaries", (profile) => Effect.succeed(checkProfile(profile, config, packages))),
    Match.discriminator("source")("const", (list) => {
      const where = `\`${list.name}\` in ${list.file}`
      return readWorkspaceFile(rootDir, list.file).pipe(
        Effect.flatMap((text) =>
          Option.match(constEntries(ts.createSourceFile(list.file, text, ts.ScriptTarget.Latest, true), list.name), {
            onNone: () => Effect.fail(crash(`${list.file} declares no top-level array \`const ${list.name} = [...]\``)),
            onSome: (entries) => Effect.succeed(checkEntries(list, where, entries, packages)),
          }),
        ),
      )
    }),
    Match.discriminator("source")("json-keys", (object) => {
      const where = `${object.keys.join(".")} in ${object.file}`
      return readWorkspaceFile(rootDir, object.file).pipe(
        Effect.flatMap((text) =>
          Option.match(jsonKeys(object.file, text, object.keys), {
            onNone: () => Effect.fail(crash(`${object.file} has no object at ${object.keys.join(".")}`)),
            onSome: (entries) => Effect.succeed(checkEntries(object, where, entries, packages)),
          }),
        ),
      )
    }),
    Match.exhaustive,
  )
}

/**
 * Registration as a GATE: every package under the configured roots must be
 * listed in each registry the config names (the profile's own rules and
 * boundaries layers, a build script's package list, a tsconfig's paths…).
 * A package missing from one is otherwise skipped there in silence —
 * ungated, unbuilt or unpublished. Repo knowledge stays in the config: this
 * gate only reads the places it is pointed at.
 */
export const makeRegistrationGate = (config: GateSuiteConfig, registration: RegistrationConfig): Gate => ({
  name: REGISTRATION_GATE,
  kind: "static",
  deterministic: true,
  run: (workspace: Workspace) =>
    discoverPackages(workspace.rootDir, registration.roots).pipe(
      Effect.flatMap((packages) =>
        Effect.forEach(registration.registries, (registry) =>
          checkRegistry(workspace.rootDir, config, registration, registry, packages),
          { concurrency: 1 },
        ),
      ),
      Effect.map((findings) => findings.flat()),
    ),
})
