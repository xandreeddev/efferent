import { EvaluationExport } from "@xandreed/evals"
import { expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import {
  EvaluationServicesLive,
  EvaluationRunStore,
  runEvaluation
} from "@xandreed/evals"
import { fixture, spanRecorder } from "@xandreed/evals/testing/fixture.testing"
import { langfuseExporter } from "./langfuse-export.adapter.js"

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
                version: "0.13.0",
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
          appendTranscript: () => Effect.void,
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
          langfuseExporter({
            baseUrl: url,
            publicKey: "fixture",
            secretKey: "fixture"
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

test("a refused ingestion is a provider error that keeps the client's error as its cause", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ message: "Invalid credentials" }, { status: 401 })
  })
  const report = await Effect.runPromise(
    runEvaluation(fixture(), "fixture-run", { ids: [], split: "validation" }).pipe(
      Effect.provide(EvaluationServicesLive(fixture())),
      Effect.provide(Layer.succeed(EvaluationRunStore, { writeTrial: () => Effect.void, appendTranscript: () => Effect.void, writeRun: () => Effect.void }))
    )
  )
  const refused = await Effect.runPromise(
    Effect.gen(function* () {
      const port = yield* EvaluationExport
      return yield* port.exportRun(report)
    }).pipe(
      Effect.provide(langfuseExporter({ baseUrl: `http://127.0.0.1:${server.port}`, publicKey: "fixture", secretKey: "fixture" }).layer),
      Effect.scoped,
      Effect.flip,
      Effect.ensuring(Effect.sync(() => server.stop(true)))
    )
  )
  expect(refused.code).toBe("provider")
  expect(refused.message).toStartWith("Langfuse export: UnauthorizedError")
  expect(refused.message).toContain("Status code: 401")
  expect(refused.cause).toBeInstanceOf(Error)
})

test("an export is one eval.export span naming the exporter and the run, failed or not", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ message: "Invalid credentials" }, { status: 401 })
  })
  const { tracer, named } = spanRecorder()
  const report = await Effect.runPromise(
    runEvaluation(fixture(), "fixture-run", { ids: [], split: "validation" }).pipe(
      Effect.provide(EvaluationServicesLive(fixture())),
      Effect.provide(Layer.succeed(EvaluationRunStore, { writeTrial: () => Effect.void, appendTranscript: () => Effect.void, writeRun: () => Effect.void }))
    )
  )
  await Effect.runPromise(
    EvaluationExport.use((port) => port.exportRun(report)).pipe(
      Effect.provide(langfuseExporter({ baseUrl: `http://127.0.0.1:${server.port}`, publicKey: "fixture", secretKey: "fixture" }).layer),
      Effect.flip,
      Effect.withTracer(tracer),
      Effect.ensuring(Effect.sync(() => server.stop(true)))
    )
  )
  expect(named("eval.export").map((span) => [span.attributes.get("eval.exporter"), span.attributes.get("eval.run.id")])).toEqual([["langfuse", "fixture-run"]])
})

const fixtureReport = () =>
  Effect.runPromise(
    runEvaluation(fixture(), "fixture-run", { ids: [], split: "validation" }).pipe(
      Effect.provide(EvaluationServicesLive(fixture())),
      Effect.provide(Layer.succeed(EvaluationRunStore, { writeTrial: () => Effect.void, appendTranscript: () => Effect.void, writeRun: () => Effect.void }))
    )
  )

/** A stand-in that takes every request and never answers; `aborted` settles when the client gives one up. */
const silentStub = () => {
  const received = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<boolean>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      request.signal.addEventListener("abort", () => aborted.resolve(request.signal.aborted))
      received.resolve()
      return new Promise<Response>(() => {})
    }
  })
  // Not awaited: the stop stays pending until every handler has answered, and these never do.
  const stop = () => {
    void server.stop(true)
  }
  return { url: `http://127.0.0.1:${server.port}`, received: received.promise, aborted: aborted.promise, stop }
}

test("an export the service never answers fails as provider once its timeoutMs passes", async () => {
  const stub = silentStub()
  const run = await fixtureReport()
  const started = performance.now()
  const timedOut = await Effect.runPromise(
    EvaluationExport.use((port) => port.exportRun(run)).pipe(
      Effect.provide(langfuseExporter({ baseUrl: stub.url, publicKey: "fixture", secretKey: "fixture", timeoutMs: 200 }).layer),
      Effect.flip,
      Effect.ensuring(Effect.sync(stub.stop))
    )
  )
  expect(timedOut.code).toBe("provider")
  expect(timedOut.message).toBe("Langfuse export: not finished within 200 ms")
  expect(performance.now() - started).toBeLessThan(2_000)
})

test("interrupting an export aborts its ingestion requests", async () => {
  const stub = silentStub()
  const run = await fixtureReport()
  const fiber = Effect.runFork(
    EvaluationExport.use((port) => port.exportRun(run)).pipe(
      Effect.provide(langfuseExporter({ baseUrl: stub.url, publicKey: "fixture", secretKey: "fixture" }).layer)
    )
  )
  await stub.received
  await Effect.runPromise(Fiber.interrupt(fiber))
  const aborted = await stub.aborted.finally(stub.stop)
  expect(aborted).toBe(true)
  expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
})

/** A stand-in that accepts every ingestion batch and keeps each request's body. */
const ingestionStub = () => {
  const bodies: Array<unknown> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      bodies.push(await request.json())
      return Response.json({ successes: [], errors: [] })
    }
  })
  return { url: `http://127.0.0.1:${server.port}`, bodies, stop: () => server.stop(true) }
}

test("remote ids are the ones earlier exports derived, so exporting again updates the same trace and score", async () => {
  const stub = ingestionStub()
  const run = await fixtureReport()
  const receipt = await Effect.runPromise(
    EvaluationExport.use((port) => port.exportRun(run)).pipe(
      Effect.provide(langfuseExporter({ baseUrl: stub.url, publicKey: "fixture", secretKey: "fixture" }).layer)
    )
  ).finally(stub.stop)
  const grade = run.trials[0]!.grades[0]!
  expect(receipt.mappings).toEqual({ "fixture-run/suite/candidate/task/1": "a69dc915fad9b3d2ce2af62a20c54676" })
  expect(stub.bodies).toEqual([{
    batch: [
      expect.objectContaining({ id: "960ae27d0b4c6a83a584a9130309ac0d", type: "trace-create", body: expect.objectContaining({ id: "a69dc915fad9b3d2ce2af62a20c54676" }) }),
      {
        id: "a1e07d5b2717de342b4b3590d685810f",
        timestamp: new Date(grade.endedAt).toISOString(),
        type: "score-create",
        body: {
          id: "a1e07d5b2717de342b4b3590d685810f",
          traceId: "a69dc915fad9b3d2ce2af62a20c54676",
          name: "grader@1/trial/correct",
          dataType: "NUMERIC",
          value: 1,
          comment: "matches"
        }
      }
    ]
  }])
})

test("a receipt is stamped with the Clock's time", async () => {
  const stub = ingestionStub()
  const run = await fixtureReport()
  const receipt = await Effect.runPromise(
    TestClock.setTime(1_767_225_600_000).pipe(
      Effect.andThen(EvaluationExport.use((port) => port.exportRun(run))),
      Effect.provide(langfuseExporter({ baseUrl: stub.url, publicKey: "fixture", secretKey: "fixture" }).layer),
      Effect.provide(TestClock.layer())
    )
  ).finally(stub.stop)
  expect(receipt.at).toBe(1_767_225_600_000)
})
