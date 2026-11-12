import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Option, Ref, Schema, Stream } from "effect"
import {
  assistantDeltaEvent,
  Core,
  definePlugin,
  estimateRequest,
  live,
  liveEvent,
  Memory,
  messageOf,
  originOf,
  requestSentEvent,
  Settings,
  stored,
  storedEvent,
  Tokens,
  userMessageEvent,
} from "@xandreed/core/kernel"
import { Agent, inMemoryStorage, sessions, stepLoop, windowMemory } from "./index.js"
import { Summaries } from "./testing.port.js"
import { answering, recording } from "./testing.js"

/*
 * The code `docs/kernel.md` shows, as tests that run. Each region between
 * `#region <name>` and `#endregion` is quoted there word for word, and the
 * last test of this file fails when the document and the source differ.
 */

describe("the kernel guide's code", () => {
  test("the boot code runs as written", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model, received } = yield* answering("Hello, ", "learner!")
      // #region boot
      const agent = yield* Agent.define({
        model,                                        // Effect AI's model layer
        system: "You are a friendly tutor.",
        storage: inMemoryStorage(),
        sessions: sessions(),
        memory: windowMemory({ budgetTokens: 3000 }),
        loop: stepLoop(),
        plugins: [],                                  // anything extra: telemetry, later tools, UI
      })

      const session = yield* agent.createSession({ owner: "learner" })
      const reply = yield* agent.send(session, "Hello")
      // #endregion boot
      return { reply, inspection: yield* agent.inspect(session), received: yield* received }
    })))
    expect(result.reply).toEqual({ text: "Hello, learner!" })
    expect(result.received).toEqual([[{ role: "system", text: "You are a friendly tutor." }, { role: "user", text: "Hello" }]])
    expect(result.inspection.events.map((event): string => event.name)).toEqual([
      "plugin.session.turn.started",
      "plugin.loop.user.message",
      "plugin.loop.request.sent",
      "plugin.loop.assistant.message",
      "plugin.session.turn.ended",
    ])
  })

  test("a host follows the answer as it streams", async () => {
    const pieces = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Hel", "lo!")
      const agent = yield* Agent.define({ model, system: "You are a friendly tutor.", storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }) })
      const session = yield* agent.createSession({ owner: "learner" })
      // #region follow
      const answer = yield* agent.events.pipe(
        Stream.filter((event) => event.name === assistantDeltaEvent.name),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),      // reading before the turn starts: the stream has no replay
      )
      yield* agent.send(session, "Hello")
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

      const meter = definePlugin({
        name: "meter",
        requires: [Core],
        make: Effect.gen(function* () {
          const core = yield* Core
          const requests = yield* Ref.make(0)
          // React to a fact the loop plugin stores, and publish one of its own about the same turn.
          yield* core.on(requestSentEvent, (sent) => Effect.flatMap(Ref.updateAndGet(requests, (count) => count + 1), (count) =>
            core.publish(live(requestCounted, originOf(sent), { requests: count, tokens: sent.data.estimatedTokens }))), { wait: true })
        }),
      })
      // #endregion own-event
      const record = yield* recording([requestCounted])
      const agent = yield* Agent.define({ model, system: "You are a friendly tutor.", storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }), plugins: [record.plugin, meter] })
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

  test("a memory plugin written in a few lines replaces the stock one, on the same session", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model, received } = yield* answering("Hi.")
      const agent = yield* Agent.define({ model, system: "You are a friendly tutor.", storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }) })
      const session = yield* agent.createSession({ owner: "learner" })
      yield* agent.send(session, "Hello")
      // #region memory-plugin
      /** A memory that sends the message the turn answers and nothing before it. */
      const goldfish = () => definePlugin({
        name: "goldfish",
        requires: [Settings],
        provides: Memory,
        make: Effect.gen(function* () {
          const settings = yield* Settings
          return Memory.of({
            open: (session) => Effect.succeed({
              build: () => Effect.map(session.journal, (journal) => {
                const asked = journal.filter((event) => event.name === userMessageEvent.name).slice(-1)
                return {
                  messages: asked.map((event) => event.seq),          // pointers into the journal, never copies
                  estimatedTokens: estimateRequest(settings.system, asked.flatMap((event) => Option.toArray(messageOf(event)))),
                  budgetTokens: Tokens.make(1000),
                }
              }),
            }),
          })
        }),
      })
      // #endregion memory-plugin
      // #region replace
      const next = yield* agent.with({ memory: goldfish() })
      const later = yield* next.send(session, "And now?")
      // #endregion replace
      return { later, received: yield* received }
    })))
    expect(result.later).toEqual({ text: "Hi." })
    expect(result.received[1]).toEqual([{ role: "system", text: "You are a friendly tutor." }, { role: "user", text: "And now?" }])
  })

  test("a plugin provides a contract of its own, and a memory that requires it is built after it", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model, received } = yield* answering("Hi.")
      // #region requires
      /** Provides `Summaries`. It needs no contract, and says so. */
      const summaries = () => definePlugin({
        name: "summaries",
        requires: [],
        provides: Summaries,
        make: Effect.succeed(Summaries.of({
          of: (messages) => Effect.succeed(`Earlier: ${messages.map((message) => message.text).join(" / ")}`),
        })),
      })

      const summarized = storedEvent("compress", "summarized", { data: Schema.Struct({ of: Schema.Int }), skippable: true })

      /** A memory that requires it: what was said before the turn's message reaches the model as one line. */
      const compress = () => definePlugin({
        name: "compress",
        requires: [Settings, Summaries],
        provides: Memory,
        make: Effect.gen(function* () {
          const settings  = yield* Settings
          const summaries = yield* Summaries                    // declared above; a contract that is not declared does not compile here
          return Memory.of({
            open: (session) => Effect.succeed({
              build: () => Effect.gen(function* () {
                const said = (yield* session.journal).filter((event) => event.message !== undefined && event.name !== summarized.name)
                const asked = said.slice(-1)
                const earlier = said.slice(0, -1)
                const request = (records: typeof said) => ({
                  messages: records.map((event) => event.seq),
                  estimatedTokens: estimateRequest(settings.system, records.flatMap((event) => Option.toArray(messageOf(event)))),
                  budgetTokens: Tokens.make(1000),
                })
                const [first, last] = [earlier[0], earlier.at(-1)]
                if (first === undefined || last === undefined) return request(asked)
                const text = yield* summaries.of(earlier.flatMap((event) => Option.toArray(messageOf(event))))
                const summary = yield* session.append(stored(summarized, { of: earlier.length }, {
                  message: { _tag: "User", text },
                  replaces: { from: first.seq, through: last.seq },
                }))
                return request([summary, ...asked])
              }),
            }),
          })
        }),
      })

      const agent = yield* Agent.define({
        model,
        system: "You are a friendly tutor.",
        storage: inMemoryStorage(),
        memory: compress(),                           // requires Summaries,
        plugins: [summaries()],                       // which an extra plugin provides: it is built before the memory
      })
      // #endregion requires
      const session = yield* agent.createSession({ owner: "learner" })
      yield* agent.send(session, "Hello")
      yield* agent.send(session, "And now?")
      // #region refused
      const refused = yield* Effect.flip(Agent.define({
        model,
        system: "You are a friendly tutor.",
        storage: inMemoryStorage(),
        memory: compress(),                           // nothing provides Summaries
      }))
      // #endregion refused
      return { received: yield* received, refused, names: (yield* agent.inspect(session)).events.map((event): string => event.name) }
    })))
    expect(result.received).toEqual([
      [{ role: "system", text: "You are a friendly tutor." }, { role: "user", text: "Hello" }],
      [{ role: "system", text: "You are a friendly tutor." }, { role: "user", text: "Earlier: Hello / Hi." }, { role: "user", text: "And now?" }],
    ])
    expect(result.names.filter((name) => name.startsWith("plugin.compress."))).toEqual(["plugin.compress.summarized"])
    expect(result.refused).toMatchObject({
      _tag: "PluginRefused",
      reason: "MissingProvider",
      plugin: "compress",
      contract: "@xandreed/sdk/kernel/testing/Summaries",
      message: "plugin compress requires @xandreed/sdk/kernel/testing/Summaries, which no plugin provides: add a plugin that provides it",
    })
  })
})

