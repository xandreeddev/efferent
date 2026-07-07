import { Array as Arr, Effect, Option, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { ConfigError, WorkspaceError } from "../domain/Errors.js"
import type { Finding } from "../domain/Finding.js"
import { GateSuiteConfig } from "../domain/Rules.js"
import type { Gate, Workspace } from "../ports/Gate.js"
import { BaselineFile, diffAgainstBaseline, fingerprint } from "../pipeline/baseline.js"
import type { FingerprintedFinding } from "../pipeline/baseline.js"
import { runPipeline } from "../pipeline/runPipeline.js"
import { makeBoundariesGate } from "../gates/boundariesGate.js"
import { makeEvalShapeGate } from "../gates/evalShapeGate.js"
import { makeIdiomGate } from "../gates/idiomGate.js"
import { builtinRules } from "../gates/rules/index.js"
import { makeTypecheckGate } from "../gates/typecheckGate.js"
import type { TsProject } from "../gates/TsProject.js"
import { renderFindingLine, renderReport, renderReportSummary } from "./report.js"

export interface CheckArgs {
  readonly configPath: string
  readonly baselinePath: Option.Option<string>
  readonly updateBaseline: boolean
}

const loadConfig = (
  configPath: string,
): Effect.Effect<{ readonly config: GateSuiteConfig; readonly rootDir: string }, ConfigError> =>
  Effect.tryPromise({
    try: () => import(pathToFileURL(path.resolve(configPath)).href),
    catch: (cause) => new ConfigError({ path: configPath, message: String(cause) }),
  }).pipe(
    Effect.flatMap((module: { readonly default?: unknown }) =>
      Schema.decodeUnknown(GateSuiteConfig)(module.default).pipe(
        Effect.mapError(
          (parseError) => new ConfigError({ path: configPath, message: parseError.message }),
        ),
      ),
    ),
    Effect.map((config) => ({ config, rootDir: path.dirname(path.resolve(configPath)) })),
  )

/** The full static suite a config describes, in rank order. */
export const gatesFromConfig = (
  config: GateSuiteConfig,
): Arr.NonEmptyReadonlyArray<Gate<TsProject>> => [
  makeIdiomGate(builtinRules, config.rules, config.tsconfig),
  ...Option.match(config.boundaries, {
    onNone: () => [] as ReadonlyArray<Gate<TsProject>>,
    onSome: (layers) => [makeBoundariesGate(layers, config.tsconfig)],
  }),
  ...Option.match(config.evalShape, {
    onNone: () => [] as ReadonlyArray<Gate<TsProject>>,
    onSome: (evalShape) => [makeEvalShapeGate(evalShape, config.tsconfig)],
  }),
  ...(config.typecheck ? [makeTypecheckGate(config.tsconfig)] : []),
]

/** Error findings with fingerprints keyed on their source line's content. */
const fingerprintFindings = (
  findings: ReadonlyArray<Finding>,
  rootDir: string,
): Effect.Effect<ReadonlyArray<FingerprintedFinding>, WorkspaceError> =>
  Effect.forEach(findings, (finding) =>
    Option.match(finding.location, {
      onNone: () => Effect.succeed({ finding, fingerprint: fingerprint(finding, Option.none()) }),
      onSome: (location) =>
        Effect.tryPromise({
          try: () => fs.readFile(path.join(rootDir, location.file), "utf8"),
          catch: (cause) => new WorkspaceError({ message: String(cause) }),
        }).pipe(
          Effect.map((text) => ({
            finding,
            fingerprint: fingerprint(finding, Option.fromNullable(text.split("\n")[location.line - 1])),
          })),
        ),
    }),
  )

const readBaseline = (baselinePath: string): Effect.Effect<ReadonlySet<string>, ConfigError> =>
  Effect.tryPromise({
    try: () => fs.readFile(baselinePath, "utf8"),
    catch: () => new ConfigError({ path: baselinePath, message: "unreadable" }),
  }).pipe(
    Effect.flatMap((text) =>
      Schema.decodeUnknown(Schema.parseJson(BaselineFile))(text).pipe(
        Effect.mapError(
          (parseError) => new ConfigError({ path: baselinePath, message: parseError.message }),
        ),
      ),
    ),
    Effect.map((file) => new Set(file.fingerprints) as ReadonlySet<string>),
    // An absent baseline means "nothing grandfathered", not an error.
    Effect.catchAll(() => Effect.succeed(new Set<string>() as ReadonlySet<string>)),
  )

const writeBaseline = (
  baselinePath: string,
  fingerprints: ReadonlyArray<string>,
): Effect.Effect<void, WorkspaceError> =>
  Schema.encode(Schema.parseJson(BaselineFile))({ version: 1, fingerprints }).pipe(
    Effect.mapError((e) => new WorkspaceError({ message: e.message })),
    Effect.flatMap((text) =>
      Effect.tryPromise({
        try: async () => {
          await fs.mkdir(path.dirname(baselinePath), { recursive: true })
          await fs.writeFile(baselinePath, `${text}\n`)
        },
        catch: (cause) => new WorkspaceError({ message: String(cause) }),
      }),
    ),
  )

/**
 * `foundry check`: run the config's gate suite over its workspace. With a
 * baseline, pre-existing findings are grandfathered (the ratchet); without
 * one, any error finding fails.
 */
export const runCheck = (
  args: CheckArgs,
): Effect.Effect<number, ConfigError | WorkspaceError, TsProject> =>
  Effect.gen(function* () {
    const { config, rootDir } = yield* loadConfig(args.configPath)
    const workspace: Workspace = { rootDir, files: [] }
    const report = yield* runPipeline(
      { gates: gatesFromConfig(config), policy: "collect-all" },
      workspace,
    )
    yield* Effect.sync(() =>
      console.log(
        Option.isSome(args.baselinePath) ? renderReportSummary(report) : renderReport(report),
      ),
    )

    return yield* Option.match(args.baselinePath, {
      onNone: () => Effect.succeed(report.ok ? 0 : 1),
      onSome: (baselinePath) =>
        Effect.gen(function* () {
          const errors = report.failures.flatMap((v) => v.findings)
          const entries = yield* fingerprintFindings(errors, rootDir)
          const baseline = yield* readBaseline(baselinePath)
          const diff = diffAgainstBaseline(entries, baseline)
          if (args.updateBaseline) {
            yield* writeBaseline(baselinePath, diff.current)
            yield* Effect.sync(() =>
              console.log(`baseline updated: ${diff.current.length} grandfathered findings → ${baselinePath}`),
            )
            return 0
          }
          yield* Effect.sync(() => {
            console.log(
              `baseline: ${baseline.size} grandfathered · ${diff.fresh.length} NEW finding${diff.fresh.length === 1 ? "" : "s"}`,
            )
            diff.fresh.forEach((entry) => console.log(`  ${renderFindingLine(entry.finding)}`))
          })
          return diff.fresh.length > 0 ? 1 : 0
        }),
    })
  })
