import { Schema, Effect } from "effect"
import { RuleId } from "./Brands.js"
import { Severity } from "./Finding.js"

/**
 * Rules-as-data: WHICH rules run WHERE is config, not code. A config file
 * exports a plain object (`typeof GateSuiteConfig.Encoded`); the CLI decodes
 * it — authors never touch `Option`, consumers never touch `undefined`.
 */

export class RuleConfig extends Schema.Class<RuleConfig>("RuleConfig")({
  rule: RuleId,
  /** Overrides the rule's default severity. */
  severity: Schema.OptionFromOptional(Severity),
  /** Globs relative to the workspace root. */
  include: Schema.Array(Schema.NonEmptyString).pipe(Schema.withDecodingDefaultType(Effect.sync(() => ["**/*.ts"])), Schema.withConstructorDefault(Effect.sync(() => ["**/*.ts"]))),
  exclude: Schema.Array(Schema.NonEmptyString).pipe(Schema.withDecodingDefaultType(Effect.sync(() => [])), Schema.withConstructorDefault(Effect.sync(() => []))),
  /** Globs of the files the profile declares a boundary for this rule
   *  (`effect/no-as-never`'s type-erasure files): a match the rule marks as
   *  tolerated at a boundary is dropped there; every other match still
   *  reports. A glob that names no file the rule covers, or whose files
   *  hold no tolerated match, is itself a finding, so the list only
   *  shrinks. */
  boundary: Schema.Array(Schema.NonEmptyString).pipe(Schema.withDecodingDefaultType(Effect.sync(() => [])), Schema.withConstructorDefault(Effect.sync(() => []))),
  /** Workspace-relative paths (exact, not globs) of the files the rule
   *  skips: a frozen list of today's exceptions that may only shrink. An
   *  entry that names no file the rule covers, or a file the rule no
   *  longer flags, is itself a finding, so a fixed, renamed or deleted
   *  file leaves the list in the same change. */
  allow: Schema.Array(Schema.NonEmptyString).pipe(Schema.withDecodingDefaultType(Effect.sync(() => [])), Schema.withConstructorDefault(Effect.sync(() => []))),
}) {}

/**
 * One layer of the boundaries gate; a file belongs to the first layer whose
 * `path` matches it. A relative import never leaves its package (the nearest
 * directory with a `package.json`). A bare import that names a package of the
 * workspace by its `package.json` name reaches the layer holding that
 * package's entry (what its `exports` maps `.` to), and only a subpath its
 * `exports` lists; a layer whose name ends in `-tests` may also reach the
 * package's testing modules (`testing`, `<name>.testing`, `testing/…`),
 * which no `exports` lists. Every other bare import is an external.
 */
export class LayerSpec extends Schema.Class<LayerSpec>("LayerSpec")({
  name: Schema.NonEmptyString,
  /** Glob (workspace-relative) locating this layer's files. */
  path: Schema.NonEmptyString,
  /** Names of layers this one may import (itself is always allowed), by a
   *  relative import or by a workspace package's name. `<layer>/<subpath>`
   *  grants one of that layer's `restricted` subpaths. */
  canImport: Schema.Array(Schema.NonEmptyString),
  /** Allowed external module prefixes (e.g. `effect`, `typescript`, `node:`),
   *  for bare imports that name no workspace package. */
  externals: Schema.Array(Schema.NonEmptyString),
  /** Subpaths of the package whose entry is in this layer (`internal`) that
   *  another layer reaches only when its `canImport` names
   *  `<layer>/<subpath>`; `canImport: ["<layer>"]` reaches the root and the
   *  other exported subpaths. */
  restricted: Schema.Array(Schema.NonEmptyString).pipe(Schema.withDecodingDefaultType(Effect.sync(() => [])), Schema.withConstructorDefault(Effect.sync(() => []))),
}) {}

export class LayerConfig extends Schema.Class<LayerConfig>("LayerConfig")({
  layers: Schema.NonEmptyArray(LayerSpec),
}) {}