/*
 * The document quotes source; this pins the quotes. A marker
 * `<!-- pinned: <file>#<region> -->` is followed by a `ts` fence that holds,
 * after its imports, exactly the named region of the file; a marker with no
 * region is followed by text the file holds word for word.
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

  test("quotes the boot code, the loop's main function, the session plugin's two functions, the plugin examples and a plugin's own contract exactly as the source has them", async () => {
    const guide = await Bun.file(`${root}/docs/kernel.md`).text()
    const pins = Array.from(guide.matchAll(/<!-- pinned: ([^# ]+)(?:#([a-z-]+))? -->\n\n```ts\n([\s\S]*?)\n```/g))
    expect(pins.map((pin) => `${pin[1]}#${pin[2] ?? ""}`)).toEqual([
      "packages/sdk/src/kernel/guide.test.ts#boot",
      "packages/sdk/src/kernel/plugins/loop/step-loop.usecase.ts#",
      "packages/sdk/src/kernel/guide.test.ts#follow",
      "packages/sdk/src/kernel/guide.test.ts#own-event",
      "packages/sdk/src/kernel/plugins/session/sessions.adapter.ts#",
      "packages/sdk/src/kernel/plugins/session/sessions.adapter.ts#",
      "packages/sdk/src/kernel/guide.test.ts#replace",
      "packages/sdk/src/kernel/guide.test.ts#memory-plugin",
      "packages/sdk/src/kernel/testing.port.ts#contract",
      "packages/sdk/src/kernel/guide.test.ts#requires",
      "packages/sdk/src/kernel/guide.test.ts#refused",
    ])
    for (const [, file, region, block] of pins) {
      const source = await Bun.file(`${root}/${file}`).text()
      const quoted = withoutImports(block ?? "")
      expect(quoted).toBe((region === undefined ? quotedFrom(source, quoted) : regionOf(source, region)) ?? `${file} holds no such text`)
    }
  })

  test("names no stored event that the kernel does not write, and every one it does", async () => {
    const guide = await Bun.file(`${root}/docs/kernel.md`).text()
    const named = Array.from(new Set(Array.from(guide.matchAll(/`((?:plugin\.(?:session|loop|window)|core)\.[a-z.]+[a-z])`/g)).map((match) => match[1] ?? ""))).toSorted()
    expect(named).toEqual([
      "core.listener.failed",
      "plugin.loop.assistant.delta",
      "plugin.loop.assistant.message",
      "plugin.loop.request.sent",
      "plugin.loop.user.message",
      "plugin.session.turn.ended",
      "plugin.session.turn.started",
      "plugin.window.dropped",
      "plugin.window.pressure",
    ])
  })
})
