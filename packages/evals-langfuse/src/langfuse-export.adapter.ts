import { createHash } from "node:crypto"
import { LangfuseClient } from "@langfuse/client"
import { Effect, Layer, Option, Schema } from "effect"
import {
  EvaluationError,
  EvaluationExport,
  EvaluationRun,
  type ExportReceipt,
  type ExporterRegistration
} from "@xandreed/evals"

export interface LangfuseExportOptions {
  readonly baseUrl: string
  readonly publicKey: string
  readonly secretKey: string
  readonly project?: string
}
const remoteId = (id: string) =>
  createHash("sha256").update(id).digest("hex").slice(0, 32)
const exportService = (options: LangfuseExportOptions) => ({
  exportRun: (
    run: EvaluationRun
  ): Effect.Effect<ExportReceipt, EvaluationError> =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(EvaluationRun)(run).pipe(
        Effect.mapError(
          (error) =>
            new EvaluationError({ code: "invalid", message: String(error) })
        )
      )
      const mappings = Object.fromEntries(
        run.trials.map((trial) => [trial.id, remoteId(trial.id)])
      )
      yield* Effect.tryPromise({
        try: async () => {
          const client = new LangfuseClient({
            baseUrl: options.baseUrl,
            publicKey: options.publicKey,
            secretKey: options.secretKey
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
          const responses = await Promise.all(
            batches.map((batch) => client.api.ingestion.batch({ batch }))
          )
          const errors = responses.flatMap((response) => response.errors)
          if (errors.length) return { errors }
          return { errors: [] }
        },
        catch: (error) =>
          new EvaluationError({
            code: "provider",
            message: `Langfuse export: ${String(error)}`
          })
      }).pipe(
        Effect.flatMap((response) =>
          response.errors.length
            ? Effect.fail(
                new EvaluationError({
                  code: "provider",
                  message: `Langfuse rejected ${response.errors.length} events`
                })
              )
            : Effect.void
        )
      )
      return {
        provider: "langfuse",
        runId: run.id,
        url: options.baseUrl,
        exported: run.trials.length,
        at: Date.now(),
        mappings
      }
    })
})
export const EvaluationExportLangfuseLive = (options: LangfuseExportOptions) =>
  Layer.succeed(EvaluationExport, exportService(options))

export const langfuseExporter = (
  options: LangfuseExportOptions
): ExporterRegistration => ({
  id: "langfuse",
  layer: EvaluationExportLangfuseLive(options)
})
