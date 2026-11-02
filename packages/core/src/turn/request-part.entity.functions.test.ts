import { expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import { ModelRequestHeader, ProviderToolId } from "./model-request.entity.js"
import type { ModelRequestTool } from "./model-request.entity.js"
import { encodeRequestPart, prepareRequestParts, sha256BytesOf, sha256Of } from "./request-part.entity.functions.js"

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

// Independent vectors (a platform SHA-256) over every byte value and the largest image a media store holds.
const pattern = (size: number, of: (index: number) => number) => Uint8Array.from({ length: size }, (_, index) => of(index))
test.each([
  { size: 1, hash: "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d" },
  { size: 55, hash: "576a1bf8d4478657e6dc4af9398544765c2a92cde28478b019235cfed315fc09" },
  { size: 56, hash: "9b20501dfd1d99161c257950f3444f3e49230c351c5c8e0943ef369f85f5205d" },
  { size: 63, hash: "30b345906b493f06f69444b6521113511c242f30e29840462950035043682f1e" },
  { size: 64, hash: "d8bc63b4fc1156e5e7d95a418b9bf54cd3174bedbc2db40f74895349b229b3c0" },
  { size: 65, hash: "1ee23b0fbcaecc1aff4a9e8f1645f35ab2c8e13609cd73b68df8b5e3f63ce073" },
  { size: 119, hash: "7a6589821178918ca8d9edaba5abfc1e9b2669564f4469b66885379c1530b2c8" },
  { size: 120, hash: "655250427d56b1b0eeb8497d21428704273458a01772d6881b65c0abac0f8a98" },
  { size: 1000, hash: "89f4ff56a25dd1db06a4ce6033603775d705fb96f30f8693733fef602a1ca532" },
])("SHA-256 of $size binary bytes matches the platform digest", ({ size, hash }) => {
  expect(sha256BytesOf(pattern(size, (index) => (index * 7) & 255))).toBe(hash)
})

test("SHA-256 of the largest storable image matches the platform digest", () => {
  expect(sha256BytesOf(pattern(3_932_160, (index) => index % 251))).toBe("fc0b9cc56eee135365cf2263e5febc47ae1f43315f0ce2c2738bf6b0f6919be1")
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
