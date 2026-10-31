import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Redacted, Schema } from "effect"
import { LangSmithAgentId, LangSmithTarget, LANGSMITH_OPTIONS_ERROR, LANGSMITH_TRACES_URL } from "./langsmith-telemetry.entity.js"
import type { LangSmithTelemetryOptions } from "./langsmith-telemetry.entity.js"
import { langSmithOptionsOf } from "./langsmith-telemetry.entity.functions.js"

const options: LangSmithTelemetryOptions = { apiKey: Redacted.make("collector-secret"), target: { _tag: "Project", project: "fixture" } }

describe("LangSmith options", () => {
  test("resolve a complete default traces URL and retain a host's exact signal URL", async () => {
    expect((await Effect.runPromise(langSmithOptionsOf(options))).tracesUrl).toBe(LANGSMITH_TRACES_URL)
    const tracesUrl = "http://127.0.0.1:1234/custom/otel/v1/traces?tenant=fixture"
    expect((await Effect.runPromise(langSmithOptionsOf({ ...options, tracesUrl }))).tracesUrl).toBe(tracesUrl)
  })

  test("the schema has exclusive project and agent addressing and all four environments", async () => {
    const decode = Schema.decodeUnknownEffect(LangSmithTarget, { onExcessProperty: "error" })
    expect(await Effect.runPromise(decode({ _tag: "Project", project: "fixture" }))).toEqual({ _tag: "Project", project: "fixture" })
    await Effect.runPromise(Effect.forEach(["local", "development", "staging", "production"] as const, (environment) => decode({ _tag: "Agent", agentId: "a-12", environment }).pipe(
      Effect.tap((decoded) => Effect.sync(() => expect(decoded).toEqual({ _tag: "Agent", agentId: LangSmithAgentId.make("a-12"), environment }))),
    ), { concurrency: 1 }))
    await Effect.runPromise(Effect.forEach([
      { _tag: "Project", project: "fixture", agentId: "agent", environment: "local" },
      { _tag: "Agent", agentId: "agent", environment: "local", project: "fixture" },
      { _tag: "Agent", agentId: "agent" }, { _tag: "Agent", environment: "local" },
      { _tag: "Agent", agentId: "Agent", environment: "local" },
      { _tag: "Agent", agentId: "1agent", environment: "local" },
      { _tag: "Agent", agentId: "agent-", environment: "local" },
      { _tag: "Agent", agentId: "agent\n", environment: "local" },
      { _tag: "Agent", agentId: "a".repeat(64), environment: "local" },
      { _tag: "Agent", agentId: "agent", environment: "test" },
    ], (target) => Effect.exit(decode(target)).pipe(Effect.tap((exit) => Effect.sync(() => expect(Exit.isFailure(exit)).toBe(true)))), { concurrency: 1 }))
  })

  test("invalid keys, destinations, URLs, intervals and extra header options have one secret-free failure", async () => {
    const malformed: ReadonlyArray<unknown> = [
      { ...options, apiKey: Redacted.make("") }, { ...options, apiKey: "collector-secret" },
      { ...options, apiKey: Redacted.make("collector secret") },
      { ...options, apiKey: Redacted.make("collector-secret\n") },
      { ...options, target: { _tag: "Project", project: "fixture", agentId: "collector-secret" } },
      { ...options, target: { _tag: "Agent", agentId: "UPPER", environment: "local" } },
      { ...options, tracesUrl: "not a URL" }, { ...options, tracesUrl: "file:///tmp/collector-secret" },
      { ...options, tracesUrl: "https://user:collector-secret@example.invalid/v1/traces" },
      { ...options, exportInterval: "invalid" }, { ...options, exportInterval: "0 millis" },
      { ...options, shutdownTimeout: "Infinity" }, { ...options, headers: { "x-api-key": "collector-secret" } },
    ]
    await Effect.runPromise(Effect.forEach(malformed, (input) => Effect.gen(function* () {
      const exit = yield* Effect.exit(langSmithOptionsOf(input as LangSmithTelemetryOptions))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "HarnessError", code: "config.options", message: LANGSMITH_OPTIONS_ERROR })
      expect(JSON.stringify(exit)).not.toContain("collector-secret")
    }), { concurrency: 1 }))
  })
})
