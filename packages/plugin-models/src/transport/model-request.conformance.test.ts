import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { modelRequestConformance } from "./model-request.conformance.js"

describe("the model HTTP request contract", () => {
  test("documents its checks and rejects a careless pass-through transport", async () => {
    const careless = modelRequestConformance({ request: (client, request) => client.execute(request) })
    const failures = await Effect.runPromise(Effect.forEach(careless, (check) => Effect.result(check.run), { concurrency: 1 }))
    expect(failures.map((result) => result._tag)).toEqual(["Failure", "Failure", "Failure"])
    expect(careless.map((check) => check.name)).toEqual([
      "uses one counter for transport failures and rejected statuses",
      "classifies a structured permanent error before retrying its status",
      "reads a call's policy at execution and obeys its total attempt limit",
    ])
  })
  modelRequestConformance().forEach((check) => test(check.name, async () => { await Effect.runPromise(check.run) }))
})
