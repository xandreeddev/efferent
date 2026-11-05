/** The public ModelSpend kit over the packed in-memory ledger, and the models plugin's spend option as a host writes it. */
import assert from "node:assert/strict"
import { Effect, Layer, Context, Option, Schema } from "effect"
import { HarnessError, ModelSpend, ModelSpendExceeded, ModelSpendMemoryLive, modelSpendExceededOf } from "@xandreed/core"
import { modelSpendConformance } from "@xandreed/core/conformance"
import { ModelSpendOptions } from "@xandreed/plugin-models"

const runtime = typeof Bun === "undefined" ? "Node" : "Bun"
const checks = modelSpendConformance({ open: () => Layer.build(ModelSpendMemoryLive).pipe(Effect.map((context) => Context.get(context, ModelSpend))) })
await Effect.runPromise(Effect.forEach(checks, (check) => check.run, { concurrency: 1, discard: true }))

const options = await Effect.runPromise(Schema.decodeUnknownEffect(ModelSpendOptions)({ prices: { "provider:model": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, turnCap: 0.5 }))
assert.equal(options.uncappedOutputTokens, 32_000)
assert.equal(options.inputBytesPerToken, 1)

const refusal = new ModelSpendExceeded({ reason: "turn", cap: 0.5, committed: 0.25, requested: 0.5, message: "past the cap" })
const found = modelSpendExceededOf(new HarnessError({ code: "model.spend", message: refusal.message, cause: refusal }))
assert.deepEqual(Option.map(found, (value) => value.reason), Option.some("turn"))

console.log(`model-spend ${JSON.stringify({ runtime, checks: checks.length, optionsDecoded: true })}`)
