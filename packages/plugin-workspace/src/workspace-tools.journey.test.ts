import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LanguageModel } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Stream } from "effect"
import { ConversationId, HarnessError, onEvent, onTool, RunId, SessionLogMemoryLive, Sessions, subscribeAll, TurnAdmissionOpen, TurnToolbox, UserMessage } from "@xandreed/core"
import type { Turn, TurnEventOf } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"
import { localSystemPlugin, workspaceToolsPlugin } from "./plugin.adapter.js"
import { workspaceToolSchemas } from "./workspace-tools.entity.js"

/*
 * Key-free journeys: an agent with the local system and the workspace
 * tools, driven by a scripted model over a temporary workspace. They show
 * the tools working through the real registry, loop and session (views,
 * grants, progress events, the session's id in a command's environment),
 * not what any model would do.
 */

const usage = { inputTokens: { total: 10 }, outputTokens: { total: 2 } }
type Part = ReadonlyArray<unknown>
const call = (id: string, name: string, params: unknown): Part => [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]
const stop = (text: string): Part => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]

interface Request {
  readonly tools: ReadonlyArray<string>
  readonly prompt: string
  /** What the request tells the model `read` does. */
  readonly read: string
}

/** A model that answers with the script, step by step, and keeps every request's tools, prompt and read description. */
const scripted = (script: ReadonlyArray<Part>) => Effect.gen(function* () {
  const seen = yield* Ref.make<ReadonlyArray<Request>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Ref.modify(seen, (all): [number, ReadonlyArray<Request>] => [all.length, [...all, {
      tools: options.tools.map((tool) => tool.name), prompt: JSON.stringify(options.prompt.content),
      read: options.tools.find((tool) => tool.name === "read")?.description ?? "",
    }]]).pipe(
      Effect.map((index) => (script[index] ?? stop("done")) as never)),
    streamText: () => Stream.die("not scripted") as never,
  })
  return { seen, model }
})

const conversation = ConversationId.make("00000000-0000-4000-8000-00000000f00d")

const workspace = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "efferent-journey-"))).pipe(Effect.flatMap((dir) => Effect.promise(() => realpath(dir)))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
)

/**
 * Call a tool of the turn the way the loop does, through the registry's
 * handlers (a model cannot call a tool that is not active: it is not in the
 * request), and return what the model would be handed.
 */
const callTool = (name: string, params: unknown): Effect.Effect<unknown, HarnessError> => {
  // The open toolkit is typed over any tool, so its handler services are `any`: the registry's handlers need none.
  const handled: Effect.Effect<ReadonlyArray<{ readonly result: unknown }>, HarnessError> = Effect.gen(function* () {
    // The turn's toolbox is among the services `use` runs with.
    const tools = yield* Option.match(yield* Effect.serviceOption(TurnToolbox), { onNone: () => Effect.die("no toolbox in the turn"), onSome: (toolbox) => toolbox.tools })
    const kit = yield* tools.toolkit.pipe(Effect.provide(tools.handlers))
    return yield* Stream.runCollect(yield* kit.handle(name, params))
  }).pipe(Effect.orDie) as never
  return handled.pipe(Effect.map((results) => results.at(-1)?.result))
}

/**
 * One turn of an agent over `root`, with the given grants, answering `text`
 * with the script; then, when asked, one more call (`probe`) as the loop
 * would make it.
 */
