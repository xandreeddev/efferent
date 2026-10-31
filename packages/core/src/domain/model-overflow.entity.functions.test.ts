import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { AiError, Response } from "effect/ai"
import { ModelId, ModelSelection, ProviderId } from "./model-selection.entity.js"
import { ModelOverflowEvidence } from "./model-failure.entity.js"
import { modelFailureOf, modelOverflowEvidenceOf, stampAiErrorFailure, stampPartFailure, stampResponseFailure } from "./model-failure.entity.functions.js"

const evidence: ModelOverflowEvidence = { model: new ModelSelection({ provider: ProviderId.make("actual"), modelId: ModelId.make("fallback") }), limits: { contextWindow: 2000, maxOutputTokens: 200 } }
const wire = { model: { provider: "actual", modelId: "fallback" }, limits: { contextWindow: 2000, maxOutputTokens: 200 } }
const finish = Response.makePart("finish", { reason: "length", usage: new Response.Usage({ inputTokens: {}, outputTokens: {} }), metadata: { engine: { model: "actual:fallback", sibling: "keep" }, custom: { signature: "signed==" } } })

test("overflow evidence is optional and preserves independent failure classification", () => {
  expect(modelOverflowEvidenceOf(stampPartFailure(finish, "ContextOverflow"))).toEqual(Option.none())
  expect(modelOverflowEvidenceOf(stampPartFailure(finish, "ContextOverflow", evidence))).toEqual(Option.some(evidence))
  expect(modelOverflowEvidenceOf(stampResponseFailure([finish], "ContextOverflow", evidence))).toEqual(Option.some(evidence))
  expect(stampPartFailure(finish, "ContextOverflow", evidence).metadata).toEqual({ engine: { model: "actual:fallback", sibling: "keep", failure: "ContextOverflow", overflow: wire }, custom: { signature: "signed==" } })
  expect(stampPartFailure(finish, "Authentication", evidence).metadata["engine"]).not.toHaveProperty("overflow")
  expect(modelOverflowEvidenceOf({ metadata: { engine: { failure: "Authentication", overflow: wire } } })).toEqual(Option.none())
  const bad = [{}, { ...wire, model: null }, { ...wire, limits: { contextWindow: 0 } }, { ...wire, limits: { maxOutputTokens: Infinity } }, { ...wire, limits: { contextWindow: Number.MAX_SAFE_INTEGER + 1 } }]
  expect(bad.map((overflow) => modelFailureOf({ metadata: { engine: { failure: "ContextOverflow", overflow } } }))).toEqual(bad.map(() => Option.some("ContextOverflow")))
  expect(bad.map((overflow) => modelOverflowEvidenceOf({ metadata: { engine: { failure: "ContextOverflow", overflow } } }))).toEqual(bad.map(() => Option.none()))
  expect(Schema.decodeUnknownOption(ModelOverflowEvidence)({ ...wire, limits: {} })).toEqual(Option.some({ ...evidence, limits: {} }))
})

test("reads only the same own explicit stamp, without borrowing causes, later parts or provider data", () => {
  const actual = stampPartFailure(finish, "ContextOverflow", evidence)
  const empty = stampPartFailure(finish, "ContextOverflow")
  const auth = stampPartFailure(finish, "Authentication")
  expect(modelOverflowEvidenceOf([auth, actual])).toEqual(Option.none())
  expect(modelOverflowEvidenceOf([empty, actual])).toEqual(Option.none())
  const unknown = [wire, { cause: actual }, { error: actual }, { metadata: { vendor: { failure: "ContextOverflow", overflow: wire } } },
    { metadata: Object.create({ engine: { failure: "ContextOverflow", overflow: wire } }) },
    { metadata: { engine: Object.create({ failure: "ContextOverflow", overflow: wire }) } },
    { metadata: { engine: Object.assign(Object.create({ overflow: wire }), { failure: "ContextOverflow" }) } },
  ]
  expect(unknown.map(modelOverflowEvidenceOf)).toEqual(unknown.map(() => Option.none()))
})

test("stamping an AiError retains concrete reasons, HTTP/cause evidence and metadata siblings", () => {
  const http: typeof AiError.HttpContext.Type = { request: { method: "POST", url: "https://fixture.test/messages", urlParams: [], headers: {} }, response: { status: 413, headers: {} }, body: "original bytes" }
  const reason = new AiError.InvalidRequestError({ description: "original description", parameter: "messages", constraint: "context", http, metadata: finish.metadata })
  const original = AiError.make({ module: "Fixture", method: "generateText", reason })
  const stamped = stampAiErrorFailure(original, "ContextOverflow", evidence)
  expect(Object.getPrototypeOf(stamped)).toBe(Object.getPrototypeOf(original))
  expect(Object.getPrototypeOf(stamped.reason)).toBe(Object.getPrototypeOf(reason))
  expect(stamped.reason).toMatchObject({ description: reason.description, parameter: "messages", constraint: "context", http })
  expect(stamped.cause).toBe(stamped.reason)
  expect(Object.getPrototypeOf(stamped.cause)).toBe(Object.getPrototypeOf(original.cause))
  expect(stamped.reason.message).toBe(reason.message)
  expect(modelFailureOf(stamped)).toEqual(Option.some("ContextOverflow"))
  expect(modelOverflowEvidenceOf(stamped)).toEqual(Option.some(evidence))
  expect(modelOverflowEvidenceOf(Response.makePart("error", { error: stamped }))).toEqual(Option.some(evidence))
  expect(modelOverflowEvidenceOf({ ...finish, metadata: { engine: { failure: "Authentication" } }, error: stamped, type: "error" })).toEqual(Option.none())
  expect(JSON.stringify(reason.metadata)).toBe(JSON.stringify(finish.metadata))
})
