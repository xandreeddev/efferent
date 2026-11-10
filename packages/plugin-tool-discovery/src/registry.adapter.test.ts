import { describe, expect, test } from "bun:test"
import { Tool } from "effect/ai"
import { Effect, Option, Schema, SchemaGetter } from "effect"
import { defineCapability, defineSkill, defineTool, Failure, Media, mediaFromBase64, UserMessage } from "@xandreed/core"
import { catalogText, makeRegistry } from "./registry.adapter.js"
import type { DiscoveryConfig } from "./registry.adapter.js"

// The registry inside a turn (calls, refusals, activation, its own tools) is
// tested over the sdk's `TurnLive`: `packages/sdk/src/tool-discovery-turn.test.ts`.

const config: DiscoveryConfig = {
  grants: [], loadSkill: true, maxCallsPerRun: 8, maxSkillLoadsPerRun: 4, readConcurrency: 2, matcherTimeoutMs: 1_000, catalogVersion: "test",
}

describe("the views of a result holding images", () => {
  const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  const pixelGif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
  const Shots = Tool.make("shots", {
    description: "Two screenshots.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({ before: Media, after: Media }),
    failure: Failure,
    failureMode: "return",
  })
  const Raw = Tool.make("raw_shots", { description: "Two screenshots, no view.", parameters: Schema.Struct({}), success: Schema.Struct({ before: Media, after: Media }), failure: Failure, failureMode: "return" })
  const capability = defineCapability({
    id: "shots", version: "1",
    tools: [
      defineTool({ tool: Shots, handler: () => Effect.die("unused"), view: { version: "1", render: () => "after the click", media: (result) => [result.after] } }),
      defineTool({ tool: Raw, handler: () => Effect.die("unused") }),
    ],
  })
  const views = Effect.runSync(Effect.gen(function* () {
    const registry = yield* makeRegistry(config, [capability])
    return registry.views
  }))
  const encoded = Effect.runSync(Effect.all({ before: mediaFromBase64(pixelPng), after: mediaFromBase64(pixelGif) }))

  test("the raw view shows the result with each image's data elided, and sends every image", () => {
    const view = Effect.runSync(views.view("raw_shots", encoded, {}, false))
    expect(view.text).not.toContain(pixelPng.slice(0, 30))
    expect(view.text).toContain(String(encoded.before.fingerprint))
    expect(view.media?.map((slot) => slot.path)).toEqual([["after"], ["before"]])
  })

  test("a view's selector picks the images it sends among the result's; a failed call sends none", () => {
    const view = Effect.runSync(views.view("shots", encoded, {}, false))
    expect([view.text, view.media?.map((slot) => slot.path)]).toEqual(["after the click", [["after"]]])
    expect(Effect.runSync(views.view("shots", encoded, {}, true)).media).toBeUndefined()
    expect(Effect.runSync(views.view("raw_shots", encoded, {}, true)).media).toBeUndefined()
  })
})

