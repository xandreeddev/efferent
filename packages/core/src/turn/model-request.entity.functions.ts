import { Array as Arr, Effect, Option, Order, Schema } from "effect"
import { Prompt, Tool } from "effect/ai"
import type { LanguageModel } from "effect/ai"
import type { ModelCallPolicy } from "../domain/model-call-policy.entity.js"
import { RunOrdinal } from "../domain/run.entity.js"
import type { RunId } from "../domain/run.entity.js"
import { HarnessError } from "../harness/plugin.entity.js"
import { isHarnessError } from "../harness/plugin.entity.functions.js"
import { toPromptMessages } from "../internal/mapping.entity.functions.js"
import { markVolatileContext } from "../internal/volatile-context.entity.functions.js"
import { toolParametersSchema } from "../internal/tool-schema.entity.functions.js"
import { canonicalJson, buildContext } from "../memory/memory-log.entity.functions.js"
import type { EntryId, LogEntry } from "../memory/memory-log.entity.js"
import type { SessionLogEvent } from "../session/session-log.entity.js"
import { entriesOfEvents, readStoredKeys } from "../session/session-event.entity.functions.js"
import { ModelRequestDescriptor, ModelRequestHeader, ProviderToolId } from "./model-request.entity.js"
import { resolveRequestHeader } from "./model-request-header.entity.functions.js"
import type { ModelRequestTool } from "./model-request.entity.js"
// The declarations this module emits name the user message through this import, not another package.
import type { UserMessage } from "./user-message.entity.js"
import { sha256Of } from "./request-part.entity.functions.js"

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
      Effect.mapError((error) => isHarnessError(error) ? error : new HarnessError({ code: "request.descriptor", message: error.message })),
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


/** A provider-defined tool's args as a header keeps them: their key names and their digest, never their values. */
const providerArgs = (args: unknown) => ({
  argKeys: typeof args === "object" && args !== null && !Array.isArray(args) ? Arr.sort(Object.keys(args), Order.String) : [],
  argsDigest: sha256Of(canonicalJson(args)),
})

/** Serialize active tools in activation order, independently at preparation and dispatch. */
export const modelRequestTools = (tools: ReadonlyArray<Tool.Any>): ReadonlyArray<ModelRequestTool> => tools.map((tool) => ({
  name: tool.name,
  description: Tool.getDescription(tool) ?? "",
  parameters: Tool.isDynamic(tool) && tool.jsonSchema !== undefined ? tool.jsonSchema : toolParametersSchema(tool),
  provider: Tool.isProviderDefined(tool)
    ? Option.some({ id: ProviderToolId.make(tool.id), name: tool.providerName, ...providerArgs(tool.args) })
    : Option.none(),
}))

const requestDecode = (error: Schema.SchemaError) => new HarnessError({ code: "request.decode", message: error.message })

/** The last `request.prepared` of this run and step, found by its keys alone (`readStoredKeys`). */
const headerEventOf = (events: ReadonlyArray<SessionLogEvent>, runId: RunId, step: number, run: RunOrdinal): Effect.Effect<SessionLogEvent, HarnessError> =>
  readStoredKeys("request.prepared", events).pipe(
    Effect.mapError(requestDecode),
    Effect.flatMap((headers) => Option.match(Option.fromNullishOr(headers.findLast((header) => header.keys.runId === runId && header.keys.run === run && header.keys.step === step)), {
      onNone: () => Effect.fail(new HarnessError({ code: "request.missing", message: `No durable request header for ${runId} run ${run} step ${step}` })),
      onSome: (header) => Effect.succeed(header.event),
    })),
  )

/** Last header for this run and step, decoded from a fresh durable snapshot. */
export const modelRequestHeaderOf = (events: ReadonlyArray<SessionLogEvent>, runId: RunId, step: number, run: RunOrdinal): Effect.Effect<ModelRequestHeader, HarnessError> =>
  headerEventOf(events, runId, step, run).pipe(Effect.flatMap((event) => resolveRequestHeader(events, event)))

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
export const reconstructModelRequest = Effect.fnUntraced(function* (header: ModelRequestHeader, entries: ReadonlyArray<LogEntry>) {
  const context = buildContext(yield* entriesThrough(entries, header.through), header.render)
  if (context.fingerprint !== header.contextFingerprint) {
    return yield* Effect.fail(diverged("context", `the memory events rebuild context ${context.fingerprint}, the request was prepared from ${header.contextFingerprint}`))
  }
  if (header.stableMessages !== undefined && header.stableMessages > context.messages.length) {
    return yield* Effect.fail(diverged("context", `the saved stable prefix ${header.stableMessages} exceeds the rebuilt message count ${context.messages.length}`))
  }
  const messages = header.stableMessages === undefined ? context.messages : markVolatileContext(context.messages, header.stableMessages)
  const prompt = Prompt.concat(Prompt.make([{ role: "system", content: header.system }]), Prompt.make(toPromptMessages(messages)))
  return {
    prompt, contextFingerprint: context.fingerprint, tools: header.tools, toolChoice: header.toolChoice,
    model: header.model, cacheKey: header.cacheKey, callPolicy: header.callPolicy,
  }
})

/**
 * Reconstruct one historical request from the events up to its header,
 * excluding later responses and turns: the request of `step` in the run
 * `run` (its ordinal, 0 by default: a turn's first run, and every request
 * stored before runs were counted) of the turn `runId` began.
 */
export const replayModelRequest = Effect.fnUntraced(function* (events: ReadonlyArray<SessionLogEvent>, runId: RunId, step: number, run: RunOrdinal = RunOrdinal.make(0)) {
  const found = yield* headerEventOf(events, runId, step, run)
  const header = yield* resolveRequestHeader(events, found)
  const entries = yield* entriesOfEvents(events.slice(0, events.indexOf(found) + 1)).pipe(
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
