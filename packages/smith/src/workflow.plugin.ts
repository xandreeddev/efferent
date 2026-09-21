import { Context, Effect, Layer, Option, Schema } from "effect"
import { AgentLoop, Approval, DelegateLoop, definePlugin, FileSystem, HarnessError, SessionStore } from "@xandreed/core"
import type { Plugin } from "@xandreed/core"
import { agentLoopPlugin } from "@xandreed/plugin-agent-loop"
import { LocalFileSystemLive } from "@xandreed/plugin-tools-local"
import { Implementor, ImplementorError } from "@xandreed/foundry"
import { runForgeSessionWith } from "./forge/session.js"

/** Remap the replaceable worker service without changing the worker implementation. */
export const delegateLoopPlugin = (plugin: Plugin): Plugin => ({
  ...plugin, id: `${plugin.id}/delegate`, provides: plugin.provides.map((key) => key === AgentLoop.key ? DelegateLoop.key : key),
  build: (options, services) => plugin.build(options, services).pipe(Effect.map((context) => {
    const entries = [...context.unsafeMap].map(([key, value]) => [key === AgentLoop.key ? DelegateLoop.key : key, value] as const)
    return Context.unsafeMake<never>(new Map(entries))
  })),
})
export const smithWorkerPlugin = delegateLoopPlugin(agentLoopPlugin)
const Config = Schema.Struct({ mode: Schema.Literal("spec", "lock", "forge"), maxAttempts: Schema.Int.pipe(Schema.between(1, 10)), budgetMillis: Schema.Positive, testCommand: Schema.String, configPath: Schema.String })
const fail = (message: string) => Effect.fail(new HarnessError({ code: "workflow.invalid", message }))

export const smithWorkflowPlugin = definePlugin({
  id: "@xandreed/smith/workflow", version: "0.2.0-next.0", config: Config,
  defaults: { mode: "spec" as const, maxAttempts: 3, budgetMillis: 900000, testCommand: "", configPath: "" },
  requires: [DelegateLoop, SessionStore, Approval], provides: [AgentLoop],
  layer: (config) => Layer.effect(AgentLoop, Effect.gen(function* () {
    const worker = yield* DelegateLoop
    const sessions = yield* SessionStore
    const approval = yield* Approval
    const fs = yield* Layer.build(LocalFileSystemLive)
    return AgentLoop.of({ run: (input) => Effect.gen(function* () {
      if (config.mode === "spec") {
        const result = yield* worker.run({ ...input, system: `${input.system}\nDraft a concrete implementation specification. Include the objective, constraints, acceptance criteria, and verification steps. Inspect using read-only tools. Do not implement. The user will review the draft and explicitly lock it.` })
        if (result.outcome === "completed") yield* input.publish({ name: "spec.draft", runId: input.runId, data: { text: result.text } })
        return result
      }
      const history = yield* sessions.read(input.session.id, -1)
      const draft = history.filter((event) => event.name === "spec.draft").at(-1)
      if (config.mode === "lock") {
        if (typeof draft?.data.text !== "string" || draft.data.text.trim().length === 0) return yield* fail("Draft a specification with /spec before locking it.")
        yield* input.publish({ name: "spec.locked", runId: input.runId, data: { text: draft.data.text, draftId: draft.id } })
        return { text: "Specification locked. Use /forge to implement and verify it.", outcome: "completed" as const }
      }
      const locked = history.filter((event) => event.name === "spec.locked").at(-1)
      if (typeof locked?.data.text !== "string" || (draft !== undefined && locked.seq < draft.seq)) return yield* fail("Review the current specification and /lock it before forging.")
      const allowed = yield* approval.request("Run Foundry verification for the locked specification? Coding stays in the workspace sandbox. Foundry loads the workspace gate configuration and runs its verification commands on the host.")
      if (!allowed) return yield* fail("Forge cancelled before implementation: host verification was not approved.")
      const implementor = Layer.succeed(Implementor, { implement: ({ spec, attempt, feedback }) => worker.run({
        ...input, prompt: `${spec.goal}\n\n${Option.getOrElse(feedback, () => "Implement this locked specification, then run the relevant checks.")}`,
        publish: (event) => input.publish(event.name === "loop.event" ? { ...event, data: { ...event.data, turnIndex: Number(event.data.turnIndex ?? 0) + Number(attempt) * 10000 } } : event),
        transient: (event) => input.transient({ ...event, data: { ...event.data, turnIndex: Number(event.data.turnIndex ?? 0) + Number(attempt) * 10000 } }),
      }).pipe(Effect.mapError((error) => new ImplementorError({ attempt, message: error.message })), Effect.map(() => ({ filesTouched: [], ref: Option.some(`session:${input.session.id}`) }))) })
      const result = yield* runForgeSessionWith({
        task: locked.data.text, cwd: input.session.workspace, acceptance: [], maxAttempts: config.maxAttempts, budgetMillis: config.budgetMillis,
        models: { general: Option.none(), code: Option.none(), fast: Option.none() }, headless: true,
        testCommand: config.testCommand === "" ? Option.none() : Option.some(config.testCommand), noTest: false,
        configPath: config.configPath === "" ? Option.none() : Option.some(config.configPath), ship: false, sandbox: true,
      }, (event) => input.publish({ name: "workflow.event", runId: input.runId, data: { ...event } }).pipe(Effect.asVoid, Effect.orDie), implementor).pipe(
        Effect.provideService(FileSystem, Context.get(fs, FileSystem)), Effect.mapError((error) => new HarnessError({ code: "workflow.forge", message: String(error) })),
      )
      const accepted = result.run.outcome._tag === "accepted"
      return { text: `${accepted ? "Accepted" : "Not accepted"} by Foundry. Report: ${result.artifact}`, outcome: accepted ? "completed" as const : "partial" as const }
    }) })
  })),
})