describe("a tool's own bound on what its result shows", () => {
  const text = (name: string) => Tool.make(name, { description: "Read a record.", parameters: Schema.Struct({}), success: Schema.String, failure: Failure, failureMode: "return" })
  const capability = defineCapability({
    id: "bounds", version: "1",
    tools: [
      defineTool({ tool: text("viewed"), handler: () => Effect.die("unused"), view: { version: "1", render: (result) => `record: ${result}` }, annotations: { boundOnWriteChars: 4_000 } }),
      defineTool({ tool: text("viewless"), handler: () => Effect.die("unused"), annotations: { boundOnWriteChars: 0 } }),
      defineTool({ tool: text("unbounded"), handler: () => Effect.die("unused"), view: { version: "1", render: (result) => result } }),
      defineTool({
        tool: Tool.make("structured", { description: "Read a record.", parameters: Schema.Struct({}), success: Schema.Struct({ id: Schema.String }), failure: Failure, failureMode: "return" }),
        handler: () => Effect.die("unused"), view: { version: "1", render: (result) => `record ${result.id}` }, annotations: { boundOnWriteChars: 2_000 },
      }),
    ],
  })
  const views = Effect.runSync(makeRegistry(config, [capability]).pipe(Effect.map((registry) => registry.views)))
  const viewOf = (tool: string, isError = false, encoded: unknown = "alpha") => Effect.runSync(views.view(tool, encoded, {}, isError))

  test("a view carries its tool's bound, for a tool with no view too", () => {
    expect(viewOf("viewed")).toEqual({ text: "record: alpha", version: "1", subjects: [], artifacts: [], pinned: false, boundOnWriteChars: 4_000 })
    expect(viewOf("viewless")).toEqual({ text: "alpha", version: "raw", subjects: [], artifacts: [], pinned: false, boundOnWriteChars: 0 })
    // A failed call's result is shown raw, under the same bound.
    expect(viewOf("viewed", true)).toEqual({ text: "alpha", version: "raw", subjects: [], artifacts: [], pinned: false, boundOnWriteChars: 4_000 })
    // A tool that sets none, and a tool the registry does not know, leave the key out: the memory strategy's bound applies.
    expect(viewOf("unbounded")).toEqual({ text: "alpha", version: "1", subjects: [], artifacts: [], pinned: false })
    expect(viewOf("unknown")).toEqual({ text: "alpha", version: "raw", subjects: [], artifacts: [], pinned: false })
  })

  test("a stored result that does not decode against its tool's schema is shown raw, under the tool's bound all the same", () => {
    expect(viewOf("structured", false, { id: "a" })).toEqual({ text: "record a", version: "1", subjects: [], artifacts: [], pinned: false, boundOnWriteChars: 2_000 })
    // The authored view cannot render this one: the raw view takes its place and carries the same bound.
    expect(viewOf("structured", false, "alpha")).toEqual({ text: "alpha", version: "raw", subjects: [], artifacts: [], pinned: false, boundOnWriteChars: 2_000 })
    expect(viewOf("structured", false, { id: 7 })).toEqual({ text: '{"id":7}', version: "raw", subjects: [], artifacts: [], pinned: false, boundOnWriteChars: 2_000 })
  })
})

describe("a tool's digest task", () => {
  const Search = Tool.make("search", {
    description: "Search records.",
    parameters: Schema.Struct({ query: Schema.String }),
    success: Schema.Struct({ ids: Schema.Array(Schema.String), text: Schema.String }),
    failure: Failure,
    failureMode: "return",
  })
  const capability = defineCapability({
    id: "search", version: "1",
    tools: [defineTool({
      tool: Search, handler: () => Effect.die("unused"),
      view: { version: "1", render: (result) => result.text, digest: { _tag: "Summarize", version: "1", instructions: "Summarize the matches.", preserve: (result) => result.ids } },
    })],
  })
  const views = Effect.runSync(makeRegistry(config, [capability]).pipe(Effect.map((registry) => registry.views)))

  test("a summarize task carries the identifiers its summary must keep, which the digester shows its model", () => {
    const found = Effect.runSync(views.digest("search", { ids: ["r-1", "r-2"], text: "r-1 and r-2 matched" }, { query: "r" }, new UserMessage({ text: "find r" })))
    expect(Option.map(found, (task) => [task.mode, task.preserve, task.source])).toEqual(Option.some(["summarize", ["r-1", "r-2"], "r-1 and r-2 matched"]))
    const task = Option.getOrThrow(found)
    expect(task.apply({ keep: [], summary: Option.some("r-1 matched") })).toEqual(Option.none())
    expect(task.apply({ keep: [], summary: Option.some("r-1 and r-2 matched") })).toEqual(Option.some("r-1 and r-2 matched"))
  })
})

