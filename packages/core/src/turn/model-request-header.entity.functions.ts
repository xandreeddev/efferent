import { Effect, Match, Option, Schema } from "effect"
import { HarnessError } from "../harness/plugin.entity.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import { storedJson } from "../session/session-log.entity.functions.js"
import type { SessionLogEvent } from "../session/session-log.entity.js"
import { StoredModelRequestHeader } from "./model-request-header.entity.js"
import { ModelRequestHeader } from "./model-request.entity.js"
import type { ModelRequestHeaderV2 } from "./model-request-header.entity.js"
import type { ModelRequestTool } from "./model-request.entity.js"
import { encodeRequestPart } from "./request-part.entity.functions.js"
import { RequestPart, RequestPartData, RequestPartHash } from "./request-part.entity.js"

const decodeFailure = (cause: Schema.SchemaError) => new HarnessError({ code: "request.decode", message: "The durable request protocol could not be decoded", cause })
const diverged = (category: "system" | "tools" | "header", detail: string, cause?: unknown) =>
  new HarnessError({ code: "request.diverged", message: `${category}: ${detail}`, ...(cause === undefined ? {} : { cause }) })
const partKeys = Schema.Struct({ hash: RequestPartHash })

const resolvePart = Effect.fnUntraced(function* (
  keys: ReadonlyArray<{ readonly event: SessionLogEvent; readonly hash: RequestPartHash }>,
  hash: RequestPartHash,
  category: "system" | "tools",
) {
  const matches = keys.filter((part) => part.hash === hash)
  if (matches.length === 0) return yield* Effect.fail(diverged(category, "a referenced request part is missing"))
  const verified = yield* Effect.forEach(matches, ({ event }) => Schema.decodeUnknownEffect(RequestPartData)(event.data).pipe(
    Effect.flatMap((data) => encodeRequestPart(data.part)),
    Effect.mapError((cause) => diverged(category, "a referenced request part is invalid", cause)),
    Effect.flatMap((data) => data.hash === hash ? Effect.succeed(data) : Effect.fail(diverged(category, "a referenced request part does not match its hash"))),
  ), { concurrency: 1 })
  const first = verified[0]!
  if (verified.some((part) => canonicalJson(part.part) !== canonicalJson(first.part))) {
    return yield* Effect.fail(diverged(category, "referenced request parts disagree"))
  }
  return yield* Schema.decodeUnknownEffect(RequestPart)(first.part).pipe(Effect.mapError((cause) => diverged(category, "a referenced request part is invalid", cause)))
})

const materialize = Effect.fnUntraced(function* (prefix: ReadonlyArray<SessionLogEvent>, header: ModelRequestHeaderV2) {
  // Decode only lookup keys first: unrelated part bodies remain opaque.
  const keys = yield* Effect.forEach(prefix.filter((event) => event.kind === "request.part"), (event) =>
    Schema.decodeUnknownEffect(partKeys)(event.data).pipe(Effect.map(({ hash }) => ({ event, hash })), Effect.mapError(decodeFailure)), { concurrency: 1 })
  const system = yield* resolvePart(keys, header.system, "system")
  const text = yield* Match.valueTags(system, {
    System: ({ text }) => Effect.succeed(text),
    Tool: () => Effect.fail(diverged("system", "the referenced request part has the wrong tag")),
  })
  const tools = yield* Effect.forEach(header.tools, (hash): Effect.Effect<ModelRequestTool, HarnessError> =>
    resolvePart(keys, hash, "tools").pipe(Effect.flatMap((part) => Match.valueTags(part, {
      Tool: ({ tool }) => Effect.succeed(tool),
      System: () => Effect.fail(diverged("tools", "the referenced request part has the wrong tag")),
    }))), { concurrency: 1 })
  return { ...header, version: 1 as const, system: text, tools }
})

/**
 * Resolve a stored header in its supplied authorized lineage prefix. V2 parts
 * materialize as the full V1 compatibility representation. No storage is read.
 * @public
 */
export const resolveRequestHeader = Effect.fnUntraced(function* (
  events: ReadonlyArray<SessionLogEvent>, at: Pick<SessionLogEvent, "session" | "seq">,
): Effect.fn.Return<ModelRequestHeader, HarnessError> {
  const matches = events.filter((event) => event.session === at.session && event.seq === at.seq)
  const selected = Option.fromNullishOr(matches[0])
  if (matches.length > 1) return yield* Effect.fail(diverged("header", "the selected event identity is ambiguous"))
  const event = yield* Option.match(selected, {
    onNone: () => Effect.fail(new HarnessError({ code: "request.missing", message: "No durable request header at the selected event" })),
    onSome: Effect.succeed,
  })
  if (event.kind !== "request.prepared") {
    return yield* Effect.fail(new HarnessError({ code: "request.decode", message: "The selected event is not a durable request header" }))
  }
  const header = yield* storedJson(event.data).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(StoredModelRequestHeader)), Effect.mapError(decodeFailure),
  )
  return yield* Match.value(header).pipe(
    Match.when({ version: 1 }, (header) => Effect.succeed(header)),
    Match.when({ version: 2 }, (header) => materialize(events.slice(0, events.indexOf(event)), header)),
    Match.exhaustive,
  )
})
