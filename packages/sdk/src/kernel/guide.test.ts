import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import {
  assistantDeltaEvent,
  Core,
  estimateRequest,
  live,
  liveEvent,
  Memory,
  messageOf,
  originOf,
  requestSentEvent,
  Settings,
  Tokens,
  userMessageEvent,
} from "@xandreed/core/kernel"
import { answering, open, recording, stack } from "./testing.js"

/*
 * The code `docs/kernel.md` shows, as tests that run. Each region between
 * `#region <name>` and `#endregion` is quoted there word for word, and the
 * tests at the end of this file fail when the document and the source differ.
 */

describe("the kernel guide's code", () => {
  test("a host follows the answer as it streams", async () => {
    const pieces = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Hel", "lo!")
      const { core, loop, createSession } = yield* open(stack(model))
      const session = yield* createSession({ owner: "learner" })
      // #region follow
      const answer = yield* core.events.pipe(
        Stream.filter((event) => event.name === assistantDeltaEvent.name),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),      // reading before the turn starts: the stream has no replay
      )
      yield* loop.run({ session, message: "Hello" })
      const shown = yield* Fiber.join(answer)
      // #endregion follow
      return shown.map((event) => event.data)
    })))
    expect(pieces).toEqual([{ text: "Hel" }, { text: "lo!" }])
  })

  test("a plugin defines an event of its own, and another reacts to it", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Hi.")
      // #region own-event
      // An event of the plugin's own, defined in the plugin's folder: its name, the schema of its data, live or stored.
      const requestCounted = liveEvent("meter", "request.counted", { data: Schema.Struct({ requests: Schema.Int, tokens: Tokens }) })

      // A plugin that provides no contract and only listens: a layer that registers its listener in its own scope.
      const meter = Layer.effectDiscard(Effect.gen(function* () {
        const core = yield* Core
        const requests = yield* Ref.make(0)
        // React to a fact the loop plugin stores, and publish one of its own about the same turn.
        yield* core.on(requestSentEvent, (sent) => Effect.flatMap(Ref.updateAndGet(requests, (count) => count + 1), (count) =>
          core.publish(live(requestCounted, originOf(sent), { requests: count, tokens: sent.data.estimatedTokens }))), { name: "meter", wait: true })
      }))
      // #endregion own-event
      const record = yield* recording([requestCounted])
      const agent = yield* open(stack(model, { extras: Layer.provideMerge(meter, record.layer) }))
      const session = yield* agent.createSession({ owner: "learner" })
      yield* agent.send(session, "Hello")
      yield* agent.send(session, "Again")
      return yield* record.seen
    })))
    expect(result.map((event) => [event.name, event.turn, event.data])).toEqual([
      ["plugin.meter.request.counted", 1, { requests: 1, tokens: 9 }],
      ["plugin.meter.request.counted", 2, { requests: 2, tokens: 12 }],
    ])
  })

  test("a memory plugin written in a few lines runs in place of the stock one", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model, received } = yield* answering("Hi.")
      // #region memory-plugin
      /** A memory that sends the message the turn answers and nothing before it. */
      const goldfish = () => Layer.effect(Memory, Effect.gen(function* () {
        const settings = yield* Settings
        return Memory.of({
          build: (session) => Effect.map(session.journal, (journal) => {
            const asked = journal.filter((event) => event.name === userMessageEvent.name).slice(-1)
            return {
              messages: asked.map((event) => event.seq),          // pointers into the journal, never copies
              estimatedTokens: estimateRequest(settings.system, asked.flatMap((event) => Option.toArray(messageOf(event)))),
              budgetTokens: Tokens.make(1000),
            }
          }),
        })
      }))
      // #endregion memory-plugin
      const agent = yield* open(stack(model, { memory: goldfish() }))
      const session = yield* agent.createSession({ owner: "learner" })
      yield* agent.send(session, "Hello")
      const later = yield* agent.send(session, "And now?")
      return { later, received: yield* received }
    })))
    expect(result.later).toEqual({ text: "Hi." })
    expect(result.received[1]).toEqual([{ role: "system", text: "You are a friendly tutor." }, { role: "user", text: "And now?" }])
  })
})

