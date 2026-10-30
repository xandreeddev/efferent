import { EvaluationExport, type EvaluationRun } from "@xandreed/evals"
import { expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer, Predicate } from "effect"
import { TestClock } from "effect/testing"
import {
  EvaluationServicesLive,
  EvaluationRunStore,
  runEvaluation
} from "@xandreed/evals"
import { fixture, spanRecorder } from "@xandreed/evals/testing/fixture.testing"
import { langsmithExporter } from "./langsmith-export.adapter.js"

/**
 * A key-free stand-in for the LangSmith API that captures every request and,
 * like the service, refuses a second create of the same run or feedback id
 * with 409.
 */
const langsmithStub = () => {
  const requests: { method: string; path: string; body: unknown }[] = []
  const created = new Set<string>()
  const projectId = "12345678-1234-5678-abcd-123456789abc"
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      const body: unknown = request.method === "GET" ? null : await request.json()
      requests.push({ method: request.method, path, body })
      const id = Predicate.hasProperty(body, "id") ? `${path}:${String(body.id)}` : ""
      if (request.method === "POST" && (path === "/runs" || path === "/feedback") && id) {
        if (created.has(id)) return Response.json({ detail: "already exists" }, { status: 409 })
        created.add(id)
      }
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
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) }
}

const report = () =>
  Effect.runPromise(
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

const exportTo = (url: string, run: EvaluationRun) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const port = yield* EvaluationExport
      return yield* port.exportRun(run)
    }).pipe(
      Effect.provide(
        langsmithExporter({ apiUrl: url, apiKey: "fixture", project: "fixture" })
          .layer
      ),
      Effect.scoped
    )
  )

test("official SDK exports linked trial metadata and measured scores", async () => {
  const stub = langsmithStub()
  const run = await report()
  const receipt = await exportTo(stub.url, run).finally(stub.stop)
  expect(receipt.exported).toBe(1)
  expect(receipt.mappings[run.trials[0]!.id]).toBeTruthy()
  expect(JSON.stringify(stub.requests)).toContain("secret-label")
  expect(JSON.stringify(stub.requests)).toContain("correct")
  expect(JSON.stringify(stub.requests)).toContain("projection")
})

test("feedback carries encoded values, and exporting a report again updates what the first export created", async () => {
  const stub = langsmithStub()
  const run = await report()
  const first = await exportTo(stub.url, run)
  const second = await exportTo(stub.url, run).finally(stub.stop)
  expect(second.mappings).toEqual(first.mappings)
  const remote = first.mappings[run.trials[0]!.id]!
  const feedback = stub.requests.find((request) => request.method === "POST" && request.path === "/feedback")
  expect(feedback?.body).toMatchObject({
    feedback_source: {
      metadata: {
        context: { projection: "projection" },
        usage: { inputTokens: null, outputTokens: null }
      }
    }
  })
  expect(JSON.stringify(stub.requests)).not.toContain("\"_id\":\"Option\"")
  const patched = stub.requests.filter((request) => request.method === "PATCH").map((request) => request.path)
  expect(patched).toContain(`/runs/${remote}`)
  expect(patched.filter((path) => path.startsWith("/feedback/"))).toHaveLength(1)
})

test("a refused request is a provider error that keeps the client's error as its cause", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ detail: "Invalid token" }, { status: 401 })
  })
  const run = await report()
  const refused = await Effect.runPromise(
    Effect.gen(function* () {
      const port = yield* EvaluationExport
      return yield* port.exportRun(run)
    }).pipe(
      Effect.provide(langsmithExporter({ apiUrl: `http://127.0.0.1:${server.port}`, apiKey: "fixture", project: "fixture" }).layer),
      Effect.scoped,
      Effect.flip,
      Effect.ensuring(Effect.sync(() => server.stop(true)))
    )
  )
  expect(refused.code).toBe("provider")
  expect(refused.message).toStartWith("LangSmith export: Failed to create project. Received status [401]")
  expect(refused.cause).toBeInstanceOf(Error)
})