const turnOver = (root: string, grants: ReadonlyArray<string>, script: ReadonlyArray<Part>, text: string, probe?: { readonly name: string; readonly params: unknown }) => Effect.gen(function* () {
  const agent = yield* Agent.define({
    plugins: [
      memoryWindowPlugin,
      { plugin: toolDiscoveryPlugin, options: { grants: [...grants], maxCallsPerRun: 200 } },
      stepLoopPlugin,
      { plugin: localSystemPlugin, options: { exitGraceMs: 100 } },
      { plugin: workspaceToolsPlugin, options: { bashSessionEnv: true, progressMs: 10 } },
    ],
    turnServices: [LanguageModel.LanguageModel],
    limits: { streaming: false, maxSteps: 8 },
    workspace: root,
    system: "You keep the user's notes.",
  })
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  yield* sessions.create({ owner: "journey", id: conversation })
  const address = { id: conversation, owner: "journey" }
  const { seen, model } = yield* scripted(script)
  const progress = yield* Ref.make<ReadonlyArray<TurnEventOf<"tool.progress">>>([])
  const probed = yield* Ref.make<unknown>(null)
  const diffs = yield* Ref.make<ReadonlyArray<string>>([])
  const work = (turn: Turn) => Effect.gen(function* () {
    yield* subscribeAll(turn.events, [
      onEvent("tool.progress", (event) => Ref.update(progress, (all) => [...all, event])),
      // A host's UI gets each edit typed, its diff included.
      onTool(workspaceToolSchemas.edit, ({ input, result }) => Ref.update(diffs, (all) => [...all, `${input.path}\n${result.diff}`])),
    ])
    yield* turn.tools.select(turn.userMessage)
    const result = yield* turn.run({})
    if (probe !== undefined) yield* Ref.set(probed, yield* callTool(probe.name, probe.params))
    return { outcome: result.outcome, reply: Option.some(result.text) }
  })
  const outcome = yield* agent.turn({
    turn: { session: address, userMessage: new UserMessage({ text }), runId: RunId.make("run-1") },
    services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)),
  }, work)
  return { outcome, requests: yield* Ref.get(seen), progress: yield* Ref.get(progress), probed: yield* Ref.get(probed), diffs: yield* Ref.get(diffs), stored: yield* sessions.read(address).pipe(Effect.orDie) }
})

