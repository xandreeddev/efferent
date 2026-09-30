import { Effect, Option, Schema } from "effect"
import { Prompt, Tool } from "effect/ai"
import type { LanguageModel } from "effect/ai"
import type { ModelCallPolicy } from "../domain/model-call-policy.entity.js"
import { HarnessError } from "../harness/plugin.entity.js"
import { toPromptMessages } from "../loop/mapping.js"
import { toolParametersSchema } from "../loop/toolSchema.js"
import { canonicalJson, buildContext } from "../memory/memory-log.entity.functions.js"
import type { EntryId, LogEntry } from "../memory/memory-log.entity.js"
import type { SessionLogEvent } from "../session/session-log.entity.js"
import { entriesOfEvents } from "../session/session-event.entity.functions.js"
import { ModelRequestDescriptor, ModelRequestHeader } from "./model-request.entity.js"
import type { ModelRequestTool } from "./model-request.entity.js"

const descriptorKey = "efferent/model-request-descriptor" as const
const resolverKey = "efferent/model-request-resolver" as const

/** Attach inspectable public configuration to an otherwise opaque Effect AI model. */
export const describeModel = (
  model: LanguageModel.LanguageModel,
  descriptor: ModelRequestDescriptor | Effect.Effect<ModelRequestDescriptor, HarnessError>,
): LanguageModel.LanguageModel => {
  const described = { ...model, [descriptorKey]: Effect.isEffect(descriptor) ? descriptor : Effect.succeed(descriptor) }
  return described
}

/** An undescribed model is explicitly opaque; descriptions are checked at each dispatch. */
export const modelRequestDescriptorOf = (model: LanguageModel.LanguageModel): Effect.Effect<Option.Option<ModelRequestDescriptor>, HarnessError> => {
  const candidate = descriptorKey in model ? model[descriptorKey] : undefined
  return Effect.isEffect(candidate)
    ? (candidate as Effect.Effect<unknown, HarnessError>).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ModelRequestDescriptor)),
      Effect.map(Option.some),
      Effect.mapError((error) => error instanceof HarnessError ? error : new HarnessError({ code: "request.descriptor", message: error.message })),
    )
    : Effect.succeed(Option.none())
}

/**
 * A model that reads its configuration per call (a settings-backed router)
 * resolves it once per step: the model `resolve` returns serves the step's
 * header and every provider attempt of the step (a stream's fallback
 * included), so a configuration change applies from the next step.
 */
export const resolvingModel = (
  model: LanguageModel.LanguageModel,
  resolve: Effect.Effect<LanguageModel.LanguageModel, HarnessError>,
): LanguageModel.LanguageModel => {
  const resolving = { ...model, [resolverKey]: resolve }
  return resolving
}

/** The model one step uses: a resolving model's resolution, any other model itself. */
export const resolveModelRequest = (model: LanguageModel.LanguageModel): Effect.Effect<LanguageModel.LanguageModel, HarnessError> => {
  const candidate = resolverKey in model ? model[resolverKey] : undefined
  return Effect.isEffect(candidate) ? candidate as Effect.Effect<LanguageModel.LanguageModel, HarnessError> : Effect.succeed(model)
}

type Words = readonly [number, number, number, number, number, number, number, number]

/** SHA-256's initial hash and round constants (FIPS 180-4). */
const initialHash: Words = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
const rounds: ReadonlyArray<number> = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))
const at = (words: ReadonlyArray<number>, index: number): number => words[index] ?? 0

/** SHA-256 of a text's UTF-8 bytes, in hex: pure, as the core has no platform crypto. */
const sha256Of = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  const size = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(size)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(size - 8, Math.floor(bytes.length / 0x20000000))
  view.setUint32(size - 4, (bytes.length * 8) >>> 0)
  const schedule = (block: number): ReadonlyArray<number> => Array.from({ length: 48 }, (_, index) => index + 16).reduce(
    (words: ReadonlyArray<number>, index) => {
      const early = at(words, index - 15)
      const late = at(words, index - 2)
      const s0 = rotr(early, 7) ^ rotr(early, 18) ^ (early >>> 3)
      const s1 = rotr(late, 17) ^ rotr(late, 19) ^ (late >>> 10)
      return [...words, (at(words, index - 16) + s0 + at(words, index - 7) + s1) >>> 0]
    },
    Array.from({ length: 16 }, (_, index) => view.getUint32(block * 64 + index * 4)),
  )
  const compress = (hash: Words, block: number): Words => {
    const [a, b, c, d, e, f, g, h] = schedule(block).reduce(([a, b, c, d, e, f, g, h]: Words, word, index): Words => {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + at(rounds, index) + word) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      return [(t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g]
    }, hash)
    return [(hash[0] + a) >>> 0, (hash[1] + b) >>> 0, (hash[2] + c) >>> 0, (hash[3] + d) >>> 0,
      (hash[4] + e) >>> 0, (hash[5] + f) >>> 0, (hash[6] + g) >>> 0, (hash[7] + h) >>> 0]
  }
  return Array.from({ length: size / 64 }, (_, block) => block).reduce(compress, initialHash)
    .map((word) => word.toString(16).padStart(8, "0")).join("")
}

/** A provider-defined tool's args as a header keeps them: their key names and their digest, never their values. */
const providerArgs = (args: unknown) => ({
  argKeys: typeof args === "object" && args !== null && !Array.isArray(args) ? Object.keys(args).sort() : [],
  argsDigest: sha256Of(canonicalJson(args)),
})

