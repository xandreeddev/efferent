import { expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Schema } from "effect"
import { SessionLogEvent } from "@xandreed/core"
import { smithCodingCases } from "./smith-coding-cases.entity.js"
import { inspectFixture, seedFixture } from "./smith-coding-fixture.adapter.js"
import { runSmithCodingTrial } from "./smith-coding-trial.adapter.js"
import { productionVerified } from "./smith-coding-trial.entity.functions.js"

test("verification evidence requires successful commands rather than printed check names", () => {
  const check = (command: string, exitCode = 0) => ({ command, exitCode, stdout: "", stderr: "" })
  expect(productionVerified([check("bun test && bun run check")])).toBe(true)
  expect(productionVerified([check("bun test --timeout 30000"), check("bun run check")])).toBe(true)
  expect(productionVerified([check("echo 'bun test && bun run check'")])).toBe(false)
  expect(productionVerified([check("printf '&& bun test && bun run check &&'")])).toBe(false)
  expect(productionVerified([check("bun test", 1), check("bun run check")])).toBe(false)
})

test("every Effect 4 case has executable independent acceptance and architecture checks", async () => {
  const results = await Effect.runPromise(Effect.forEach(smithCodingCases, (testCase) => Effect.scoped(Effect.gen(function* () {
    const fixture = yield* seedFixture(testCase, false)
    yield* Effect.sync(() => Object.entries(testCase.solution).forEach(([path, content]) => { mkdirSync(dirname(join(fixture.dir, path)), { recursive: true }); writeFileSync(join(fixture.dir, path), content) }))
    const evidence = yield* inspectFixture(fixture.dir, fixture.seed, Object.keys(testCase.solution))
    return { id: testCase.id, checks: evidence.checks }
  }))))
  expect(results.flatMap((result) => result.checks.filter((check) => !check.pass).map((check) => ({ id: result.id, ...check })))).toEqual([])
}, 120_000)

test("the Smith production graph owns one parent turn and a real provider-backed editor child", async () => {
  const testCase = smithCodingCases[0]!
  const evidence = await Effect.runPromise(runSmithCodingTrial(testCase, { id: "split-scripted", driverModel: "opencode:fixture-controller", editorModel: "opencode:fixture-editor", modules: ["foundations", "schema"] }, 1, "scripted").pipe(Effect.scoped))
  expect(evidence.error).toBeNull()
  expect(evidence.roleUsage.controller["opencode:fixture-controller"]?.totalTokens).toBeGreaterThan(0)
  expect(evidence.roleUsage.editor["opencode:fixture-editor"]?.totalTokens).toBeGreaterThan(0)
  expect(JSON.stringify(evidence.resolvedConfig)).toContain("@xandreed/smith/coding")
  const parent = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.Array(SessionLogEvent))(evidence.parentEvents))
  const editor = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.Array(SessionLogEvent))(evidence.editorEvents))
  expect(parent.length).toBe(evidence.parentEvents.length)
  expect(editor.length).toBe(evidence.editorEvents.length)
  const requests = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ protocol: Schema.String, role: Schema.optionalKey(Schema.String), sessionId: Schema.optionalKey(Schema.String) })))(evidence.transportRequests))
  expect(requests.filter((request) => request.role === "controller").every((request) => request.sessionId === parent[0]?.session)).toBe(true)
  expect(requests.filter((request) => request.role === "editor").every((request) => editor.some((event) => event.session === request.sessionId) && request.sessionId !== parent[0]?.session)).toBe(true)
  expect(evidence.checks.filter((check) => !check.pass)).toEqual([])
  expect(evidence.checks.find((check) => check.name === "production-verification")?.pass).toBe(true)
  expect(evidence.parentEvents.some((event) => JSON.stringify(event).includes('"kind":"smith.check"') && JSON.stringify(event).includes('"exitCode":0'))).toBe(true)
  expect(evidence.parentEvents.filter((event) => JSON.stringify(event).includes('"kind":"turn.started"'))).toHaveLength(1)
  expect(evidence.parentEvents.filter((event) => JSON.stringify(event).includes('"kind":"turn.ended"'))).toHaveLength(1)
  expect(evidence.parentEvents.filter((event) => JSON.stringify(event).includes('"kind":"turn.reply"'))).toHaveLength(1)
  expect(JSON.stringify(evidence.editorEvents)).toContain("memory.message")
  expect(evidence.transportRequests.filter((request) => JSON.stringify(request).includes('"protocol":"evaluation-model-v4"'))).toHaveLength(1)
}, 120_000)
