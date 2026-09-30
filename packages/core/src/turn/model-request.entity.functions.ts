import { Effect, Option, Schema } from "effect"
import { Prompt, Tool } from "effect/ai"
import type { LanguageModel } from "effect/ai"
import { HarnessError } from "../harness/plugin.entity.js"
import { toPromptMessages } from "../loop/mapping.js"
import { toolParametersSchema } from "../loop/toolSchema.js"
import { canonicalJson, buildContext } from "../memory/memory-log.entity.functions.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
import type { SessionLogEvent } from "../session/session-log.entity.js"
import { entriesOfEvents } from "../session/session-event.entity.functions.js"
import { ModelRequestDescriptor, ModelRequestHeader } from "./model-request.entity.js"
import type { ModelRequestTool } from "./model-request.entity.js"

const descriptorKey = "efferent/model-request-descriptor" as const

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

/** Serialize active tools in activation order, independently at preparation and dispatch. */
export const modelRequestTools = (tools: ReadonlyArray<Tool.Any>): ReadonlyArray<ModelRequestTool> => tools.map((tool) => ({
  name: tool.name,
  description: Tool.getDescription(tool) ?? "",
  parameters: Tool.isDynamic(tool) && tool.jsonSchema !== undefined ? tool.jsonSchema : toolParametersSchema(tool),
  provider: Tool.isProviderDefined(tool)
    ? Option.some({ id: tool.id, name: tool.providerName, args: tool.args })
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

/** Replay reconstructs messages from memory facts and the saved render recipe, never from current plugin definitions. */
export const reconstructModelRequest = (header: ModelRequestHeader, entries: ReadonlyArray<LogEntry>) => {
  const context = buildContext(entries, header.render)
  const prompt = Prompt.concat(Prompt.make([{ role: "system", content: header.system }]), Prompt.make(toPromptMessages(context.messages) as Prompt.RawInput))
  return { prompt, contextFingerprint: context.fingerprint, tools: header.tools, toolChoice: header.toolChoice, model: header.model, cacheKey: header.cacheKey, callPolicy: header.callPolicy }
}

/** Reconstruct one historical request at its recorded log position, excluding later responses and turns. */
export const replayModelRequest = (events: ReadonlyArray<SessionLogEvent>, runId: string, step: number) => Effect.gen(function* () {
  const header = yield* modelRequestHeaderOf(events, runId, step)
  const position = events.findLastIndex((event) => event.kind === "request.prepared" && event.data.runId === runId && event.data.step === step)
  const entries = yield* entriesOfEvents(events.slice(0, position + 1)).pipe(
    Effect.mapError((error) => new HarnessError({ code: "request.memory", message: error.message })),
  )
  return reconstructModelRequest(header, entries)
})

/** Freeze JSON message data before handing it to a model wrapper. */
export const freezeModelRequest = <A>(value: A): A => {
  if (typeof value !== "object" || value === null) return value
  Object.values(value).map(freezeModelRequest)
  return Object.freeze(value)
}

/** Compare canonical model-visible bytes, not object identity or hashes alone. */
export const checkModelRequest = (expected: unknown, actual: unknown): Effect.Effect<void, HarnessError> => canonicalJson(expected) === canonicalJson(actual)
  ? Effect.void
  : Effect.fail(new HarnessError({ code: "request.diverged", message: "The model request diverges from its durable memory derivation or saved header" }))
