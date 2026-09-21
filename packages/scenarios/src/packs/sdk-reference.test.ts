import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LanguageModel } from "@effect/ai"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { AgentLoop, ConversationStore, definePlugin } from "@xandreed/core"
import { Harness } from "@xandreed/sdk"
import { mathAgent } from "@xandreed/math"
import { canvasAgent } from "@xandreed/canvas"
import { socialAgent } from "@xandreed/social"

const finish = (reason: string) => ({ type: "finish", reason, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
describe("reference applications on the SDK", () => {
  test("all three presets activate their configurable service graphs without model calls", async () => {
    await Promise.all([mathAgent, canvasAgent, socialAgent].map(async (preset) => {
      const directory = mkdtempSync(join(tmpdir(), "efferent-reference-"))
      const agent = preset(directory)
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const harness = yield* Harness.make({ workspace: directory, config: agent.config, plugins: agent.plugins })
        const session = yield* harness.create()
        expect(yield* session.use(AgentLoop, (loop) => Effect.succeed(typeof loop.run))).toBe("function")
      })).pipe(Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))))
    }))
  })
  test("Math renders an admitted exercise through an external model plugin and durable session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "efferent-math-sdk-"))
    const model = definePlugin({ id: "test/tutor", version: "1", config: Schema.Struct({}), defaults: {}, provides: [LanguageModel.LanguageModel], layer: () => Layer.effect(LanguageModel.LanguageModel, Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      return yield* LanguageModel.make({ generateText: () => Ref.getAndUpdate(calls, (n) => n + 1).pipe(Effect.map((call) => (call === 0 ? [
        { type: "tool-call", id: "math1", name: "render_math", params: { items: [{ kind: "exercise", id: "one", prompt: "What is 2 + 2?", answer: { kind: "integer", value: "4" }, hint: "Count two more.", solution: [{ text: "2 + 2 = 4" }] }] } }, finish("tool-calls"),
      ] : [{ type: "text", text: "Exercise ready." }, finish("stop")]) as never)), streamText: () => Stream.die("not used") as never })
    })) })
    const preset = mathAgent(directory)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, plugins: [...preset.plugins, model], config: { ...preset.config, plugins: preset.config.plugins.map((entry) => entry.id === "models" ? { id: "models", use: model.id } : entry) } })
      const session = yield* harness.create()
      yield* session.send("Give me a practice exercise")
      const events = yield* session.history
      expect(events.some((event) => event.name === "domain.event" && typeof event.data.event === "object" && event.data.event !== null && "type" in event.data.event && event.data.event.type === "math_render")).toBe(true)
      expect(events.at(-1)?.name).toBe("run.completed")
      const fork = yield* harness.fork(session.record.id, events.at(-1)!.seq)
      expect((yield* fork.use(ConversationStore, (store) => store.list(fork.record.id))).length).toBeGreaterThan(0)
      yield* fork.send("Give me another")
      const renderCount = (trail: typeof events) => trail.filter((event) => event.name === "domain.event" && typeof event.data.event === "object" && event.data.event !== null && "type" in event.data.event && event.data.event.type === "math_render").length
      expect(renderCount(yield* fork.history)).toBe(renderCount(events))
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))))
  })
})
