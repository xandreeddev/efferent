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
   *  converted to `Match`); reported elsewhere. */
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
  run: (workspace: Workspace) =>
    Effect.gen(function* () {
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
      const matchesOf = (a: ActiveRule, sourceFile: ts.SourceFile, rel: string): ReadonlyArray<RuleMatch> => {
        const atBoundary = a.boundary.some((glob) => matchesGlob(glob, rel))
        return a.rule
          .check({ sourceFile, checker: project.checker })
          .filter((match) => !(atBoundary && match.toleratedAtBoundary === true))
      }
      const findings = sourceFiles.flatMap((sourceFile) => {
        const rel = toWorkspacePath(workspace.rootDir, sourceFile.fileName)
        return active
          .filter((a) => includedBy(a.include, a.exclude, rel) && !a.allow.includes(rel))
          .flatMap((a) =>
            matchesOf(a, sourceFile, rel).map(
              (match) =>
                new Finding({
                  rule: a.rule.id,
                  severity: a.severity,
                  message: match.message,
                  location: Option.some(
                    locationOf(sourceFile, match.node, workspace.rootDir),
                  ),
                  fixHint: Option.some(a.rule.fixHint),
                }),
            ),
          )
      })
      return [...findings, ...active.flatMap((a) => staleAllowances(a, sourceFiles, workspace.rootDir, matchesOf))]
    }),
})

/** The `allow` entries that no longer excuse anything: a path that is not
 *  a file the rule covers (renamed, deleted, outside its globs), or a file
 *  the rule no longer flags. Each one fails, so the list only shrinks. */
const staleAllowances = (
  a: ActiveRule,
  sourceFiles: ReadonlyArray<ts.SourceFile>,
  rootDir: string,
  matchesOf: (a: ActiveRule, sourceFile: ts.SourceFile, rel: string) => ReadonlyArray<RuleMatch>,
): ReadonlyArray<Finding> =>
  a.allow.flatMap((entry) => {
    const covered = Option.fromNullishOr(
      sourceFiles.find((sourceFile) => {
        const rel = toWorkspacePath(rootDir, sourceFile.fileName)
        return rel === entry && includedBy(a.include, a.exclude, rel)
      }),
    )
    const reason = Option.match(covered, {
      onNone: () => Option.some("names no file this rule checks (renamed, deleted or outside its include)"),
      onSome: (sourceFile) =>
        matchesOf(a, sourceFile, entry).length === 0 ? Option.some("passes this rule now") : Option.none(),
    })
    return Option.match(reason, {
      onNone: () => [],
      onSome: (why) => [
        new Finding({
          rule: a.rule.id,
          severity: a.severity,
          message: `the allow list entry "${entry}" ${why}`,
          location: Option.none(),
          fixHint: Option.some("remove the entry from the rule's `allow` list in the profile; the list only shrinks"),
        }),
      ],
    })
  })
