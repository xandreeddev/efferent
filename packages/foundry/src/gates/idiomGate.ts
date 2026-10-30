import { Effect, Option } from "effect"
import * as path from "node:path"
import * as ts from "typescript"
import { GateName } from "../domain/Brands.js"
import type { RuleId } from "../domain/Brands.js"
import { GateCrash } from "../domain/Errors.js"
import { Finding } from "../domain/Finding.js"
import type { Severity } from "../domain/Finding.js"
import type { RuleConfig } from "../domain/Rules.js"
import type { Gate, Workspace } from "../ports/Gate.js"
import { includedBy, locationOf, matchesGlob, projectSourceFiles, toWorkspacePath } from "./astWalk.js"
import { TsProject } from "./TsProject.port.js"

export interface RuleContext {
  readonly sourceFile: ts.SourceFile
  readonly checker: ts.TypeChecker
}

export interface RuleMatch {
  readonly node: ts.Node
  readonly message: string
  /** Dropped in the files the rule's config declares a `boundary`, where
   *  the profile tolerates this kind of match (an `as never` where type
   *  erasure is the design; a discriminant ternary in code not yet
   *  converted to `Match`); reported elsewhere. A boundary glob whose
   *  files hold none is stale and fails. */
  readonly toleratedAtBoundary?: boolean
}

/** An idiom rule is DATA plus one pure check — which rules run where, and at
 *  what severity, lives in `GateSuiteConfig`, not in code. */
export interface IdiomRule {
  readonly id: RuleId
  readonly defaultSeverity: Severity
  readonly description: string
  readonly fixHint: string
  readonly check: (ctx: RuleContext) => ReadonlyArray<RuleMatch>
}

export const IDIOM_GATE = GateName.make("effect-idioms")

interface ActiveRule {
  readonly rule: IdiomRule
  readonly severity: Severity
  readonly include: ReadonlyArray<string>
  readonly exclude: ReadonlyArray<string>
  readonly boundary: ReadonlyArray<string>
  readonly allow: ReadonlyArray<string>
}

const activate = (
  rules: ReadonlyArray<IdiomRule>,
  configs: ReadonlyArray<RuleConfig>,
): Effect.Effect<ReadonlyArray<ActiveRule>, GateCrash> =>
  Effect.forEach(configs, (config) =>
    Option.match(
      Option.fromNullishOr(rules.find((r) => r.id === config.rule)),
      {
        onNone: () =>
          Effect.fail(
            new GateCrash({
              gate: IDIOM_GATE,
              message: `config names unknown rule "${config.rule}" — the registry comes from the config module's own rulePacks/customRules exports; known: ${
                rules.length > 0 ? rules.map((r) => r.id).join(", ") : "(none exported)"
              }`,
            }),
          ),
        onSome: (rule) =>
          Effect.succeed<ActiveRule>({
            rule,
            severity: Option.getOrElse(config.severity, () => rule.defaultSeverity),
            include: config.include,
            exclude: config.exclude,
            boundary: config.boundary,
            allow: config.allow,
          }),
      },
    ),
    { concurrency: 1 },
  )

/**
 * The AST rule engine over the shared `ts.Program`. Type-aware where a rule
 * needs it (`no-nullable-return` reads inferred return types from the
 * checker) — the reason this is compiler-API, not pattern matching.
 */
