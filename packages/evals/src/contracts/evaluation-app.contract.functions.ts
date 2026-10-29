import { Array as Arr, Effect, Layer, Option, Predicate, Result, Schema, SchemaIssue } from "effect"
import { AppViolation, EvaluationError, Fingerprints } from "../domain/identity.entity.js"
import { Suite, type Gate } from "../domain/suite.entity.js"
import type { Task } from "../domain/task.entity.js"
import { Calibration } from "../domain/calibration.entity.js"
import { Runnable } from "../domain/runnable.entity.js"
import { Grader } from "../domain/grader.entity.js"
import { EvidenceProjection } from "../domain/evidence-projection.entity.js"
import type { TrialExecution } from "../ports/trial-execution.port.js"
import type { EvidenceProjector } from "../ports/evidence-projector.port.js"
import type { GraderAssessment } from "../ports/grader-assessment.port.js"
import type { EvaluationExport } from "../ports/evaluation-export.port.js"
import type { EvaluationApp } from "./evaluation-app.contract.js"

export const defineEvaluationApp = (
  application: EvaluationApp
): EvaluationApp => application

/** A Layer by its marker: the services it provides and its error exist only in
 *  its type, so the registration's type names them and the value is checked to be a Layer. */
const layerOf = <A, E = EvaluationError>() =>
  Schema.declare((value: unknown): value is Layer.Layer<A, E> => Layer.isLayer(value), { expected: "a Layer" })
const Command = Schema.declare(
  (value: unknown): value is (args: ReadonlyArray<string>) => Effect.Effect<unknown, EvaluationError> => Predicate.isFunction(value),
  { expected: "a function" }
)

/** An `EvaluationApp` as a value: its definitions as their decoded types
 *  (ids, gates and task inputs checked), its layers and commands by kind. */
const EvaluationAppShape = Schema.Struct({
  id: Schema.String,
  suites: Schema.Array(Schema.toType(Suite)),
  calibrations: Schema.Array(Schema.toType(Calibration)),
  runnables: Schema.Array(Schema.Struct({
    definition: Schema.toType(Runnable),
    environments: Schema.Array(Schema.Struct({ id: Schema.String, layer: layerOf<TrialExecution>() })),
  })),
  graders: Schema.Array(Schema.Struct({ definition: Schema.toType(Grader), layer: layerOf<GraderAssessment>() })),
  projections: Schema.Array(Schema.Struct({ definition: Schema.toType(EvidenceProjection), layer: layerOf<EvidenceProjector>() })),
  environmentFor: Schema.Record(Schema.String, Schema.String),
  fingerprints: Fingerprints,
  exporters: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String, layer: layerOf<EvaluationExport>() }))),
  observability: Schema.optionalKey(layerOf<never, never>()),
  commands: Schema.Record(Schema.String, Command),
})
const decodeShape = Schema.decodeUnknownResult(EvaluationAppShape, { errors: "all" })
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1()

type Path = AppViolation["path"]
const violation = (rule: AppViolation["rule"], path: Path, message: string): AppViolation => ({ rule, path, message })

/** Every entry whose key an earlier entry has, with its index. */
const repeated = <A>(entries: ReadonlyArray<A>, key: (entry: A) => string): ReadonlyArray<readonly [A, number]> => {
  const first = new Map(entries.map((entry, index) => [key(entry), index] as const).toReversed())
  return entries.flatMap((entry, index) => first.get(key(entry)) === index ? [] : [[entry, index] as const])
}
const duplicateIds = (noun: string, ids: ReadonlyArray<readonly [Path, string]>): ReadonlyArray<AppViolation> =>
  repeated(ids, ([, id]) => id).map(([[path, id]]) => violation("duplicate-id", path, `${noun} id "${id}" is used more than once`))

const graderKey = (grader: Grader): string => `${grader.id}@${grader.version}`
/** A dataset family, as a key that no pair of names can collide on. */
const familyOf = (task: Task): string => JSON.stringify([task.dataset, task.family])

interface Registry {
  readonly runnables: ReadonlySet<string>
  readonly graders: ReadonlyMap<string, Grader>
  readonly projections: ReadonlySet<string>
}

