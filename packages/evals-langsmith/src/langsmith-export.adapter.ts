import { createHash } from "node:crypto"
import { Client } from "langsmith"
import { Cause, Effect, Layer, Predicate, Schema } from "effect"
import {
  EvaluationError,
  EvaluationExport,
  EvaluationRun,
  reasonOf,
  type ExportReceipt,
  type ExporterRegistration
} from "@xandreed/evals"

export interface LangSmithExportOptions {
  readonly apiUrl: string
  readonly apiKey: string
  readonly project: string
  readonly webUrl?: string
}
const remoteId = (id: string) => {
  const hex = createHash("sha256").update(id).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
const providerError = (error: unknown) =>
  new EvaluationError({
    code: "provider",
    message: `LangSmith export: ${reasonOf(Cause.die(error))}`,
    cause: error
  })
const sdk = <A>(request: () => Promise<A>) =>
  Effect.tryPromise({ try: request, catch: (error) => error })
/** The SDK's answer to a create whose id already exists (HTTP 409). */
const isConflict = (error: unknown) =>
  Predicate.hasProperty(error, "name") && error.name === "LangSmithConflictError"
/** Create a record under its stable id; when an earlier export made it, update it instead. */
const upsert = (create: () => Promise<unknown>, update: () => Promise<unknown>) =>
  sdk(create).pipe(
    Effect.catchIf(isConflict, () => sdk(update)),
    Effect.mapError(providerError),
    Effect.asVoid
  )

/**
 * Every value sent is read from the run as its schema encodes it (an absent
 * value is `null`, never an in-memory `Option`), and every remote id is
 * derived from a local one, so exporting a report again updates what the
 * first export created.
 */
const exportService = (options: LangSmithExportOptions) => ({
  exportRun: Effect.fn("eval.export", { attributes: { "eval.exporter": "langsmith" } })(
    function* (run: EvaluationRun): Effect.fn.Return<ExportReceipt, EvaluationError> {
      const encoded = yield* Schema.encodeEffect(EvaluationRun)(run).pipe(
        Effect.mapError(
          (error) =>
            new EvaluationError({
              code: "invalid",
              message: `Run ${run.id} does not encode: ${error.message}`,
              cause: error
            })
        )
      )
      const mappings = Object.fromEntries(
        encoded.trials.map((trial) => [trial.id, remoteId(trial.id)])
      )
      const client = new Client({
        apiUrl: options.apiUrl,
        apiKey: options.apiKey,
        autoBatchTracing: false
      })
      const project = yield* sdk(() =>
        client.createProject({
          projectName: options.project,
          upsert: true,
          metadata: { application: encoded.application }
        })
      ).pipe(Effect.mapError(providerError))
      yield* Effect.forEach(
        encoded.trials,
        (trial) => {
          const fields = {
            name: `${trial.suiteId}/${trial.task.id}`,
            start_time: trial.startedAt,
            end_time: trial.endedAt,
            inputs: { input: trial.task.input },
            outputs: { output: trial.output, outcome: trial.outcome },
            ...(trial.status === "completed" ? {} : { error: trial.reason }),
            extra: {
              metadata: {
                evaluation: trial,
                fingerprints: encoded.fingerprints,
                runId: encoded.id
              }
            }
          }
          return upsert(
            () =>
              client.createRun({
                id: mappings[trial.id]!,
                run_type: "chain",
                project_name: options.project,
                ...fields
              }),
            () => client.updateRun(mappings[trial.id]!, fields)
          )
        },
        { concurrency: 8, discard: true }
      )
      yield* sdk(() => client.flush()).pipe(Effect.mapError(providerError))
      yield* Effect.forEach(
        encoded.trials.flatMap((trial) =>
          trial.grades
            .filter((grade) => grade.status === "scored")
            .flatMap((grade) =>
              grade.metrics
                .filter(
                  (metric) =>
                    metric.kind === "boolean" ||
                    metric.kind === "score" ||
                    metric.kind === "probability"
                )
                .map((metric) => ({
                  runId: mappings[trial.id]!,
                  key: `${grade.grader}@${grade.version}/${grade.scope}/${metric.name}`,
                  score:
                    metric.kind === "boolean"
                      ? Number(metric.value)
                      : metric.value,
                  comment: grade.reason,
                  feedbackId: remoteId(
                    `${trial.id}/${grade.grader}/${grade.version}/${grade.scope}/${metric.name}`
                  ),
                  sourceInfo: {
                    context: grade.context,
                    usage: grade.usage
                  }
                }))
            )
        ),
        (feedback) =>
          upsert(
            () =>
              client.createFeedback({
                ...feedback,
                sessionId: project.id,
                feedbackSourceType: "api"
              }),
            () =>
              client.updateFeedback(feedback.feedbackId, {
                score: feedback.score,
                comment: feedback.comment
              })
          ),
        { concurrency: 8, discard: true }
      )
      return {
        provider: "langsmith",
        runId: run.id,
        url: options.webUrl ?? options.apiUrl,
        exported: run.trials.length,
        at: Date.now(),
        mappings
      }
    },
    (effect, run) => Effect.annotateCurrentSpan("eval.run.id", run.id).pipe(Effect.andThen(effect))
  )
})
export const EvaluationExportLangSmithLive = (
  options: LangSmithExportOptions
) => Layer.succeed(EvaluationExport, exportService(options))

export const langsmithExporter = (
  options: LangSmithExportOptions
): ExporterRegistration => ({
  id: "langsmith",
  layer: EvaluationExportLangSmithLive(options)
})