export const makeIdiomGate = (
  rules: ReadonlyArray<IdiomRule>,
  configs: ReadonlyArray<RuleConfig>,
  tsconfigRel: string,
): Gate<TsProject> => ({
  name: IDIOM_GATE,
  kind: "static",
  deterministic: true,
  run: Effect.fnUntraced(
    function* (workspace: Workspace) {
      const active = yield* activate(rules, configs)
      const tsp = yield* TsProject
      const project = yield* tsp
        .load(path.resolve(workspace.rootDir, tsconfigRel))
        .pipe(
          Effect.mapError(
            (e) => new GateCrash({ gate: IDIOM_GATE, message: e.message }),
          ),
        )
      const sourceFiles = projectSourceFiles(project, workspace.rootDir)
      // Every file each rule covers, checked once: the findings, and the
      // allow and boundary entries that no longer excuse anything, read it.
      const checked = sourceFiles.flatMap((sourceFile) => {
        const rel = toWorkspacePath(workspace.rootDir, sourceFile.fileName)
        return active
          .filter((a) => includedBy(a.include, a.exclude, rel))
          .map((a): Checked => ({ active: a, sourceFile, rel, matches: a.rule.check({ sourceFile, checker: project.checker }) }))
      })
      const findings = checked
        .filter((c) => !c.active.allow.includes(c.rel))
        .flatMap((c) =>
          reported(c).map(
            (match) =>
              new Finding({
                rule: c.active.rule.id,
                severity: c.active.severity,
                message: match.message,
                location: Option.some(locationOf(c.sourceFile, match.node, workspace.rootDir)),
                fixHint: Option.some(c.active.rule.fixHint),
              }),
          ),
        )
      return [
        ...findings,
        ...active.flatMap((a) => {
          const covered = checked.filter((c) => c.active === a)
          return [...staleAllowances(a, covered), ...staleBoundaries(a, covered)]
        }),
      ]
    },
  ),
})

/** One file a rule covers, and every match its check found there. */
interface Checked {
  readonly active: ActiveRule
  readonly sourceFile: ts.SourceFile
  readonly rel: string
  readonly matches: ReadonlyArray<RuleMatch>
}

const atBoundary = (c: Checked): boolean => c.active.boundary.some((glob) => matchesGlob(glob, c.rel))

/** The matches that report: in a boundary file, less those the rule tolerates there. */
const reported = (c: Checked): ReadonlyArray<RuleMatch> =>
  atBoundary(c) ? c.matches.filter((match) => match.toleratedAtBoundary !== true) : c.matches

const staleEntry = (a: ActiveRule, list: "allow" | "boundary", entry: string, why: string): Finding =>
  new Finding({
    rule: a.rule.id,
    severity: a.severity,
    message: `the ${list} list entry "${entry}" ${why}`,
    location: Option.none(),
    fixHint: Option.some(`remove the entry from the rule's \`${list}\` list in the profile; the list only shrinks`),
  })

/** The `allow` entries that no longer excuse anything: a path that is not
 *  a file the rule covers (renamed, deleted, outside its globs), or a file
 *  the rule no longer flags. Each one fails, so the list only shrinks. */
const staleAllowances = (a: ActiveRule, covered: ReadonlyArray<Checked>): ReadonlyArray<Finding> =>
  a.allow.flatMap((entry) =>
    Option.match(Option.fromNullishOr(covered.find((c) => c.rel === entry)), {
      onNone: () => [staleEntry(a, "allow", entry, "names no file this rule checks (renamed, deleted or outside its include)")],
      onSome: (c) => (reported(c).length === 0 ? [staleEntry(a, "allow", entry, "passes this rule now")] : []),
    }),
  )

/** The `boundary` globs that no longer excuse anything: one that names no
 *  file the rule covers (less its `allow` files, which it skips), or whose
 *  files hold no match the rule tolerates there. Each one fails, so a
 *  boundary, like an allow list, only shrinks. */
const staleBoundaries = (a: ActiveRule, covered: ReadonlyArray<Checked>): ReadonlyArray<Finding> =>
  a.boundary.flatMap((glob) => {
    const files = covered.filter((c) => !a.allow.includes(c.rel) && matchesGlob(glob, c.rel))
    return files.length === 0
      ? [staleEntry(a, "boundary", glob, "names no file this rule checks (renamed, deleted or outside its include)")]
      : files.some((c) => c.matches.some((match) => match.toleratedAtBoundary === true))
        ? []
        : [staleEntry(a, "boundary", glob, "tolerates nothing now: no file it names has a match the rule drops there")]
  })
