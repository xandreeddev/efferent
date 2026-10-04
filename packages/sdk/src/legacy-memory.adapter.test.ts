import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { ActiveTurnWriter, AgentLoop, definePlugin, HarnessError } from "@xandreed/core"
import type { SessionLogEvent } from "@xandreed/core"
import { sessionSqlitePlugin } from "@xandreed/plugin-session-sqlite"
import { sessionsPlugin } from "@xandreed/plugin-sessions"
import { Harness } from "./harness.js"

describe("legacy memory over native writers", () => {
  test("empty kind filters retain native history and snapshots alongside read-only legacy projections", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "sdk-legacy-all-kinds-"))
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const observed = yield* Ref.make({ history: [] as ReadonlyArray<SessionLogEvent>, snapshot: [] as ReadonlyArray<SessionLogEvent>, after: [] as ReadonlyArray<SessionLogEvent>, host: [] as ReadonlyArray<SessionLogEvent>, combined: [] as ReadonlyArray<SessionLogEvent> })
      const loop = definePlugin({ id: "test/all-kinds-loop", version: "1", config: Schema.Struct({}), defaults: {}, provides: [AgentLoop], layer: () => Layer.succeed(AgentLoop, { run: (input) => Effect.gen(function* () {
        const { writer } = yield* Option.match(Context.getOption(input.services, ActiveTurnWriter), { onNone: () => Effect.fail(new HarnessError({ code: "test.writer", message: "Active writer missing" })), onSome: Effect.succeed })
        yield* writer.append([{ kind: "smith.phase", data: { text: input.userMessage.text } }])
        if (input.userMessage.text === "seed") {
          yield* input.publish({ name: "fact", runId: input.runId, data: { text: "Historical host fact" } })
          yield* input.publish({ name: "messages", runId: input.runId, data: { messages: [{ role: "assistant", content: [{ type: "text", text: "Historical assistant fact" }] }] } })
        }
        yield* writer.flush
        if (input.userMessage.text === "inspect") yield* Ref.set(observed, { history: yield* writer.history([]), snapshot: yield* writer.snapshot([]), after: yield* writer.snapshot([], writer.started.seq), host: yield* writer.history(["harness.event"]), combined: yield* writer.history(["harness.event", "memory.message"]) })
        return { text: "done", outcome: "completed" as const }
      }) }) })
      const harness = yield* Harness.make({ workspace, plugins: [sessionSqlitePlugin, sessionsPlugin, loop], config: { version: 1, plugins: [
        { id: "store", use: sessionSqlitePlugin.id, options: { path: join(workspace, "sessions.db") } },
        { id: "session-service", use: sessionsPlugin.id, options: { ownership: { mode: "process" } } },
        { id: "loop", use: loop.id },
      ] } })
      const session = yield* harness.create()
      yield* session.send("seed")
      yield* session.send("inspect")
      const reads = yield* Ref.get(observed)
      expect(reads.history.filter((event) => event.kind === "smith.phase").map((event) => event.data.text)).toEqual(["seed"])
      expect(reads.history.filter((event) => event.kind === "turn.started")).toHaveLength(1)
      expect(reads.snapshot.filter((event) => event.kind === "smith.phase").map((event) => event.data.text)).toEqual(["seed", "inspect"])
      expect(reads.snapshot.filter((event) => event.kind === "turn.started")).toHaveLength(2)
      expect(reads.after.filter((event) => event.kind === "smith.phase").map((event) => event.data.text)).toEqual(["inspect"])
      expect(JSON.stringify(reads.history)).toContain("Historical host fact")
      expect(reads.history.filter((event) => event.kind === "memory.message")).toHaveLength(1)
      expect(JSON.stringify(reads.history.filter((event) => event.kind === "memory.message"))).toContain("Historical assistant fact")
      expect(reads.host.every((event) => event.kind === "harness.event")).toBe(true)
      expect(reads.host.filter((event) => JSON.stringify(event.data.event).includes('"name":"messages"'))).toHaveLength(1)
      expect(reads.combined.filter((event) => event.kind === "harness.event").map((event) => event.seq)).toEqual(reads.host.map((event) => event.seq))
      expect(reads.combined.filter((event) => event.kind === "memory.message")).toHaveLength(1)
      expect((yield* session.journalHistory).filter((event) => event.kind === "memory.message")).toHaveLength(0)
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })
})
