import { Effect, Option } from "effect"
import { check, expect } from "../conformance.functions.js"
import type { ConformanceCheck } from "../conformance.entity.js"
import { ConversationId } from "../domain/message.entity.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import type { JsonObject, SessionLogEvent } from "../session/session-log.entity.js"
import { resolveRequestHeader } from "./model-request-header.entity.functions.js"

/** A pure resolver over the caller's authorized, ordered journal prefix. @public */
export interface RequestHeaderSubject {
  readonly resolve: typeof resolveRequestHeader
}

const session = ConversationId.make("00000000-0000-4000-8000-00000000a721")
const child = ConversationId.make("00000000-0000-4000-8000-00000000a722")
// Independently computed SHA-256 vectors of canonical encoded tagged JSON.
const systemHash = "814d76f8a074500fd06a82c3589082ed4a3ed1281ae584ab9fa698fd2287e37b"
const firstHash = "09602a19a0b820b8fa4e8ec5efa087cf8f829ce27207af5e2606031bd0e8364b"
const secondHash = "121996cc2b7a383665948cbfc6fb00b04fc3011a7156e0555efd0697125af2d2"
const tool = (name: string, description: string): JsonObject => ({ name, description, parameters: { type: "object", properties: {} }, provider: null })
const first = tool("first", "First tool.")
const second = tool("second", "Second tool.")
const row = (seq: number, kind: string, data: JsonObject, id = session): SessionLogEvent => ({ session: id, seq, kind, data, at: 0, turn: Option.some(1) })
const part = (seq: number, hash: string, value: JsonObject): SessionLogEvent => row(seq, "request.part", { hash, part: value })
const system = part(10, systemHash, { _tag: "System", text: "system α" })
const parts = [system, part(11, firstHash, { _tag: "Tool", tool: first }), part(12, secondHash, { _tag: "Tool", tool: second })]
const header = (version = 2): JsonObject => ({
  version, runId: "request-run", step: 0, strategyVersion: "1", system: version === 1 ? "system α" : systemHash,
  render: { strategy: "window", currentTurn: 1, currentRun: "request-run", turnContext: "current", replies: true, stepContext: "tail", digests: true, media: { mode: "none", maxImages: 8 } },
  through: null, contextFingerprint: "f", tools: version === 1 ? [second, first, second] : [secondHash, firstHash, secondHash],
  toolChoice: "auto", model: null, cacheKey: null, callPolicy: null,
})
const prepared = row(13, "request.prepared", header())

const rejects = (subject: RequestHeaderSubject, id: string, events: ReadonlyArray<SessionLogEvent>, at: Pick<SessionLogEvent, "session" | "seq">, code: string) =>
  subject.resolve(events, at).pipe(Effect.result, Effect.flatMap((result) => expect(id, result._tag === "Failure" && result.failure.code === code, `expected ${code}`)))

/** Resolve old and referenced headers without trusting hashes or later facts. @public */
export const requestHeaderConformance = (subject: RequestHeaderSubject = { resolve: resolveRequestHeader }): ReadonlyArray<ConformanceCheck> => [
  check("materialized V1 headers retain historical defaults and full bytes", "v1", () => Effect.gen(function* () {
    const event = row(1, "request.prepared", header(1))
    const found = yield* subject.resolve([event], event)
    yield* expect("v1", found.version === 1 && found.system === "system α" && found.run === 0 && found.render.run === 0 && found.render.media.maxChars === 20_000_000, "historical defaults or system changed")
    yield* expect("v1", found.stableMessages === undefined && Option.isNone(found.model) && Option.isNone(found.through), "optional/opaque fields changed")
    yield* expect("v1", found.tools.map((tool) => tool.name).join() === "second,first,second" && Option.isNone(found.tools[0]!.provider), "tool bytes/order changed")
  })),
  check("V2 parts materialize ordered tool references including repeats", "v2", () => Effect.gen(function* () {
    const found = yield* subject.resolve([...parts, prepared], prepared)
    yield* expect("v2", found.version === 1 && found.system === "system α" && found.tools.map((tool) => tool.name).join() === "second,first,second", "V2 did not materialize full ordered fields")
    yield* expect("v2", canonicalJson(found.tools[1]?.parameters) === canonicalJson(first.parameters) && Option.isNone(found.model), "tool schema or opaque model changed")
    const fresh = yield* subject.resolve([...parts, prepared], { session, seq: 13 })
    yield* expect("v2", canonicalJson(found) === canonicalJson(fresh), "selector object identity affected resolution")
  })),
  check("every referenced part is verified and identical duplicates are idempotent", "integrity", () => Effect.gen(function* () {
    const duplicate = { ...system, seq: 9 }
    yield* subject.resolve([duplicate, ...parts, prepared], prepared)
    const badBodies: ReadonlyArray<JsonObject> = [
      { hash: systemHash, part: { _tag: "System", text: "tampered" } },
      { hash: systemHash, part: { _tag: "Tool", tool: first } },
      { hash: systemHash, part: { _tag: "System", text: 42 } },
    ]
    yield* Effect.forEach(badBodies, (data) => rejects(subject, "integrity", [row(9, "request.part", data), ...parts, prepared], prepared, "request.diverged"), { concurrency: 1 })
    yield* rejects(subject, "integrity", [...parts.slice(1), prepared], prepared, "request.diverged")
    const wrongTag = row(13, "request.prepared", { ...header(), system: firstHash })
    yield* rejects(subject, "integrity", [...parts, wrongTag], wrongTag, "request.diverged")
    const unrelated = part(9, "0".repeat(64), { _tag: "broken", text: false })
    yield* subject.resolve([unrelated, ...parts, prepared], prepared)
    yield* rejects(subject, "integrity", [row(9, "request.part", { hash: "bad", part: {} }), ...parts, prepared], prepared, "request.decode")
  })),
  check("only parts preceding the selected lineage event may satisfy its references", "prefix", () => Effect.gen(function* () {
    const early = { ...prepared, seq: 1 }
    yield* rejects(subject, "prefix", [early, ...parts], early, "request.diverged")
    const laterBad = part(14, systemHash, { _tag: "System", text: "future conflict" })
    yield* subject.resolve([...parts, prepared, laterBad], prepared)
    // Ancestor seq 10..12 precede child seq 1 in logical lineage order.
    const forked = { ...prepared, session: child, seq: 1 }
    const found = yield* subject.resolve([...parts, forked], forked)
    yield* expect("prefix", found.system === "system α", "per-session sequence numbers were globally sorted")
  })),
  check("selected identity and version are strict while unrelated bodies stay opaque", "lookup", () => Effect.gen(function* () {
    const damaged = row(1, "request.prepared", { ...header(1), system: 42, runId: "unrelated" })
    const old = row(2, "request.prepared", header(1))
    yield* subject.resolve([damaged, old], old)
    yield* rejects(subject, "lookup", [old], { session, seq: 99 }, "request.missing")
    yield* rejects(subject, "lookup", [old, { ...old }], old, "request.diverged")
    const foreign = { ...old, kind: "host.example" }
    yield* rejects(subject, "lookup", [foreign], foreign, "request.decode")
    const invalid = row(3, "request.prepared", { ...header(1), version: 17 })
    yield* rejects(subject, "lookup", [invalid], invalid, "request.decode")
  })),
]
