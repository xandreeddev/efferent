import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { harnessError } from "../harness/harness-code.entity.functions.js"
import { CurrentAgentRun, CurrentAgentStep } from "../loop/stepContext.js"
import { ModelRequestHook } from "../ports/model-request-hook.port.js"
import { applyModelRequestHook } from "./model-request-hook.entity.functions.js"
import { modelRequestHookConformance } from "./model-request-hook.conformance.js"
import type { ModelRequestHookSubject } from "./model-request-hook.conformance.js"

const ids = ["identity", "controls", "validation", "snapshot", "context", "failures", "interruptible"]
const failedChecks = (apply: ModelRequestHookSubject["apply"]) => Effect.runPromise(Effect.forEach(modelRequestHookConformance({ apply }), (check) =>
  Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])), { concurrency: 1 },
).pipe(Effect.map((results) => results.flat())))
const careless: ReadonlyArray<{ readonly name: string; readonly id: string; readonly apply: ModelRequestHookSubject["apply"] }> = [
  { name: "dropping accepted provenance", id: "identity", apply: (draft) => applyModelRequestHook(draft).pipe(Effect.map((prepared) => ({ ...prepared, hook: Option.none() }))) },
  { name: "replacing appended context with policy controls", id: "controls", apply: (draft) => applyModelRequestHook(draft).pipe(Effect.map((prepared) => ({ ...prepared, context: draft.context, toolChoice: draft.toolChoice }))) },
  { name: "swallowing invalid patches", id: "validation", apply: (draft) => applyModelRequestHook(draft).pipe(Effect.catch(() => Effect.succeed({ system: draft.system, context: draft.context, toolChoice: draft.toolChoice, hook: Option.none() }))) },
  { name: "passing the caller's draft by reference", id: "snapshot", apply: (draft) => Effect.gen(function* () {
    const hook = yield* Effect.serviceOption(ModelRequestHook)
    return yield* (Option.isNone(hook) ? applyModelRequestHook(draft) : applyModelRequestHook(draft).pipe(Effect.provideService(ModelRequestHook, { prepare: () => hook.value.prepare(draft) })))
  }) },
  { name: "clearing the caller's context", id: "context", apply: (draft) => applyModelRequestHook(draft).pipe(Effect.provideService(CurrentAgentRun, Option.none()), Effect.provideService(CurrentAgentStep, Option.none())) },
  { name: "wrapping original typed TurnError", id: "failures", apply: (draft) => applyModelRequestHook(draft).pipe(Effect.catch((error) => Effect.fail(harnessError("request.hook", "careless hook failed", error)))) },
  { name: "reclassifying interruption", id: "interruptible", apply: (draft) => applyModelRequestHook(draft).pipe(Effect.catchCause((cause) => Effect.fail(harnessError("request.hook", "careless hook interrupted", cause)))) },
]

test("the application kit documents its seven exact check IDs", async () => {
  expect(await failedChecks((draft) => Effect.succeed({ system: draft.system, context: draft.context, toolChoice: draft.toolChoice, hook: Option.none() }))).toEqual(ids)
})
test.each([...modelRequestHookConformance()])("hook application: $name", async (check) => { await Effect.runPromise(check.run) })
test.each([...careless])("the application kit catches $name", async ({ apply, id }) => { expect(await failedChecks(apply)).toContain(id) })