/*
 * The document quotes source; this pins the quotes. A marker
 * `<!-- pinned: <file>#<region> -->` is followed by a `ts` fence that holds,
 * after its imports, exactly the named region of the file; a marker with no
 * region is followed by text the file holds word for word. Every fence of
 * the document is pinned.
 */
describe("docs/kernel.md", () => {
  const root = `${import.meta.dir}/../../../..`
  const dedent = (lines: ReadonlyArray<string>) => {
    const indent = Math.min(...lines.filter((line) => line.trim().length > 0).map((line) => line.length - line.trimStart().length))
    return lines.map((line) => line.slice(indent)).join("\n")
  }
  const regionOf = (source: string, region: string) => {
    const lines = source.split("\n")
    const start = lines.findIndex((line) => line.trim() === `// #region ${region}`)
    const end = lines.findIndex((line) => line.trim() === `// #endregion ${region}`)
    return start < 0 || end < start ? undefined : dedent(lines.slice(start + 1, end))
  }
  /** A quoted block without the imports the document adds above it. */
  const withoutImports = (block: string) => block.replace(/^(?:import [^\n]*\n)+\n/, "")
  /** The lines of the source a block quotes: from the line its first line matches, as many lines as it has, without their common indent. */
  const quotedFrom = (source: string, block: string) => {
    const lines = source.split("\n")
    const quoted = block.split("\n")
    const start = lines.findIndex((line) => line.trim() === quoted[0]?.trim())
    return start < 0 ? undefined : dedent(lines.slice(start, start + quoted.length))
  }

  test("quotes the window memory, the host's stack, the loop's main function, the session plugin's two functions, the queue example, the plugin examples and the shared base exactly as the source has them, and every fence is pinned", async () => {
    const guide = await Bun.file(`${root}/docs/kernel.md`).text()
    const pins = Array.from(guide.matchAll(/<!-- pinned: ([^# ]+)(?:#([a-z-]+))? -->\n\n```ts\n([\s\S]*?)\n```/g))
    expect(pins.map((pin) => `${pin[1]}#${pin[2] ?? ""}`)).toEqual([
      "packages/sdk/src/kernel/plugins/memory-window/window.adapter.ts#",
      "packages/sdk/src/kernel/lesson.test.ts#agent",
      "packages/sdk/src/kernel/plugins/loop/step-loop.usecase.ts#",
      "packages/sdk/src/kernel/guide.test.ts#follow",
      "packages/sdk/src/kernel/guide.test.ts#own-event",
      "packages/sdk/src/kernel/plugins/session/sessions.adapter.ts#",
      "packages/sdk/src/kernel/plugins/session/sessions.adapter.ts#",
      "packages/sdk/src/kernel/plugins/inbox/inbox.port.ts#",
      "packages/sdk/src/kernel/lesson.test.ts#program",
      "packages/sdk/src/kernel/guide.test.ts#memory-plugin",
      "packages/sdk/src/kernel/swap.test.ts#swap",
    ])
    // Every fence of the document is one of the pinned quotes: two fence lines each.
    expect(Array.from(guide.matchAll(/^```/gm)).length).toBe(pins.length * 2)
    for (const [, file, region, block] of pins) {
      const source = await Bun.file(`${root}/${file}`).text()
      const quoted = withoutImports(block ?? "")
      expect(quoted).toBe((region === undefined ? quotedFrom(source, quoted) : regionOf(source, region)) ?? `${file} holds no such text`)
    }
  })

  test("names no stored event that the kernel does not write, and every one it does", async () => {
    const guide = await Bun.file(`${root}/docs/kernel.md`).text()
    const named = Array.from(new Set(Array.from(guide.matchAll(/`((?:plugin\.(?:loop|window|inbox)|core)\.[a-z.]+[a-z])`/g)).map((match) => match[1] ?? ""))).toSorted()
    expect(named).toEqual([
      "core.listener.failed",
      "core.session.turn.ended",
      "core.session.turn.started",
      "plugin.inbox.queued",
      "plugin.loop.assistant.delta",
      "plugin.loop.assistant.message",
      "plugin.loop.request.sent",
      "plugin.loop.user.message",
      "plugin.window.dropped",
      "plugin.window.pressure",
    ])
  })
})