const taskViolations = (registry: Registry, at: Path, task: Task, family: ReadonlyArray<Task>): ReadonlyArray<AppViolation> => [
  ...(task.graders.length === 0 ? [violation("task-ungraded", [...at, "graders"], `task "${task.id}" binds no grader`)] : []),
  ...repeated(task.graders, (binding) => `${binding.grader}/${binding.scope}`).map(([binding, index]) =>
    violation("binding-duplicate", [...at, "graders", index], `grader "${binding.grader}" is bound twice in scope "${binding.scope}"`)),
  ...(family.some((other) => other.split !== task.split)
    ? [violation("split-mixed", [...at, "split"], `family "${task.family}" of dataset "${task.dataset}" is in more than one split`)]
    : []),
  ...(registry.runnables.has(task.runnable) ? [] : [violation("runnable-unknown", [...at, "runnable"], `runnable "${task.runnable}" is not registered`)]),
  ...task.graders.flatMap((binding, index) => [
    ...(registry.graders.has(binding.grader)
      ? []
      : [violation("grader-unknown", [...at, "graders", index, "grader"], `grader "${binding.grader}" is not registered (a grader key is <id>@<version>)`)]),
    ...(registry.projections.has(binding.projection)
      ? []
      : [violation("projection-unknown", [...at, "graders", index, "projection"], `projection "${binding.projection}" is not registered`)]),
  ]),
]

const gateViolations = (registry: Registry, at: Path, gate: Gate, suite: Suite): ReadonlyArray<AppViolation> => [
  ...(suite.tasks.some((task) => task.graders.some((binding) => binding.grader === gate.grader))
    ? []
    : [violation("gate-unbound", [...at, "grader"], `no task of suite "${suite.id}" binds grader "${gate.grader}"`)]),
  ...Option.match(Option.fromNullishOr(registry.graders.get(gate.grader)), {
    onNone: () => [violation("grader-unknown", [...at, "grader"], `grader "${gate.grader}" is not registered`)],
    onSome: (grader) => grader.metrics.includes(gate.metric)
      ? []
      : [violation("gate-metric-unknown", [...at, "metric"], `grader "${gate.grader}" has no metric "${gate.metric}"`)],
  }),
]

const suiteViolations = (registry: Registry, at: Path, suite: Suite): ReadonlyArray<AppViolation> => {
  const families = Arr.groupBy(suite.tasks, familyOf)
  return [
    ...(suite.tasks.length === 0 ? [violation("suite-empty", [...at, "tasks"], `suite "${suite.id}" has no tasks`)] : []),
    ...(suite.candidates.length === 0 ? [violation("suite-empty", [...at, "candidates"], `suite "${suite.id}" has no candidates`)] : []),
    ...duplicateIds("task", suite.tasks.map((task, index) => [[...at, "tasks", index, "id"], task.id] as const)),
    ...duplicateIds("candidate", suite.candidates.map((candidate, index) => [[...at, "candidates", index, "id"], candidate.id] as const)),
    ...suite.tasks.flatMap((task, index) => taskViolations(registry, [...at, "tasks", index], task, families[familyOf(task)] ?? [])),
    ...suite.gates.flatMap((gate, index) => gateViolations(registry, [...at, "gates", index], gate, suite)),
  ]
}

/**
 * Every cross-reference an app breaks, in registration order: a blank id,
 * an id used twice, a suite without tasks or candidates, a task without
 * graders or with a grader bound twice in one scope, a dataset family in
 * more than one split, a reference to an unregistered runnable, grader or
 * projection, a runnable a task uses without its `environmentFor`
 * environment, a gate whose grader no task binds or whose metric the grader
 * lacks. Pure and total; `parseEvaluationApp` checks the shape first.
 */
