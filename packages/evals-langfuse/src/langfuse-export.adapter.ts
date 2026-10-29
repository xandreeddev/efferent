import { createHash } from "node:crypto"
import { LangfuseClient } from "@langfuse/client"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import {
  EvaluationError,
  EvaluationExport,
  EvaluationRun,
  reasonOf,
  type ExportReceipt,
  type ExporterRegistration
} from "@xandreed/evals"

export interface LangfuseExportOptions {
  readonly baseUrl: string
  readonly publicKey: string
  readonly secretKey: string
  readonly project?: string
}
/** Ingestion batches in flight at once. */
const EXPORT_CONCURRENCY = 4
const remoteId = (id: string) =>
  createHash("sha256").update(id).digest("hex").slice(0, 32)
const exportService = (options: LangfuseExportOptions) => ({
  exportRun: Effect.fn("eval.export", { attributes: { "eval.exporter": "langfuse" } })(
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
        run.trials.map((trial) => [trial.id, remoteId(trial.id)])
      )
      const failed = (error: unknown) => new EvaluationError({ code: "provider", message: `Langfuse export: ${reasonOf(Cause.die(error))}`, cause: error })
      const client = yield* Effect.try({
        try: () => new LangfuseClient({
          baseUrl: options.baseUrl,
          publicKey: options.publicKey,
          secretKey: options.secretKey
        }),
        catch: failed
      })
      const traces = encoded.trials.map((trial) => ({
        id: remoteId(`${trial.id}/trace`),
        timestamp: new Date(trial.endedAt).toISOString(),
        type: "trace-create" as const,
        body: {
          id: mappings[trial.id]!,
          name: `${trial.suiteId}/${trial.task.id}`,
          sessionId: run.id,
          input: trial.task.input,
          output: { output: trial.output, outcome: trial.outcome },
          metadata: { evaluation: trial, fingerprints: run.fingerprints },
          tags: ["evaluation", trial.status]
        }
      }))
      const scores = run.trials.flatMap((trial) =>
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
                id: remoteId(
                  `${trial.id}/${grade.grader}/${grade.version}/${grade.scope}/${metric.name}`
                ),
                timestamp: new Date(grade.endedAt).toISOString(),
                type: "score-create" as const,
                body: {
                  id: remoteId(
                    `${trial.id}/${grade.grader}/${grade.version}/${grade.scope}/${metric.name}`
                  ),
                  traceId: mappings[trial.id]!,
                  name: `${grade.grader}@${grade.version}/${grade.scope}/${metric.name}`,
                  dataType: "NUMERIC" as const,
                  value:
                    metric.kind === "boolean"
                      ? Number(metric.value)
                      : metric.value,
                  comment: grade.reason
                }
              }))
          )
      )
      const batches = Array.from(
        { length: Math.ceil((traces.length + scores.length) / 50) },
        (_, index) =>
          [...traces, ...scores].slice(index * 50, (index + 1) * 50)
      )
      const responses = yield* Effect.forEach(
        batches,
        (batch) => Effect.tryPromise({ try: () => client.api.ingestion.batch({ batch }), catch: failed }),
        { concurrency: EXPORT_CONCURRENCY }
      )
      const errors = responses.flatMap((response) => response.errors)
      if (errors.length > 0) {
        return yield* Effect.fail(
          new EvaluationError({
            code: "provider",
            message: `Langfuse rejected ${errors.length} events`
          })
        )
      }
      return {
        provider: "langfuse",
        runId: run.id,
        url: options.baseUrl,
        exported: run.trials.length,
        at: Date.now(),
        mappings
      }
    },
    (effect, run) => Effect.annotateCurrentSpan("eval.run.id", run.id).pipe(Effect.andThen(effect))
  )
})
export const EvaluationExportLangfuseLive = (options: LangfuseExportOptions) =>
  Layer.succeed(EvaluationExport, exportService(options))

export const langfuseExporter = (
  options: LangfuseExportOptions
): ExporterRegistration => ({
  id: "langfuse",
  layer: EvaluationExportLangfuseLive(options)
})
