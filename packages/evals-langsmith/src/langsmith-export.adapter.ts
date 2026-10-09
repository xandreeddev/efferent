import { createHash } from "node:crypto"
import { Client } from "langsmith"
import { Effect, Layer, Schema } from "effect"
import {
  EvaluationError,
  EvaluationExport,
  EvaluationRun,
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
const exportService = (options: LangSmithExportOptions) => ({
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
          const client = new Client({
            apiUrl: options.apiUrl,
            apiKey: options.apiKey,
            autoBatchTracing: false
          })
          const project = await client.createProject({
            projectName: options.project,
            upsert: true,
            metadata: { application: run.application }
          })
          await Promise.all(
            encoded.trials.map((trial) =>
              client.createRun({
                id: mappings[trial.id]!,
                name: `${trial.suiteId}/${trial.task.id}`,
                run_type: "chain",
                project_name: options.project,
                start_time: trial.startedAt,
                end_time: trial.endedAt,
                inputs: { input: trial.task.input },
                outputs: { output: trial.output, outcome: trial.outcome },
                ...(trial.status === "completed"
                  ? {}
                  : { error: trial.reason }),
                extra: {
                  metadata: {
                    evaluation: trial,
                    fingerprints: run.fingerprints,
                    runId: run.id
                  }
                }
              })
            )
          )
          await client.flush()
          await Promise.all(
            run.trials.flatMap((trial) =>
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
                    .map((metric) =>
                      client.createFeedback({
                        runId: mappings[trial.id]!,
                        sessionId: project.id,
                        key: `${grade.grader}@${grade.version}/${grade.scope}/${metric.name}`,
                        score:
                          metric.kind === "boolean"
                            ? Number(metric.value)
                            : metric.value,
                        comment: grade.reason,
                        feedbackId: remoteId(
                          `${trial.id}/${grade.grader}/${grade.version}/${grade.scope}/${metric.name}`
                        ),
                        feedbackSourceType: "api",
                        sourceInfo: {
                          context: grade.context,
                          usage: grade.usage
                        }
                      })
                    )
                )
            )
          )
        },
        catch: (error) =>
          new EvaluationError({
            code: "provider",
            message: `LangSmith export: ${String(error)}`
          })
      })
      return {
        provider: "langsmith",
        runId: run.id,
        url: options.webUrl ?? options.apiUrl,
        exported: run.trials.length,
        at: Date.now(),
        mappings
      }
    })
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