/** Serialize active tools in activation order, independently at preparation and dispatch. */
export const modelRequestTools = (tools: ReadonlyArray<Tool.Any>): ReadonlyArray<ModelRequestTool> => tools.map((tool) => ({
  name: tool.name,
  description: Tool.getDescription(tool) ?? "",
  parameters: Tool.isDynamic(tool) && tool.jsonSchema !== undefined ? tool.jsonSchema : toolParametersSchema(tool),
  provider: Tool.isProviderDefined(tool)
    ? Option.some({ id: tool.id, name: tool.providerName, ...providerArgs(tool.args) })
    : Option.none(),
}))

/** Last header for this run and step, decoded from a fresh durable snapshot. */
export const modelRequestHeaderOf = (events: ReadonlyArray<SessionLogEvent>, runId: string, step: number): Effect.Effect<ModelRequestHeader, HarnessError> => {
  const header = events.filter((event) => event.kind === "request.prepared" && event.data.runId === runId && event.data.step === step).at(-1)
  return header === undefined
    ? Effect.fail(new HarnessError({ code: "request.missing", message: `No durable request header for ${runId} step ${step}` }))
    : Schema.decodeUnknownEffect(ModelRequestHeader)(header.data).pipe(
      Effect.mapError((error) => new HarnessError({ code: "request.decode", message: error.message })),
    )
}

/** A model request as a dispatch check compares it: the Effect AI prompt, and the parts the header declares. */
export interface ComparedModelRequest {
  readonly prompt: Prompt.Prompt
  readonly tools: ReadonlyArray<ModelRequestTool>
  readonly toolChoice: unknown
  readonly model: Option.Option<ModelRequestDescriptor>
  readonly cacheKey: Option.Option<string>
  readonly callPolicy: Option.Option<ModelCallPolicy>
}

const diverged = (part: string, detail: string) => new HarnessError({ code: "request.diverged", message: `${part}: ${detail}` })

/** The entries a build folded: the log up to and including its cut. */
const entriesThrough = (entries: ReadonlyArray<LogEntry>, through: Option.Option<EntryId>): Effect.Effect<ReadonlyArray<LogEntry>, HarnessError> =>
  Option.match(through, {
    onNone: () => Effect.succeed([]),
    onSome: (id) => {
      const cut = entries.findIndex((entry) => entry.id === id)
      return cut < 0
        ? Effect.fail(diverged("context", `the memory entry ${id} the request was built through is not in the events`))
        : Effect.succeed(entries.slice(0, cut + 1))
    },
  })

/**
 * Rebuild a request from its header and memory facts: the entries up to the
 * header's cut, folded with its saved render recipe, never with current
 * plugin definitions. Fails with `request.diverged` (`context`) when they do
 * not rebuild the context the header was prepared from (a fork's own log
 * without its parent's history, say).
 */
export const reconstructModelRequest = (header: ModelRequestHeader, entries: ReadonlyArray<LogEntry>) => Effect.gen(function* () {
  const context = buildContext(yield* entriesThrough(entries, header.through), header.render)
  if (context.fingerprint !== header.contextFingerprint) {
    return yield* Effect.fail(diverged("context", `the memory events rebuild context ${context.fingerprint}, the request was prepared from ${header.contextFingerprint}`))
  }
  const prompt = Prompt.concat(Prompt.make([{ role: "system", content: header.system }]), Prompt.make(toPromptMessages(context.messages) as Prompt.RawInput))
  return {
    prompt, contextFingerprint: context.fingerprint, tools: header.tools, toolChoice: header.toolChoice,
    model: header.model, cacheKey: header.cacheKey, callPolicy: header.callPolicy,
  }
})

/** Reconstruct one historical request from the events up to its header, excluding later responses and turns. */
export const replayModelRequest = (events: ReadonlyArray<SessionLogEvent>, runId: string, step: number) => Effect.gen(function* () {
  const header = yield* modelRequestHeaderOf(events, runId, step)
  const position = events.findLastIndex((event) => event.kind === "request.prepared" && event.data.runId === runId && event.data.step === step)
  const entries = yield* entriesOfEvents(events.slice(0, position + 1)).pipe(
    Effect.mapError((error) => new HarnessError({ code: "request.memory", message: error.message })),
  )
  return yield* reconstructModelRequest(header, entries)
})

/** Freeze JSON message data before handing it to a model wrapper. */
export const freezeModelRequest = <A>(value: A): A => {
  if (typeof value !== "object" || value === null) return value
  Object.values(value).map(freezeModelRequest)
  return Object.freeze(value)
}

/** The parts of a request, in the order a divergence is named. */
const requestParts = (request: ComparedModelRequest): ReadonlyArray<readonly [string, unknown]> => [
  ["system", request.prompt.content.slice(0, 1)],
  ["messages", request.prompt.content.slice(1)],
  ["tools", request.tools],
  ["toolChoice", request.toolChoice],
  ["model", request.model],
  ["cacheKey", request.cacheKey],
  ["callPolicy", request.callPolicy],
]

/**
 * Compare canonical model-visible bytes, part by part, not object identity or
 * hashes alone. A divergence fails with `request.diverged`, its message
 * starting with the first part that differs (`system`, `messages`, `tools`,
 * `toolChoice`, `model`, `cacheKey` or `callPolicy`).
 */
export const checkModelRequest = (expected: ComparedModelRequest, actual: ComparedModelRequest): Effect.Effect<void, HarnessError> => {
  const dispatched = requestParts(actual)
  const differing = requestParts(expected).find(([, value], index) => canonicalJson(value) !== canonicalJson(dispatched[index]?.[1]))
  return differing === undefined
    ? Effect.void
    : Effect.fail(diverged(differing[0], "the dispatched request differs from its saved header and memory events"))
}