describe("workspace tools journey", () => {
  test("reads a file, loads the edit and shell skills, edits it and runs a command over it", async () => {
    const seen = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* workspace
      yield* Effect.promise(() => writeFile(join(root, "notes.md"), "# Notes\n- buy milk\n- call the plumber\n"))
      const turn = yield* turnOver(root, ["fs.write", "shell.exec"], [
        call("c1", "read", { path: "notes.md" }),
        call("c2", "load_skill", { skills: ["workspace.edit", "workspace.shell"] }),
        call("c3", "edit", { path: "notes.md", edits: [{ oldText: "- buy milk", newText: "- buy oat milk" }] }),
        call("c4", "bash", { command: "grep -c milk notes.md; echo \"session=$EFFERENT_SESSION_ID\"; sleep 0.1; echo done >&2" }),
        stop("Updated the notes."),
      ], "make the milk oat milk")
      return { ...turn, root, notes: yield* Effect.promise(() => readFile(join(root, "notes.md"), "utf8")) }
    })))
    expect(seen.outcome.outcome).toBe("completed")
    expect(seen.outcome.reply).toEqual(Option.some("Updated the notes."))
    expect(seen.notes).toBe("# Notes\n- buy oat milk\n- call the plumber\n")
    const [first, afterRead, afterLoad, afterEdit, afterBash] = seen.requests
    // Only the read skill is on at the start; the others are in the catalogue.
    expect(first?.tools).toEqual(["load_skill", "recall_context", "read", "ls", "find", "grep"])
    expect(first?.prompt).toContain("## Workspace")
    expect(first?.prompt).toContain(`The workspace is ${seen.root}.`)
    expect(first?.prompt).toContain("workspace.edit: Create and change files")
    expect(afterRead?.prompt).toContain("- buy milk")
    expect(afterLoad?.tools).toEqual(["load_skill", "recall_context", "read", "ls", "find", "grep", "write", "edit", "bash"])
    expect(afterEdit?.prompt).toContain("Replaced 1 block in notes.md; the first change is at line 2.")
    expect(afterEdit?.prompt).not.toContain("+- buy oat milk")
    expect(seen.diffs).toEqual(["notes.md\n--- notes.md\n+++ notes.md\n@@ -1,3 +1,3 @@\n # Notes\n-- buy milk\n+- buy oat milk\n - call the plumber\n"])
    expect(afterBash?.prompt).toContain(`1\\nsession=${conversation}\\ndone\\n[Exit code 0.]`)
    // The command's output came live, per stream, as transient progress: never stored.
    expect(seen.progress.map((event) => [event.tool, event.channel])).toContainEqual(["bash", "stdout"])
    expect(seen.progress.map((event) => event.text).join("")).toContain(`session=${conversation}`)
    expect(seen.progress.map((event) => `${event.invocationId}@${event.step}`)).toContain("run-1:call:3@3")
    expect(seen.stored.some((event) => event.kind === "tool.progress")).toBe(false)
  })

  test("reads an image and sees it in the next request; the session log stores it once, through its slot", async () => {
    const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    const seen = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* workspace
      yield* Effect.promise(() => writeFile(join(root, "chart.png"), Buffer.from(pixelPng, "base64")))
      return yield* turnOver(root, [], [
        call("c1", "read", { path: "chart.png" }),
        stop("A one-pixel chart."),
      ], "what does the chart show?")
    })))
    expect(seen.outcome.outcome).toBe("completed")
    expect(seen.outcome.reply).toEqual(Option.some("A one-pixel chart."))
    const [first, afterRead] = seen.requests
    expect(first?.read).toContain("A PNG, JPEG, GIF or WebP image (up to 3.75 MB and 8000 pixels a side) is returned as an image you can see")
    expect(first?.prompt).not.toContain(pixelPng)
    const messages = JSON.parse(afterRead?.prompt ?? "[]") as ReadonlyArray<{ readonly role: string; readonly content: ReadonlyArray<Record<string, unknown>> }>
    const result = messages.find((message) => message.role === "tool")?.content[0]
    expect(result?.["result"]).toBe("[Image chart.png (image/png, 70 B).]")
    expect(result?.["modelOutput"]).toMatchObject([
      { type: "text", text: "[Image chart.png (image/png, 70 B).]" },
      { type: "file", mediaType: "image/png", data: pixelPng, fileName: "chart.png" },
    ])
    const recorded = seen.stored.filter((event) => event.kind === "memory.tool-result")
    const body = (recorded[0]?.data as { readonly body?: Record<string, unknown> } | undefined)?.body
    expect(body?.["media"]).toEqual([{ path: ["image"], fingerprint: expect.any(String), mediaType: "image/png", bytes: 70 }])
    expect(JSON.stringify(seen.stored).split(pixelPng).length - 1).toBe(1)
  })

  test("without the grants, loading workspace.edit is forbidden and edit stays inactive", async () => {
    const seen = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* workspace
      yield* Effect.promise(() => writeFile(join(root, "notes.md"), "- buy milk\n"))
      const turn = yield* turnOver(root, [], [
        call("c1", "load_skill", { skills: ["workspace.edit"] }),
        call("c2", "load_skill", { skills: ["workspace.shell"] }),
        stop("I may not change files here."),
      ], "change the notes", { name: "edit", params: { path: "notes.md", edits: [{ oldText: "milk", newText: "oat milk" }] } })
      return { ...turn, notes: yield* Effect.promise(() => readFile(join(root, "notes.md"), "utf8")) }
    })))
    expect(seen.outcome.outcome).toBe("completed")
    const [, afterEdit, afterShell] = seen.requests
    expect(afterEdit?.prompt).toContain("capability.forbidden")
    expect(afterShell?.prompt).toContain("capability.forbidden")
    expect(afterShell?.tools).toEqual(["load_skill", "recall_context", "read", "ls", "find", "grep"])
    expect(seen.probed).toEqual({ error: "ToolInactive", message: "edit is not loaded yet; call load_skill with one of: workspace.edit" })
    expect(seen.notes).toBe("- buy milk\n")
  })
})