export const evaluationAppViolations = (app: EvaluationApp): ReadonlyArray<AppViolation> => {
  const registry: Registry = {
    runnables: new Set(app.runnables.map((entry) => entry.definition.id)),
    graders: new Map(app.graders.map((entry) => [graderKey(entry.definition), entry.definition] as const)),
    projections: new Set(app.projections.map((entry) => entry.definition.id)),
  }
  const suites: ReadonlyArray<readonly [Path, Suite]> = [
    ...app.suites.map((suite, index) => [["suites", index], suite] as const),
    ...app.calibrations.map((calibration, index) => [["calibrations", index, "suite"], calibration.suite] as const),
  ]
  const used = new Set(suites.flatMap(([, suite]) => suite.tasks.map((task) => task.runnable)))
  return [
    ...(app.id.trim() === "" ? [violation("id-empty", ["id"], "the app id is blank")] : []),
    ...duplicateIds("suite", suites.map(([at, suite]) => [[...at, "id"], suite.id] as const)),
    ...duplicateIds("calibration", app.calibrations.map((calibration, index) => [["calibrations", index, "id"], calibration.id] as const)),
    ...duplicateIds("runnable", app.runnables.map((entry, index) => [["runnables", index, "definition", "id"], entry.definition.id] as const)),
    ...duplicateIds("grader", app.graders.map((entry, index) => [["graders", index, "definition", "id"], entry.definition.id] as const)),
    ...duplicateIds("projection", app.projections.map((entry, index) => [["projections", index, "definition", "id"], entry.definition.id] as const)),
    ...app.runnables.flatMap((entry, index) =>
      duplicateIds("environment", entry.environments.map((environment, at) => [["runnables", index, "environments", at, "id"], environment.id] as const))),
    ...app.runnables.flatMap(({ definition, environments }) => !used.has(definition.id) ? [] : Option.match(Option.fromNullishOr(app.environmentFor[definition.id]), {
      onNone: () => [violation("environment-unregistered", ["environmentFor", definition.id], `runnable "${definition.id}" has no environment in environmentFor`)],
      onSome: (environment) => environments.some((registered) => registered.id === environment)
        ? []
        : [violation("environment-unregistered", ["environmentFor", definition.id], `runnable "${definition.id}" registers no environment "${environment}"`)],
    })),
    ...suites.flatMap(([at, suite]) => suiteViolations(registry, at, suite)),
  ]
}

/** A Standard Schema path segment as a violation's: a property name or an index. */
const segmentOf = (segment: PropertyKey | { readonly key: PropertyKey }): string | number => {
  const key = typeof segment === "object" ? segment.key : segment
  return typeof key === "symbol" ? key.toString() : key
}
const refusal = (violations: ReadonlyArray<AppViolation>): string =>
  `Evaluation app refused (${violations.length} ${violations.length === 1 ? "violation" : "violations"}): ${violations
    .slice(0, 5)
    .map((entry) => `${entry.rule}${entry.path.length === 0 ? "" : ` at ${entry.path.join(".")}`}: ${entry.message}`)
    .join("; ")}${violations.length > 5 ? `; and ${violations.length - 5} more` : ""}`

/**
 * Decodes a value into an `EvaluationApp`: its shape first (every issue a
 * `shape` violation at its path), then `evaluationAppViolations`. A refusal
 * is `invalid` with every violation in `violations` and the first five in
 * its message.
 */
export const parseEvaluationApp = (value: unknown): Effect.Effect<EvaluationApp, EvaluationError> =>
  Result.match(decodeShape(value), {
    onFailure: (error) => {
      const violations = formatIssue(error.issue).issues.map((issue) => violation("shape", (issue.path ?? []).map(segmentOf), issue.message))
      return Effect.fail(new EvaluationError({ code: "invalid", message: refusal(violations), violations, cause: error }))
    },
    onSuccess: (app) => {
      const violations = evaluationAppViolations(app)
      return violations.length === 0
        ? Effect.succeed(app)
        : Effect.fail(new EvaluationError({ code: "invalid", message: refusal(violations), violations }))
    },
  })

/** @deprecated Use `parseEvaluationApp`: the same check, whose refusal lists its `violations`. */
export const validateEvaluationApp: (app: EvaluationApp) => Effect.Effect<EvaluationApp, EvaluationError> = parseEvaluationApp