describe("views decode detached copies of the stored input and result", () => {
  const counts = { params: 0, result: 0 }
  // Codecs that rewrite their input in place, as an authored codec may.
  const Lookup = Tool.make("lookup", {
    description: "Look a record up.",
    // `Schema.Unknown` hands the codec the nested object itself, not a decoded copy.
    parameters: Schema.Struct({ filter: Schema.Unknown }).pipe(Schema.decodeTo(Schema.Struct({ filter: Schema.Unknown }), {
      decode: SchemaGetter.transform((value) => { counts.params++; Reflect.set(Object(value.filter), "id", "codec-mutated"); return value }),
      encode: SchemaGetter.transform((value) => value),
    })),
    success: Schema.Struct({ record: Schema.Unknown }).pipe(Schema.decodeTo(Schema.Struct({ record: Schema.Unknown }), {
      decode: SchemaGetter.transform((value) => { counts.result++; Reflect.set(Object(value.record), "text", "codec-mutated"); return value }),
      encode: SchemaGetter.transform((value) => value),
    })),
    failure: Failure,
    failureMode: "return",
  })
  const capability = defineCapability({
    id: "lookup", version: "1",
    tools: [defineTool({
      tool: Lookup, handler: () => Effect.die("unused"),
      view: {
        version: "1", render: (result, params) => `${JSON.stringify(params.filter)}: ${JSON.stringify(result.record)}`, compact: (result) => JSON.stringify(result.record),
        digest: { _tag: "Summarize", version: "1", instructions: "Summarize the record.", preserve: () => [] },
      },
    })],
  })
  const views = Effect.runSync(makeRegistry(config, [capability]).pipe(Effect.map((registry) => registry.views)))

  test("the stored tool-call input and encoded result are unchanged by a view, a compaction or a digest, and the codecs see their own copies", () => {
    const params = { filter: { id: "stored" } }
    const encoded = { record: { text: "stored" } }
    const view = Effect.runSync(views.view("lookup", encoded, params, false))
    const compact = Effect.runSync(views.compact("lookup", encoded, params))
    Effect.runSync(views.digest("lookup", encoded, params, new UserMessage({ text: "find" })))
    expect([view.text, compact]).toEqual(['{"id":"codec-mutated"}: {"text":"codec-mutated"}', Option.some('{"text":"codec-mutated"}')])
    expect({ params, encoded }).toEqual({ params: { filter: { id: "stored" } }, encoded: { record: { text: "stored" } } })
    expect(counts).toEqual({ params: 3, result: 3 })
  })
})

describe("the catalogue section", () => {
  const filing = defineSkill({ id: "filing", summary: "File records.", tools: [], references: [{ id: "codes", title: "Filing codes", text: "..." }] })
  const lookup = defineSkill({ id: "lookup", summary: "Look records up.", tools: [], always: true })
  const archiving = defineSkill({
    id: "archiving", summary: "Archive records.", tools: [], always: true,
    references: [{ id: "retention", title: "Retention rules", text: "..." }, { id: "purge", title: "Purging", text: "..." }],
  })

  test("lists the loadable skills, and the references of the always-on skills that ship some, which no load_skill result lists", () => {
    expect(catalogText([filing, lookup])).toEqual(Option.some(
      "## Skills (call load_skill before doing work one covers; its tools become available next step)\n- filing: File records.",
    ))
    expect(catalogText([lookup, archiving])).toEqual(Option.some(
      "## References of always-on skills (their tools are already available; read one with read_skill_reference)\n- archiving: retention — Retention rules; purge — Purging",
    ))
    expect(catalogText([filing, lookup, archiving])).toEqual(Option.some([
      "## Skills (call load_skill before doing work one covers; its tools become available next step)\n- filing: File records.",
      "## References of always-on skills (their tools are already available; read one with read_skill_reference)\n- archiving: retention — Retention rules; purge — Purging",
    ].join("\n\n")))
    expect(catalogText([lookup])).toEqual(Option.none())
  })
})
