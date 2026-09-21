import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { DelegateLoop, definePlugin } from "@xandreed/core"
import type { HarnessConfig } from "@xandreed/core"
import { approvalPlugin, Harness } from "@xandreed/sdk"
import { sessionSqlitePlugin } from "@xandreed/plugin-session-sqlite"
import { smithWorkflowPlugin } from "./workflow.plugin.js"

describe("composable Smith workflows", () => {
  test("a configured worker repairs a gate failure and journals Foundry acceptance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "efferent-workflow-forge-"))
    const attempts: string[] = []
    const worker = definePlugin({ id: "test/repair-worker", version: "1", config: Schema.Struct({}), defaults: {}, provides: [DelegateLoop], layer: () => Layer.succeed(DelegateLoop, {
      run: (input) => Effect.sync(() => {
        if (input.system.includes("Draft a concrete implementation specification")) return { text: "Write result.txt containing accepted", outcome: "completed" as const }
        attempts.push(input.prompt)
        writeFileSync(join(directory, "result.txt"), attempts.length === 1 ? "rejected" : "accepted")
        return { text: "Implemented", outcome: "completed" as const }
      }),
    }) })
    const config = (mode: "spec" | "lock" | "forge"): HarnessConfig => ({ version: 1, plugins: [
      { id: "sessions", use: sessionSqlitePlugin.id, options: { path: join(directory, ".efferent/runtime/sessions.db") } },
      { id: "approval", use: "efferent/approval-host" }, { id: "worker", use: worker.id },
      { id: "workflow", use: smithWorkflowPlugin.id, options: { mode, testCommand: "grep -qx accepted result.txt" } },
    ] })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, config: config("spec"), plugins: [sessionSqlitePlugin, approvalPlugin(() => Effect.succeed(true)), worker, smithWorkflowPlugin] })
      const session = yield* harness.create()
      yield* session.send("make the result")
      yield* harness.reconfigure(config("lock"))
      yield* session.send("lock")
      yield* harness.reconfigure(config("forge"))
      yield* session.send("forge")
      const history = yield* session.history
      const completion = history.filter((event) => event.name === "run.completed").at(-1)
      const report = history.find((event) => event.name === "workflow.event" && event.data.type === "forge_end")
      expect(completion?.data.text).toContain("Accepted by Foundry")
      expect(attempts).toHaveLength(2)
      expect(attempts[1]).toContain("test/test-cmd")
      expect(readFileSync(join(directory, "result.txt"), "utf8")).toBe("accepted")
      expect(typeof report?.data.artifact === "string" && existsSync(report.data.artifact)).toBe(true)
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))))
  })

  test("drafts and locks persist; stale or unapproved specs cannot start implementation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "efferent-workflow-"))
    const calls: string[] = []
    const worker = definePlugin({ id: "test/worker", version: "1", config: Schema.Struct({}), defaults: {}, provides: [DelegateLoop], layer: () => Layer.succeed(DelegateLoop, {
      run: (input) => Effect.sync(() => { calls.push(input.prompt); return { text: `Specification for ${input.prompt}`, outcome: "completed" as const } }),
    }) })
    const config = (mode: "spec" | "lock" | "forge"): HarnessConfig => ({ version: 1, plugins: [
      { id: "sessions", use: sessionSqlitePlugin.id, options: { path: join(directory, "sessions.db") } },
      { id: "approval", use: "efferent/approval-host" }, { id: "worker", use: worker.id },
      { id: "workflow", use: smithWorkflowPlugin.id, options: { mode } },
    ] })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, config: config("spec"), plugins: [sessionSqlitePlugin, approvalPlugin(), worker, smithWorkflowPlugin] })
      const session = yield* harness.create()
      yield* session.send("a tested feature")
      yield* harness.reconfigure(config("lock"))
      yield* session.send("lock")
      expect((yield* session.history).filter((event) => event.name === "spec.locked")).toHaveLength(1)
      yield* harness.reconfigure(config("spec"))
      yield* session.send("a revised feature")
      yield* harness.reconfigure(config("forge"))
      expect((yield* Effect.either(session.send("forge")))._tag).toBe("Left")
      yield* harness.reconfigure(config("lock"))
      yield* session.send("lock revision")
      yield* harness.reconfigure(config("forge"))
      expect((yield* Effect.either(session.send("forge")))._tag).toBe("Left")
      expect(calls).toEqual(["a tested feature", "a revised feature"])
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))))
  })
})
