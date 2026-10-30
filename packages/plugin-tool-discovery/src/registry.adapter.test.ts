import { describe, expect, test } from "bun:test"
import { Tool } from "effect/ai"
import { Effect, Option, Schema } from "effect"
import { defineCapability, defineTool, Failure, Media, mediaFromBase64, UserMessage } from "@xandreed/core"
import { makeRegistry } from "./registry.adapter.js"
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
