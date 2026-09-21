import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { AgentLoop, definePlugin, makeSession, SessionStore, SessionEnvironment } from "@xandreed/core"
import { sessionSqlitePlugin } from "@xandreed/plugin-session-sqlite"
import { Harness } from "./harness.js"
import { domainLoop, domainSession } from "./domain-session.adapter.js"

type Event = { readonly type: "done"; readonly text: string } | { readonly type: "error"; readonly message: string }
describe("domain session bridge", () => {
  test("persists domain events and contains a domain failure without waiting forever", async () => {
    const directory = mkdtempSync(join(tmpdir(), "efferent-domain-"))
    const plugin = definePlugin({ id: "test/domain", version: "1", config: Schema.Struct({}), defaults: {}, requires: [SessionStore, SessionEnvironment], provides: [AgentLoop], layer: () => Layer.scoped(AgentLoop, domainLoop({
      create: (conversationId) => makeSession<Event>({ conversationId, onError: (message) => ({ type: "error", message }), runTurn: (text, publish) => text === "fail" ? Effect.fail("domain failure") : publish({ type: "done", text }) }),
      result: (event) => event.type === "done" ? Option.some({ text: event.text, outcome: "completed" }) : Option.none(),
    })) })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, config: { version: 1, plugins: [{ id: "store", use: sessionSqlitePlugin.id, options: { path: join(directory, "sessions.db") } }, { id: "loop", use: plugin.id }] }, plugins: [sessionSqlitePlugin, plugin] })
      const handle = yield* harness.create()
      yield* handle.send("hello")
      const view = domainSession<Event>(handle, (value) => Option.some(value as Event), (message) => ({ type: "error", message }))
      expect((yield* view.state).log.map((entry) => entry.event.type)).toEqual(["done"])
      expect((yield* Effect.either(handle.send("fail")))._tag).toBe("Left")
      expect(yield* handle.busy).toBe(false)
      expect((yield* handle.history).at(-1)?.name).toBe("run.failed")
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))))
  })
})
