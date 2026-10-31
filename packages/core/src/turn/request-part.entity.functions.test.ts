import { expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import { ModelRequestHeader, ProviderToolId } from "./model-request.entity.js"
import type { ModelRequestTool } from "./model-request.entity.js"
import { encodeRequestPart, prepareRequestParts, sha256Of } from "./request-part.entity.functions.js"

const vectors = [
  { text: "", hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  { text: "abc", hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
  { text: "你好, 🌍", hash: "9325c9ce3c402322c241a9eb4abd9ea64b557db848e60d458e67d26e6cac3ded" },
  { text: "a".repeat(55), hash: "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318" },
  { text: "a".repeat(56), hash: "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a" },
  { text: "a".repeat(63), hash: "7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34" },
  { text: "a".repeat(64), hash: "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb" },
  { text: "a".repeat(65), hash: "635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0" },
  { text: "a".repeat(1000), hash: "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3" },
]
test.each(vectors)("SHA-256 matches independent UTF-8 and block-boundary vector $hash", ({ text, hash }) => {
  expect(sha256Of(text)).toBe(hash)
})

const tool: ModelRequestTool = { name: "find", description: "Search", parameters: { b: 2, a: { z: 1 } }, provider: Option.none() }
const header = (tools: ReadonlyArray<ModelRequestTool>): ModelRequestHeader => ({
  version: 1, runId: RunId.make("parts"), run: RunOrdinal.make(0), step: 2, strategyVersion: "2", system: "hello",
  render: { strategy: "window", currentTurn: 1, currentRun: RunId.make("parts"), run: RunOrdinal.make(0), turnContext: "current", replies: true, stepContext: "tail", digests: true, media: { mode: "none", maxImages: 8, maxChars: 1000 } },
  through: Option.none(), contextFingerprint: "frozen-context", tools, toolChoice: "auto", model: Option.none(), cacheKey: Option.some("lane"), callPolicy: Option.some({ effort: "low", maxOutputTokens: 32 }),
})

test("part hashes cover the tag and canonical encoded bytes, including provider null", async () => {
  const [system, declaration, reordered] = await Effect.runPromise(Effect.all([
    encodeRequestPart({ _tag: "System", text: "hello" }),
    encodeRequestPart({ _tag: "Tool", tool }),
    encodeRequestPart({ _tag: "Tool", tool: { ...tool, parameters: { a: { z: 1 }, b: 2, omitted: undefined } } }),
  ], { concurrency: 1 }))
  expect(system.hash).toBe("8c1660fd33db21473f2fa59eb3a00b0af268f310ee28f6b408b5b9a39884606a")
  expect(declaration.hash).toBe("7bca0edb5e193b119901f18aeb336a79d4b10a6b9bb595733caa808384d2fc23")
  expect(declaration.hash).toBe(reordered.hash)
  expect(declaration.part._tag === "Tool" ? declaration.part.tool.provider : "wrong tag").toBeNull()
  expect(canonicalJson(declaration)).not.toContain('"_id":"Option"')
  expect(system.hash).not.toBe(sha256Of("hello"))
})

test("provider declarations encode only their names and precomputed argument digest", async () => {
  const provided = { id: ProviderToolId.make("fixture.remote"), name: "remote", argKeys: ["authorization", "url"], argsDigest: sha256Of("private-fixture-value") }
  const encoded = await Effect.runPromise(encodeRequestPart({ _tag: "Tool", tool: { ...tool, provider: Option.some(provided) } }))
  expect(encoded.part._tag === "Tool" ? encoded.part.tool.provider : null).toEqual(provided)
  expect(canonicalJson(encoded)).not.toContain("private-fixture-value")
})

test("one immutable plan deduplicates bodies and keeps ordered repeated tool references", async () => {
  const changed = { ...tool, name: "other", description: "Different declaration" }
  const input = header([tool, tool, changed, tool])
  const result = await Effect.runPromise(prepareRequestParts(input))
  expect(result.header.version).toBe(2)
  expect(result.parts).toHaveLength(3)
  const systemHash = result.parts[0]!.hash
  const firstToolHash = result.parts[1]!.hash
  const secondToolHash = result.parts[2]!.hash
  expect(result.header.tools).toEqual([firstToolHash, firstToolHash, secondToolHash, firstToolHash])
  expect(result.header.system).toBe(systemHash)
  expect(result.header.callPolicy).toEqual({ effort: "low", maxOutputTokens: 32 })
  expect(result.header.model).toBeNull()
  expect(result.header.cacheKey).toBe("lane")
  expect("stableMessages" in result.header).toBe(false)
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result.parts)).toBe(true)
  expect(Object.isFrozen(result.parts[1]?.part)).toBe(true)
  const encoded = await Effect.runPromise(Schema.encodeEffect(ModelRequestHeader)(input))
  expect(result.header).toEqual({ ...encoded, version: 2, system: systemHash, tools: result.header.tools })
})

test("preparation detaches JSON from the caller's mutable tool parameters", async () => {
  const mutable = { description: "Search", parameters: { retained: "original" } }
  const input = header([{ ...tool, ...mutable }])
  const result = await Effect.runPromise(prepareRequestParts(input))
  mutable.parameters.retained = "changed"
  const part = result.parts[1]?.part
  expect(part?._tag === "Tool" ? part.tool.parameters : null).toEqual({ retained: "original" })
  expect(Object.isFrozen(mutable.parameters)).toBe(false)
  expect(canonicalJson(input)).toContain("changed")
  expect(canonicalJson(result)).not.toContain("changed")
})

test("non-JSON tool parameters fail the codec before any write plan is returned", async () => {
  const result = await Effect.runPromise(Effect.result(prepareRequestParts(header([{ ...tool, parameters: { invalid: 1n } }]))))
  expect(result._tag).toBe("Failure")
})
