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
import { includedBy, locationOf, projectSourceFiles, toWorkspacePath } from "./astWalk.js"
import { TsProject } from "./TsProject.js"

export interface RuleContext {
  readonly sourceFile: ts.SourceFile
  readonly checker: ts.TypeChecker
}

export interface RuleMatch {
  readonly node: ts.Node
  readonly message: string
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
}

const activate = (
  rules: ReadonlyArray<IdiomRule>,
  configs: ReadonlyArray<RuleConfig>,
): Effect.Effect<ReadonlyArray<ActiveRule>, GateCrash> =>
  Effect.forEach(configs, (config) =>
    Option.match(
      Option.fromNullable(rules.find((r) => r.id === config.rule)),
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
      return projectSourceFiles(project, workspace.rootDir).flatMap((sourceFile) => {
        const rel = toWorkspacePath(workspace.rootDir, sourceFile.fileName)
        return active
          .filter((a) => includedBy(a.include, a.exclude, rel))
          .flatMap((a) =>
            a.rule
              .check({ sourceFile, checker: project.checker })
              .map(
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
    }),
})