/** A STANDING command check — the project's own scripts (lint, format,
 *  design-token audits) as part of the profile: exit 0 = clean. Armed by
 *  smith's gate discovery as rank-2 command gates; the `foundry check` CLI
 *  ignores them (it runs the static suite only). */
export class CheckConfig extends Schema.Class<CheckConfig>("CheckConfig")({
  name: Schema.NonEmptyString,
  /** One line of shell, run through `bash -c` from the workspace root. */
  command: Schema.NonEmptyString,
  /** Cost rank for a standing command. Existing profiles decode as `test`. */
  kind: Schema.Literals(["test", "eval"]).pipe(Schema.withDecodingDefaultType(Effect.sync(() => "test" as const)), Schema.withConstructorDefault(Effect.sync(() => "test" as const))),
  /** Per-command wall-clock bound. */
  timeoutMs: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))).pipe(Schema.withDecodingDefaultType(Effect.sync(() => 300_000)), Schema.withConstructorDefault(Effect.sync(() => 300_000))),
}) {}

/**
 * Registration: in a monorepo a package is gated, built and published only
 * once it is listed by hand in several places, and a package missing from
 * one of them is silently skipped there. Each registry below is one such
 * place; the registration gate reports every package one of them misses.
 *
 * Templates (`entry`, `probe`, `hint`) name one package: `{path}` is its
 * workspace-relative directory (`packages/core`), `{dir}` that directory's
 * own name (`core`), `{name}` its `package.json` name (`@scope/core`).
 * `include`/`exclude` are globs over `{path}`: which packages a registry
 * applies to.
 */
const PackageGlobs = (fallback: ReadonlyArray<string>) =>
  Schema.Array(Schema.NonEmptyString).pipe(Schema.withDecodingDefaultType(Effect.sync(() => fallback)), Schema.withConstructorDefault(Effect.sync(() => fallback)))

/** This profile's own data: the package's `probe` file must be covered by an
 *  armed rule's `include` (and not its `exclude`) — `rules` — or by a
 *  boundaries layer's `path` — `boundaries`. */
export class ProfileRegistry extends Schema.Class<ProfileRegistry>("ProfileRegistry")({
  source: Schema.Literals(["rules", "boundaries"]),
  probe: Schema.NonEmptyString.pipe(Schema.withDecodingDefaultType(Effect.sync(() => "{path}/src/index.ts")), Schema.withConstructorDefault(Effect.sync(() => "{path}/src/index.ts"))),
  include: PackageGlobs(["**"]),
  exclude: PackageGlobs([]),
  /** The fix, when the default (cover the probe) is too vague. */
  hint: Schema.OptionFromOptional(Schema.NonEmptyString),
}) {}

/** A top-level `const <name> = [...]` in a TypeScript file. Its entries are
 *  its string elements and, for an element naming an imported binding
 *  (`ns.plugin`), the module that import comes from. */
export class ConstRegistry extends Schema.Class<ConstRegistry>("ConstRegistry")({
  source: Schema.Literal("const"),
  /** Workspace-relative. */
  file: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  /** What must be among the entries, e.g. `{dir}` or `{name}`. */
  entry: Schema.NonEmptyString,
  include: PackageGlobs(["**"]),
  exclude: PackageGlobs([]),
  hint: Schema.OptionFromOptional(Schema.NonEmptyString),
}) {}

/** The keys of the object at `keys` in a JSON file (comments allowed), e.g.
 *  a tsconfig's `compilerOptions.paths`. */
export class JsonKeysRegistry extends Schema.Class<JsonKeysRegistry>("JsonKeysRegistry")({
  source: Schema.Literal("json-keys"),
  file: Schema.NonEmptyString,
  keys: Schema.NonEmptyArray(Schema.NonEmptyString),
  entry: Schema.NonEmptyString,
  include: PackageGlobs(["**"]),
  exclude: PackageGlobs([]),
  hint: Schema.OptionFromOptional(Schema.NonEmptyString),
}) {}

export const RegistrySpec = Schema.Union([ProfileRegistry, ConstRegistry, JsonKeysRegistry])
export type RegistrySpec = typeof RegistrySpec.Type

