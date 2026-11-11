import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LanguageModel } from "effect/ai"
import type { TurnEvent } from "@xandreed/sdk"
import { loadEcho } from "./models/mock.ts"
import { DEFAULT_CONFIG } from "./lesson1.source.ts"
import { LessonRuntime } from "./runtime.ts"
import { onRequest } from "./capture.ts"
import { DEFAULT_TINY } from "./tiny-memory.source.ts"

const build = async () => {
  const runtime = await LessonRuntime.create()
  runtime.setModel(loadEcho())
  return runtime
}

describe("lesson 1 runtime (the real framework, Echo model)", () => {
  test("the default config builds and one turn answers, with the loop's events", async () => {
    const runtime = await build()
    const built = await runtime.rebuild(DEFAULT_CONFIG)
    expect(built).toMatchObject({ ok: true })
    const events: TurnEvent[] = []
    const result = await runtime.send("tell me about loops", { onEvent: (event) => events.push(event) })
    expect(result.outcome).toBe("completed")
    expect(result.text).toContain("tell me about loops")
    const tags = events.map((event) => event._tag)
    expect(tags).toContain("step.started")
    expect(tags).toContain("assistant.delta")
    expect(tags).toContain("assistant.message")
    expect(tags).toContain("step.ended")
    await runtime.dispose()
  })

  test("a bad config is reported readably, not thrown", async () => {
    const runtime = await build()
    expect(await runtime.rebuild("{ plugins: [ ")).toMatchObject({ ok: false })
    const missing = await runtime.rebuild("{ plugins: [memoryWindowPlugin, stepLoopPlugin] }")
    expect(missing.ok).toBe(false)
    await runtime.dispose()
  })

  test("a conversation survives a rebuild, and the new system prompt reaches the model", async () => {
    const systems: string[] = []
    const stop = onRequest((request) => systems.push(request.messages[0]?.text ?? ""))
    const runtime = await build()
    await runtime.rebuild(DEFAULT_CONFIG)
    await runtime.send("first", { onEvent: () => {} })
    const rebuilt = await runtime.rebuild(DEFAULT_CONFIG.replace("friendly tutor", "pirate"))
    expect(rebuilt).toMatchObject({ ok: true })
    const second = await runtime.send("second", { onEvent: () => {} })
    stop()
    expect(systems[0]).toContain("friendly tutor")
    expect(systems[1]).toContain("pirate")
    expect(second.text).toContain("2 earlier messages")
    await runtime.dispose()
  })

  test("with loadSkill off the model is offered no tools", async () => {
    const offered: Array<ReadonlyArray<string>> = []
    const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
    const model = Effect.runSync(LanguageModel.make({
      generateText: (options) => Effect.sync(() => {
        offered.push(options.tools.map((tool) => tool.name))
        return [{ type: "text", text: "ok" }, { type: "finish", reason: "stop", usage }] as never
      }),
      streamText: () => { throw new Error("not streaming") },
    }))
    const runtime = await LessonRuntime.create()
    runtime.setModel({ ...loadEcho(), model })
    await runtime.rebuild(DEFAULT_CONFIG.replace("streaming: true", "streaming: false"))
    const result = await runtime.send("hi", { onEvent: () => {} })
    expect(result.text).toBe("ok")
    expect(offered).toEqual([[]])
    await runtime.dispose()
  })

  test("the learner's tiny memory plugin keeps the last turns for the model and everything in the journal", async () => {
    const shapes: string[] = []
    const stop = onRequest((request) => shapes.push(request.messages.map((m) => m.role[0]).join("")))
    const runtime = await build()
    await runtime.rebuild(DEFAULT_CONFIG)
    await runtime.send("warm up", { onEvent: () => {} })
    // Swapping the memory strategy starts a new conversation.
    const swapped = await runtime.rebuild(DEFAULT_CONFIG.replace("memoryWindowPlugin,", "tinyMemory(2),"), DEFAULT_TINY)
    expect(swapped).toMatchObject({ ok: true, restarted: true })
    shapes.length = 0
    for (const text of ["one", "two", "three", "four", "five"]) await runtime.send(text, { onEvent: () => {} })
    stop()
    // system, then a ledger note for dropped turns (u), the one earlier turn kept (u a), and the new message (u).
    expect(shapes).toEqual(["su", "suau", "suuau", "suuau", "suuau"])
    const { events, report } = await runtime.inspect()
    const drops = events.filter((event) => event.kind === "memory.compaction")
    expect(drops.length).toBe(3)
    expect(report.turns.map((turn) => turn.drops)).toEqual([0, 0, 1, 1, 1])
    // The journal still holds every message of the conversation.
    expect(events.filter((event) => event.kind === "memory.message").length).toBe(5)
    await runtime.dispose()
  }, 30000)

  test("a broken tiny plugin is reported by file, only when the config uses it", async () => {
    const runtime = await build()
    expect(await runtime.rebuild(DEFAULT_CONFIG, "this is not (valid")).toMatchObject({ ok: true })
    const used = await runtime.rebuild(DEFAULT_CONFIG.replace("memoryWindowPlugin,", "tinyMemory(2),"), "this is not (valid")
    expect(used.ok).toBe(false)
    expect(used.ok === false && used.message).toContain("tiny-memory.ts")
    await runtime.dispose()
  })
})
