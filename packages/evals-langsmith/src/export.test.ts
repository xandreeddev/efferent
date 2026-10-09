import { EvaluationExport } from "@xandreed/evals"
import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import {
  EvaluationServicesLive,
  EvaluationRunStore,
  runEvaluation
} from "@xandreed/evals"
import { fixture } from "@xandreed/evals/testing/fixture.testing"
import { langsmithExporter } from "./langsmith-export.adapter.js"

test("official SDK exports linked trial metadata and measured scores", async () => {
  const requests: { path: string; body: unknown }[] = []
  const projectId = "12345678-1234-5678-abcd-123456789abc"
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      const body = request.method === "GET" ? null : await request.json()
      requests.push({ path, body })
      return Response.json(
        path.includes("ingestion")
          ? { successes: [], errors: [] }
          : path.includes("info")
            ? {
                version: "0.12.0",
                batch_ingest_config: {
                  use_multipart_endpoint: false,
                  size_limit: 100,
                  scale_up_qsize_trigger: 1000
                }
              }
            : path.includes("sessions")
              ? {
                  id: projectId,
                  name: "fixture",
                  start_time: new Date().toISOString()
                }
              : path.includes("feedback")
                ? {
                    id: projectId,
                    key: "correct",
                    score: 1,
                    created_at: new Date().toISOString(),
                    modified_at: new Date().toISOString()
                  }
                : {}
      )
    }
  })
  const url = `http://127.0.0.1:${server.port}`
  const report = await Effect.runPromise(
    runEvaluation(fixture(), "fixture-run", {
      ids: [],
      split: "validation"
    }).pipe(
      Effect.provide(EvaluationServicesLive(fixture())),
      Effect.provide(
        Layer.succeed(EvaluationRunStore, {
          writeTrial: () => Effect.void,
          writeRun: () => Effect.void
        })
      )
    )
  )
  const receipt = await Effect.runPromise(
    Effect.gen(function* () {
      const port = yield* EvaluationExport
      return yield* port.exportRun(report)
    })
      .pipe(
        Effect.provide(
          langsmithExporter({
            apiUrl: url,
            apiKey: "fixture",
            project: "fixture"
          }).layer
        ),
        Effect.scoped
      )
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            server.stop(true)
          })
        )
      )
  )
  expect(receipt.exported).toBe(1)
  expect(receipt.mappings[report.trials[0]!.id]).toBeTruthy()
  expect(JSON.stringify(requests)).toContain("secret-label")
  expect(JSON.stringify(requests)).toContain("correct")
  expect(JSON.stringify(requests)).toContain("projection")
})