export class RegistrationConfig extends Schema.Class<RegistrationConfig>("RegistrationConfig")({
  /** Workspace-relative directories whose child directories holding a
   *  `package.json` are the packages (`packages` for `packages/*`). */
  roots: Schema.NonEmptyArray(Schema.NonEmptyString),
  /** Packages (globs over `{path}`) that no registry applies to. */
  exclude: PackageGlobs([]),
  registries: Schema.NonEmptyArray(RegistrySpec),
}) {}

/**
 * Private text: no file git tracks (or would track: untracked files that
 * are not ignored count) may hold an absolute home path —
 * `/home/<name>/`, `/Users/<name>/`, `C:\Users\<name>\` — unless `<name>`
 * is one of the `placeholders`, nor a term from the optional local
 * `denylist`. Armed as the `private-text` gate (findings
 * `quality/no-private-text`).
 *
 * The denylist is a text file the profile names but never commits: one
 * term per line, blank lines and lines starting with `#` skipped, matched
 * case-insensitively as a whole word (not inside a longer word). An absent
 * file checks the paths only; a denylist git does not ignore is itself a
 * finding, since committing it would publish what it lists.
 */
export class PrivateTextConfig extends Schema.Class<PrivateTextConfig>("PrivateTextConfig")({
  /** Globs (workspace-relative) of the files to read. */
  include: Schema.Array(Schema.NonEmptyString).pipe(Schema.withDecodingDefaultType(Effect.sync(() => ["**"])), Schema.withConstructorDefault(Effect.sync(() => ["**"]))),
  exclude: Schema.Array(Schema.NonEmptyString).pipe(Schema.withDecodingDefaultType(Effect.sync(() => [])), Schema.withConstructorDefault(Effect.sync(() => []))),
  /** Home-directory names that stand for nobody (`user`, `runner`), compared case-insensitively. */
  placeholders: Schema.Array(Schema.NonEmptyString).pipe(Schema.withDecodingDefaultType(Effect.sync(() => [])), Schema.withConstructorDefault(Effect.sync(() => []))),
  /** Workspace-relative path of the local denylist. */
  denylist: Schema.OptionFromOptional(Schema.NonEmptyString),
}) {}

/** What `foundry check --baseline <f>` may do with the baseline file.
 *  `ratchet`: its fingerprints are grandfathered. `empty`: the file is only
 *  the ratchet's anchor; it grandfathers nothing, and a file that holds any
 *  fingerprint fails the check (`quality/baseline-empty`), so a grown
 *  baseline cannot pass CI. */
export const BaselinePolicy = Schema.Literals(["ratchet", "empty"])
export type BaselinePolicy = typeof BaselinePolicy.Type

/** One gate-suite target: a tsconfig + the rule/boundary/eval policy over it. */
export class GateSuiteConfig extends Schema.Class<GateSuiteConfig>("GateSuiteConfig")({
  /** Workspace-relative path to the tsconfig the shared `ts.Program` builds from. */
  tsconfig: Schema.NonEmptyString,
  rules: Schema.Array(RuleConfig),
  boundaries: Schema.OptionFromOptional(LayerConfig),
  /** Every package must be listed in each registry; armed as the
   *  `registration` gate. */
  registration: Schema.OptionFromOptional(RegistrationConfig),
  /** No home path or denylisted term in the files git tracks; armed as
   *  the `private-text` gate. */
  privateText: Schema.OptionFromOptional(PrivateTextConfig),
  /** The baseline policy; `ratchet` unless the profile says otherwise. */
  baseline: BaselinePolicy.pipe(Schema.withDecodingDefaultType(Effect.sync(() => "ratchet" as const)), Schema.withConstructorDefault(Effect.sync(() => "ratchet" as const))),
  checks: Schema.Array(CheckConfig).pipe(Schema.withDecodingDefaultType(Effect.sync(() => [])), Schema.withConstructorDefault(Effect.sync(() => []))),
  /** Run the typecheck gate too. Set false when `tsc` already runs beside
   *  this check (e.g. the repo's `bun run typecheck`) — no double program check. */
  typecheck: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => true)), Schema.withConstructorDefault(Effect.sync(() => true))),
}) {}