test("an export is one eval.export span naming the exporter and the run", async () => {
  const stub = langsmithStub()
  const run = await report()
  const { tracer, named } = spanRecorder()
  await Effect.runPromise(
    EvaluationExport.use((port) => port.exportRun(run)).pipe(
      Effect.provide(langsmithExporter({ apiUrl: stub.url, apiKey: "fixture", project: "fixture" }).layer),
      Effect.withTracer(tracer),
      Effect.ensuring(Effect.sync(stub.stop))
    )
  )
  expect(named("eval.export").map((span) => [span.attributes.get("eval.exporter"), span.attributes.get("eval.run.id")])).toEqual([["langsmith", "fixture-run"]])
})

/** A stand-in that takes every request and never answers. */
const silentStub = () => {
  const received = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      received.resolve()
      return new Promise<Response>(() => {})
    }
  })
  // Not awaited: the stop stays pending until every handler has answered, and these never do.
  const stop = () => {
    void server.stop(true)
  }
  return { url: `http://127.0.0.1:${server.port}`, received: received.promise, stop }
}

test("an export the service never answers fails as provider once its timeoutMs passes", async () => {
  const stub = silentStub()
  const run = await report()
  const started = performance.now()
  const timedOut = await Effect.runPromise(
    EvaluationExport.use((port) => port.exportRun(run)).pipe(
      Effect.provide(langsmithExporter({ apiUrl: stub.url, apiKey: "fixture", project: "fixture", timeoutMs: 200 }).layer),
      Effect.flip,
      Effect.ensuring(Effect.sync(stub.stop))
    )
  )
  expect(timedOut.code).toBe("provider")
  expect(timedOut.message).toBe("LangSmith export: not finished within 200 ms")
  expect(performance.now() - started).toBeLessThan(2_000)
})

test("an interrupted export returns at once, without waiting for its requests", async () => {
  const stub = silentStub()
  const run = await report()
  const fiber = Effect.runFork(
    EvaluationExport.use((port) => port.exportRun(run)).pipe(
      Effect.provide(langsmithExporter({ apiUrl: stub.url, apiKey: "fixture", project: "fixture" }).layer)
    )
  )
  await stub.received
  const started = performance.now()
  await Effect.runPromise(Fiber.interrupt(fiber)).finally(stub.stop)
  expect(performance.now() - started).toBeLessThan(1_000)
  expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
})

test("remote ids are the ones earlier exports derived, so exporting again updates the same run and feedback", async () => {
  const stub = langsmithStub()
  const run = await report()
  const receipt = await exportTo(stub.url, run).finally(stub.stop)
  const created = (path: string) => stub.requests.filter((request) => request.method === "POST" && request.path === path).map((request) => request.body)
  expect(receipt.mappings).toEqual({ "fixture-run/suite/candidate/task/1": "a69dc915-fad9-53d2-ae2a-f62a20c54676" })
  expect(created("/runs")).toEqual([expect.objectContaining({ id: "a69dc915-fad9-53d2-ae2a-f62a20c54676" })])
  expect(created("/feedback")).toEqual([
    expect.objectContaining({
      id: "a1e07d5b-2717-5e34-ab4b-3590d685810f",
      run_id: "a69dc915-fad9-53d2-ae2a-f62a20c54676",
      key: "grader@1/trial/correct",
      score: 1,
      comment: "matches"
    })
  ])
})

test("a receipt is stamped with the Clock's time", async () => {
  const stub = langsmithStub()
  const run = await report()
  const receipt = await Effect.runPromise(
    TestClock.setTime(1_767_225_600_000).pipe(
      Effect.andThen(EvaluationExport.use((port) => port.exportRun(run))),
      Effect.provide(langsmithExporter({ apiUrl: stub.url, apiKey: "fixture", project: "fixture" }).layer),
      Effect.provide(TestClock.layer())
    )
  ).finally(stub.stop)
  expect(receipt.at).toBe(1_767_225_600_000)
})
