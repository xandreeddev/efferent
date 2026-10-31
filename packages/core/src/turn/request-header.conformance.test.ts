import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { HarnessError } from "../harness/plugin.entity.js"
import { readStored } from "../session/session-event.entity.functions.js"
import { resolveRequestHeader } from "./model-request-header.entity.functions.js"
import { StoredModelRequestHeader } from "./model-request-header.entity.js"
import { requestHeaderConformance } from "./request-header.conformance.js"
import type { RequestHeaderSubject } from "./request-header.conformance.js"

type Resolve = RequestHeaderSubject["resolve"]
const failedChecks = (resolve: Resolve) => Effect.runPromise(Effect.forEach(requestHeaderConformance({ resolve }), (check) =>
  Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])), { concurrency: 1 },
).pipe(Effect.map((results) => results.flat())))
const fail = () => Effect.fail(new HarnessError({ code: "request.decode", message: "careless resolver failed" }))

// Deliberately accepts advertised hashes without checking canonical contents.
const unchecked: Resolve = (events, at) => Effect.gen(function* () {
  const selected = events.find((event) => event.session === at.session && event.seq === at.seq)
  if (selected === undefined) return yield* fail()
  const header = yield* Schema.decodeUnknownEffect(StoredModelRequestHeader)(selected.data).pipe(Effect.mapError(() => new HarnessError({ code: "request.decode", message: "invalid" })))
  if (header.version === 1) return header
  const parts = yield* readStored("request.part", events).pipe(Effect.mapError(() => new HarnessError({ code: "request.decode", message: "invalid" })))
  const system = parts.find((part) => part.data.hash === header.system)
  if (system?.data.part._tag !== "System") return yield* fail()
  const tools = yield* Effect.forEach(header.tools, (hash) => {
    const part = parts.find((part) => part.data.hash === hash)
    return part?.data.part._tag === "Tool" ? Effect.succeed(part.data.part.tool) : fail()
  }, { concurrency: 1 })
  return { ...header, version: 1, system: system.data.part.text, tools }
})

const careless: ReadonlyArray<{ readonly name: string; readonly check: string; readonly resolve: Resolve }> = [
  { name: "trusting advertised hashes", check: "integrity", resolve: (events, at) => resolveRequestHeader(events, at).pipe(Effect.catch(() => unchecked(events, at))) },
  { name: "letting the latest duplicate hide earlier corrupt content", check: "integrity", resolve: (events, at) => resolveRequestHeader(events.filter((event, index) => event.kind !== "request.part" || !events.slice(index + 1).some((later) => later.kind === "request.part" && later.data.hash === event.data.hash)), at) },
  { name: "looking through future parts", check: "prefix", resolve: (events, at) => {
    const selected = events.find((event) => event.session === at.session && event.seq === at.seq)
    return selected === undefined ? fail() : resolveRequestHeader([...events.filter((event) => event !== selected), selected], at)
  } },
  { name: "sorting and deduplicating tool references", check: "v2", resolve: (events, at) => resolveRequestHeader(events, at).pipe(Effect.map((header) => ({ ...header, tools: [...new Map(header.tools.map((tool) => [tool.name, tool])).values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) }))) },
  { name: "ignoring an unsupported header version", check: "lookup", resolve: (events, at) => resolveRequestHeader(events.map((event) => event.data.version === 17 ? { ...event, data: { ...event.data, version: 1 } } : event), at) },
  { name: "decoding unrelated full header bodies eagerly", check: "lookup", resolve: (events, at) => readStored("request.prepared", events).pipe(Effect.mapError(() => new HarnessError({ code: "request.decode", message: "invalid" })), Effect.andThen(resolveRequestHeader(events, at))) },
]

test("the resolver kit names its five durable protocol promises", () => {
  expect(requestHeaderConformance().map((check) => check.name)).toEqual([
    "materialized V1 headers retain historical defaults and full bytes",
    "V2 parts materialize ordered tool references including repeats",
    "every referenced part is verified and identical duplicates are idempotent",
    "only parts preceding the selected lineage event may satisfy its references",
    "selected identity and version are strict while unrelated bodies stay opaque",
  ])
})

test.each([...requestHeaderConformance()])("the shipped resolver: $name", async (check) => {
  await Effect.runPromise(check.run)
})

test("a resolver that always refuses fails each documented check id", async () => {
  expect(await failedChecks(fail)).toEqual(["v1", "v2", "integrity", "prefix", "lookup"])
})

test.each([...careless])("the kit catches $name", async ({ resolve, check }) => {
  expect(await failedChecks(resolve)).toContain(check)
})
