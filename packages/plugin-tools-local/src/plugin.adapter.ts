import { dirname, relative, resolve } from "node:path"
import { Tool, Toolkit } from "@effect/ai"
import { Context, Effect, Layer, Schema } from "effect"
import { ActionPolicy, AgentTools, buildMcpBridge, definePlugin, Failure, FileSystem, Memory, McpClient, SessionEnvironment, Shell, ShellResult } from "@xandreed/core"
import { makeSmithCodingHandlers, smithCodingToolkit } from "./coding/codingToolkit.js"
import { discoverSkills, renderSkillsBlock } from "./skills/skills.js"
import { LocalFileSystemLive } from "./fs/localFs.js"
import { LocalShellLive } from "./shell/localShell.js"
import { SandboxedShellLive } from "./shell/sandboxedShell.js"

const Remember = Tool.make("remember", { description: "Save a useful workspace fact for future sessions. Store facts, not instructions or secrets.", parameters: { text: Schema.String }, success: Schema.String, failure: Failure, failureMode: "return" })
const Recall = Tool.make("recall", { description: "Search persistent workspace memory.", parameters: { query: Schema.String }, success: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })), failure: Failure, failureMode: "return" })
const Forget = Tool.make("forget", { description: "Remove an obsolete workspace memory by its id.", parameters: { id: Schema.String }, success: Schema.Boolean, failure: Failure, failureMode: "return" })
const External = Tool.make("external_command", { description: "Request human approval to run a command outside the workspace sandbox. Use for publishing, network access, or operations requiring host credentials. The complete command is shown before execution.", parameters: { command: Schema.String }, success: ShellResult, failure: Failure, failureMode: "return" })
const extraToolkit = Toolkit.make(Remember, Recall, Forget, External)
const asFailure = (error: { readonly message: string }) => ({ error: "ToolFailure", message: error.message })

export const toolsLocalPlugin = definePlugin({
  id: "@xandreed/plugin-tools-local", version: "0.4.0", config: Schema.Struct({ readOnly: Schema.Boolean }), defaults: { readOnly: false },
  requires: [SessionEnvironment, ActionPolicy, Memory, McpClient], provides: [AgentTools],
  layer: ({ readOnly }) => Layer.effect(AgentTools, Effect.gen(function* () {
    const { workspace } = yield* SessionEnvironment
    const policy = yield* ActionPolicy
    const memory = yield* Memory
    const fs = yield* Layer.build(LocalFileSystemLive)
    const shell = yield* Layer.build(SandboxedShellLive(workspace, { network: false }))
    const local = yield* Layer.build(LocalShellLive)
    const io = Context.merge(fs, shell)
    const base = yield* makeSmithCodingHandlers(workspace).pipe(Effect.provide(io))
    const guarded = Object.fromEntries(Object.keys(base).map((name) => [name, (input: unknown) =>
      policy.authorize(name, input).pipe(Effect.mapError(asFailure), Effect.zipRight(Effect.suspend(() => {
        const args = input !== null && typeof input === "object" ? input as Record<string, unknown> : {}
        const value = typeof args.path === "string" ? args.path : typeof args.dir === "string" ? args.dir : "."
        const target = resolve(workspace, value)
        const localPath = relative(workspace, target)
        const outside = localPath === ".." || localPath.startsWith("../")
        const selected = outside ? makeSmithCodingHandlers(["ls", "grep", "glob"].includes(name) ? target : dirname(target)).pipe(Effect.provide(io)) : Effect.succeed(base)
        return selected.pipe(Effect.flatMap((handlers) => {
          const selectedHandler: (value: never) => Effect.Effect<unknown, { readonly error: string; readonly message: string }> = handlers[name as keyof typeof handlers]
          const normalized = outside ? { ...args, ...(typeof args.path === "string" ? { path: target } : { dir: target }) } : input
          return selectedHandler(normalized as never)
        }))
      }))),
    ]))
    const baseHandlers = yield* smithCodingToolkit.toContext(guarded as Parameters<typeof smithCodingToolkit.toContext>[0])
    const extraHandlers = yield* extraToolkit.toContext({
      remember: ({ text }) => memory.remember(workspace, text).pipe(Effect.map((entry) => entry.id), Effect.mapError(asFailure)),
      recall: ({ query }) => memory.recall(workspace, query).pipe(Effect.mapError(asFailure)),
      forget: ({ id }) => memory.forget(workspace, id).pipe(Effect.as(true), Effect.mapError(asFailure)),
      external_command: ({ command }) => policy.authorize("external_command", { command }).pipe(Effect.zipRight(Context.get(local, Shell).exec(command, { cwd: workspace })), Effect.mapError(asFailure)),
    })
    const mcp = yield* buildMcpBridge
    const combined = Toolkit.merge(smithCodingToolkit, extraToolkit, mcp.toolkit)
    const toolkit = readOnly ? Toolkit.make(...Object.values(combined.tools).filter((tool) => ["read_file", "grep", "glob", "ls", "load_skill", "recall"].includes(tool.name))) : combined
    const skills = yield* discoverSkills(workspace).pipe(Effect.provideService(FileSystem, Context.get(fs, FileSystem)))
    return AgentTools.of({
      toolkit: toolkit as Toolkit.Toolkit<Record<string, Tool.Any>>,
      handlers: Context.unsafeMake<Tool.HandlersFor<Record<string, Tool.Any>>>(Context.mergeAll(baseHandlers, extraHandlers, mcp.handlers).unsafeMap),
      prompt: `${renderSkillsBlock(skills)}\n${mcp.descriptors.map((tool) => `${tool.server}/${tool.name}: ${tool.description}`).join("\n")}`,
    })
  })),
})
export default toolsLocalPlugin
