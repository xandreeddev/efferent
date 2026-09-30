import { sessionsPlugin } from "@xandreed/plugin-sessions"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Layer, Option, Schema } from "effect"
import { AgentLoop, ConversationStore, definePlugin, makeSession, SessionLog, SessionStore, SessionEnvironment } from "@xandreed/core"
import { ConversationStoreProjectionLive, sessionSqlitePlugin } from "@xandreed/plugin-session-sqlite"
import { Harness } from "./harness.js"
import { domainLoop, domainSession } from "./domain-session.adapter.js"

type Event = { readonly type: "done"; readonly text: string } | { readonly type: "error"; readonly message: string }
describe("domain session bridge", () => {
  test("persists domain events and contains a domain failure without waiting forever", async () => {
    const directory = mkdtempSync(join(tmpdir(), "efferent-domain-"))
    const plugin = definePlugin({ id: "test/domain", version: "1", config: Schema.Struct({}), defaults: {}, requires: [SessionStore, SessionEnvironment], provides: [AgentLoop], layer: () => Layer.effect(AgentLoop, domainLoop({
      create: (conversationId) => makeSession<Event>({ conversationId, onError: (message) => ({ type: "error", message }), runTurn: (text, publish) => text === "fail" ? Effect.fail("domain failure") : publish({ type: "done", text }) }),
      result: (event) => event.type === "done" ? Option.some({ text: event.text, outcome: "completed" }) : Option.none(),
    })) })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, config: { version: 1, plugins: [{ id: "store", use: sessionSqlitePlugin.id, options: { path: join(directory, "sessions.db") } }, { id: "session-service", use: sessionsPlugin.id, options: { ownership: { mode: "process" } } }, { id: "loop", use: plugin.id }] }, plugins: [sessionSqlitePlugin, sessionsPlugin, plugin] })
      const handle = yield* harness.create()
      yield* handle.send("hello")
      const view = domainSession<Event>(handle, (value) => Option.some(value as Event), (message) => ({ type: "error", message }))
      expect((yield* view.state).log.map((entry) => entry.event.type)).toEqual(["done"])
      expect((yield* Effect.result(handle.send("fail")))._tag).toBe("Failure")
      expect(yield* handle.busy).toBe(false)
      expect((yield* handle.history).at(-1)?.name).toBe("run.failed")
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))))
  })

  test("a domain session's conversation write after its harness run is refused, not recorded beside the closed turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "efferent-domain-"))
    const later = Effect.runSync(Deferred.make<void>())
    const lateWrite = Effect.runSync(Deferred.make<Exit.Exit<number, unknown>>())
    const conversations = definePlugin({ id: "test/conversations", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, requires: [SessionLog], provides: [ConversationStore], layer: () => ConversationStoreProjectionLive() })
    const plugin = definePlugin({ id: "test/writing-domain", version: "1", config: Schema.Struct({}), defaults: {}, requires: [SessionStore, SessionEnvironment, ConversationStore], provides: [AgentLoop], layer: () => Layer.effect(AgentLoop, domainLoop({
      create: (conversationId) => makeSession<Event, ConversationStore>({ conversationId, onError: (message) => ({ type: "error", message }), runTurn: (text, publish) => Effect.gen(function* () {
        const store = yield* ConversationStore
        yield* store.append(conversationId, { role: "user", content: text })
        // Work the domain session left running writes after the run is over.
        yield* Effect.forkDetach(Deferred.await(later).pipe(Effect.andThen(Effect.exit(store.append(conversationId, { role: "user", content: "late" }))), Effect.flatMap((exit) => Deferred.succeed(lateWrite, exit))))
        yield* publish({ type: "done", text })
      }) }),
      result: (event) => event.type === "done" ? Option.some({ text: event.text, outcome: "completed" }) : Option.none(),
    })) })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, config: { version: 1, plugins: [{ id: "store", use: sessionSqlitePlugin.id, options: { path: join(directory, "sessions.db") } }, { id: "session-service", use: sessionsPlugin.id, options: { ownership: { mode: "process" } } }, { id: "conversations", use: conversations.id }, { id: "loop", use: plugin.id }] }, plugins: [sessionSqlitePlugin, sessionsPlugin, conversations, plugin] })
      const handle = yield* harness.create()
      yield* handle.send("hello")
      yield* Deferred.succeed(later, undefined)
      const late = yield* Deferred.await(lateWrite)
      expect(Exit.isFailure(late) ? String(late.cause) : "recorded").toContain("turn is over")
      expect((yield* handle.use(ConversationStore, (store) => store.list(handle.record.id))).map((message) => message.role === "user" ? message.content : "")).toEqual(["hello"])
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))))
  })
})
