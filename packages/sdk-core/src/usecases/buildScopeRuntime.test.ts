import { describe, expect, test } from "bun:test"
import { Effect, FiberRef, Layer } from "effect"
import { LanguageModel } from "@effect/ai"
import type { AgentContextNode, ContextNodeId } from "../entities/AgentContext.js"
import type { AgentMessage, ConversationId } from "../entities/Conversation.js"
import type { Scope } from "../entities/Scope.js"
import { ApprovalAllowAllLive } from "../ports/Approval.js"
import { ContextTreeStore } from "../ports/ContextTreeStore.js"
import { FileSystem } from "../ports/FileSystem.js"
import { Http } from "../ports/Http.js"
import { Shell } from "../ports/Shell.js"
import { Verifier } from "../ports/Verifier.js"
import { WebSearch } from "../ports/WebSearch.js"

/** Stub Verifier for the scope-runtime handler layer (these tests never call the
 *  verify gate; like Http/WebSearch above, it dies if unexpectedly used). */
const verifierStub = Layer.succeed(
  Verifier,
  Verifier.of({
    refute: () => Effect.die("unused"),
    gate: () => Effect.die("unused"),
  } as never),
)
import { RunContextRef, type RunContext } from "./runContext.js"
import {
  applyInlineDefinition,
  buildScopeRuntime,
  missionPreamble,
  roleToolEntries,
} from "./buildScopeRuntime.js"

const rootScope: Scope = {
  name: "root",
  description: "the whole workspace",
  rootDir: "/tmp/ws",
  displayRoot: "/tmp/ws",
  systemPrompt: "",
  isRoot: true,
  enforceWrite: false,
  children: [],
}

describe("buildScopeRuntime", () => {
  test("toolkit is the generic set: base coding tools + run_agent, no delegate_to_*", () => {
    const { toolkit } = buildScopeRuntime(rootScope, { skills: [], memory: [], agents: [], tools: [], allowBash: true })
    const names = Object.keys(toolkit.tools)
    expect(names).toContain("run_agent")
    expect(names).toContain("read_file")
    expect(names).toContain("write_file")
    expect(names).toContain("edit_file")
    expect(names).toContain("Bash")
    expect(names).toContain("update_plan")
    expect(names.some((n) => n.startsWith("delegate_to_"))).toBe(false)
  })

  test("the toolkit does not vary with the scope's children (spawning is dynamic now)", () => {
    const withChild: Scope = {
      ...rootScope,
      children: [
        {
          name: "adapters",
          description: "adapter layer",
          rootDir: "/tmp/ws/adapters",
          displayRoot: "/tmp/ws",
          systemPrompt: "",
          isRoot: false,
          enforceWrite: true,
          children: [],
        },
      ],
    }
    const a = Object.keys(buildScopeRuntime(rootScope, { skills: [], memory: [], agents: [], tools: [] }).toolkit.tools).sort()
    const b = Object.keys(buildScopeRuntime(withChild, { skills: [], memory: [], agents: [], tools: [] }).toolkit.tools).sort()
    expect(b).toEqual(a)
  })
})

describe("roleToolEntries (agent-role tool allowlist)", () => {
  const def = (tools?: ReadonlyArray<string>) => ({
    name: "r",
    description: "d",
    body: "b",
    sourcePath: "/x.md",
    ...(tools !== undefined ? { tools } : {}),
  })

  test("no allowlist → all base coding tools, but NOT run_agent (roles are leaf workers)", () => {
    const names = roleToolEntries(def()).map(([n]) => n)
    expect(names).toContain("read_file")
    expect(names).toContain("edit_file")
    expect(names).toContain("Bash")
    expect(names).not.toContain("run_agent")
  })

  test("an allowlist restricts to the named tools; unknown names are dropped", () => {
    const names = roleToolEntries(def(["read_file", "grep", "made_up"])).map(([n]) => n)
    expect(names.sort()).toEqual(["grep", "read_file"])
  })

  test("run_agent is offered only when the allowlist names it (roles can opt into spawning)", () => {
    expect(roleToolEntries(def(["read_file"])).map(([n]) => n)).not.toContain("run_agent")
    expect(roleToolEntries(def(["read_file", "run_agent"])).map(([n]) => n)).toContain("run_agent")
  })
})

describe("applyInlineDefinition — the coordinator defines a sub-agent inline", () => {
  const role = (
    body: string,
    tools?: ReadonlyArray<string>,
    modelRole?: "general" | "code",
  ) => ({
    name: "backend",
    description: "backend specialist",
    body,
    sourcePath: "/x.md",
    ...(tools !== undefined ? { tools } : {}),
    ...(modelRole !== undefined ? { role: modelRole } : {}),
  })

  test("all inline fields absent → returns base UNCHANGED (named-role + generic paths untouched)", () => {
    const base = role("B", ["read_file"])
    expect(applyInlineDefinition(base, {})).toBe(base) // same reference
    expect(applyInlineDefinition(undefined, {})).toBeUndefined()
  })

  test("instructions only (no base) → an inline agent with that body, full toolkit, can write", () => {
    const d = applyInlineDefinition(undefined, { instructions: "You audit migrations." })!
    expect(d.body).toBe("You audit migrations.")
    expect(d.tools).toBeUndefined() // no allowlist → full base coding tools…
    expect(roleToolEntries(d).map(([n]) => n)).toContain("edit_file")
    expect(d.name).toBe("inline")
  })

  test("inline tools → a read-only allowlist (subset-only); roleToolEntries enforces validity", () => {
    const d = applyInlineDefinition(undefined, {
      instructions: "read-only reviewer",
      tools: ["read_file", " grep ", "read_file", "made_up"], // dup + whitespace + unknown
    })!
    expect(d.tools).toEqual(["read_file", "grep", "made_up"]) // trimmed + deduped (validity is roleToolEntries' job)
    expect(roleToolEntries(d).map(([n]) => n).sort()).toEqual(["grep", "read_file"]) // unknown dropped
  })

  test("agent + instructions → COMPOSE the body (role leads, refinement follows)", () => {
    const d = applyInlineDefinition(role("BACKEND ROLE", ["read_file"]), {
      instructions: "Only touch the rate-limiter.",
    })!
    expect(d.body).toBe("BACKEND ROLE\n\nOnly touch the rate-limiter.")
    expect(d.tools).toEqual(["read_file"]) // no inline tools → inherit the role's
  })

  test("inline tools/role OVERRIDE the base's; absent → inherit", () => {
    const base = role("B", ["read_file"], "general")
    const overridden = applyInlineDefinition(base, { instructions: "x", tools: ["grep"], role: "code" })!
    expect(overridden.tools).toEqual(["grep"])
    expect(overridden.role).toBe("code")
    const inherited = applyInlineDefinition(base, { instructions: "x" })!
    expect(inherited.tools).toEqual(["read_file"])
    expect(inherited.role).toBe("general")
  })

  test("a role-only inline override (no instructions/tools) still re-tiers the base", () => {
    const base = role("B", ["read_file"], "general")
    const retiered = applyInlineDefinition(base, { role: "code" })!
    expect(retiered.role).toBe("code")
    expect(retiered.body).toBe("B")
  })

  test("blank/whitespace inline fields are treated as absent", () => {
    const base = role("B")
    expect(applyInlineDefinition(base, { instructions: "   ", tools: [] })).toBe(base)
  })
})

describe("missionPreamble (context-loss backstop on spawn)", () => {
  test("empty without a mission", () => {
    expect(missionPreamble(undefined)).toEqual([])
    expect(missionPreamble("   ")).toEqual([])
  })
  test("one stable user note carrying the human's request", () => {
    const out = missionPreamble("Ship the dark-mode toggle")
    expect(out).toHaveLength(1)
    expect(out[0]?.role).toBe("user")
    const content = String(out[0]?.content)
    expect(content).toContain("Ship the dark-mode toggle")
    // It frames the mission as context, not as the agent's own task.
    expect(content.toLowerCase()).toContain("mission")
  })
})

// --- resumeNode: the human-driven in-place resume ----------------------------

interface Entry {
  node: AgentContextNode
  messages: AgentMessage[]
}

/** Minimal in-memory ContextTreeStore (core tests can't import the evals impl). */
const stubTreeStore = () => {
  const entries = new Map<string, Entry>()
  const layer = Layer.succeed(
    ContextTreeStore,
    ContextTreeStore.of({
      spawn: (input) =>
        Effect.sync(() => {
          const id = crypto.randomUUID() as ContextNodeId
          entries.set(id, {
            node: {
              id,
              parentId: input.parentId,
              rootConversationId: input.rootConversationId,
              edgeKind: input.edgeKind,
              folder: input.folder,
              displayRoot: input.displayRoot,
              seed: input.seed,
              seedMessageCount: input.seedMessages.length,
              status: "running",
              filesChanged: [],
              createdAt: Date.now(),
            },
            messages: [...input.seedMessages],
          })
          return id
        }),
      append: (id, msg) =>
        Effect.sync(() => {
          entries.get(id)?.messages.push(msg)
        }),
      listMessages: (id) => Effect.sync(() => entries.get(id)?.messages ?? []),
      recordReturn: (id, result) =>
        Effect.sync(() => {
          const e = entries.get(id)
          if (e === undefined) return
          e.node = {
            ...e.node,
            status: result.status,
            returnSummary: result.summary,
            filesChanged: result.filesChanged,
            endedAt: Date.now(),
          }
        }),
      get: (id) => Effect.sync(() => entries.get(id)!.node),
      listTree: () => Effect.sync(() => [...entries.values()].map((e) => e.node)),
      drop: (id) => Effect.sync(() => void entries.delete(id)),
    }),
  )
  return { entries, layer }
}

/** A model that answers every call with plain text — the loop ends on turn 1. */
const doneModel = Layer.succeed(
  LanguageModel.LanguageModel,
  LanguageModel.LanguageModel.of({
    generateText: () =>
      Effect.succeed({
        content: [],
        text: "resumed and done",
        finishReason: "stop",
        usage: undefined,
      }),
    generateObject: () => Effect.die("unused"),
    streamText: () => Effect.die("unused"),
  } as never),
)

const stubPorts = Layer.mergeAll(
  Layer.succeed(
    FileSystem,
    FileSystem.of({
      // No SCOPE.md anywhere — getScopePromptBody catches and degrades.
      read: () => Effect.fail({ _tag: "FileNotFound" }),
      write: () => Effect.void,
      list: () => Effect.succeed([]),
      glob: () => Effect.succeed([]),
    } as never),
  ),
  Layer.succeed(
    Shell,
    Shell.of({
      exec: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
    } as never),
  ),
  Layer.succeed(Http, Http.of({ get: () => Effect.die("unused") } as never)),
  Layer.succeed(WebSearch, WebSearch.of({ search: () => Effect.die("unused") } as never)),
  ApprovalAllowAllLive,
  verifierStub,
  doneModel,
)

describe("ScopeRuntime.resumeNode", () => {
  test("resumes a finished node in place: appends the task, re-runs, records the return", async () => {
    const { entries, layer } = stubTreeStore()
    const rt = buildScopeRuntime(rootScope, { skills: [], memory: [], agents: [], tools: [] })

    const program = Effect.gen(function* () {
      const store = yield* ContextTreeStore
      const nodeId = yield* store.spawn({
        parentId: null,
        rootConversationId: null,
        edgeKind: "spawned",
        folder: "/tmp/ws/pkg",
        displayRoot: "/tmp/ws",
        seed: { kind: "task", preview: "t" },
        seedMessages: [{ role: "user", content: "original task" }],
      })
      yield* store.recordReturn(nodeId, {
        status: "ok",
        summary: "first run done",
        filesChanged: [],
      })
      return yield* rt.resumeNode({ nodeId, task: "follow-up question" })
    }).pipe(Effect.provide(Layer.mergeAll(layer, stubPorts)))

    // The whole point: a deadlock anywhere in the resume path fails THIS
    // timeout instead of hanging the TUI (or CI) forever.
    const result = await Effect.runPromise(
      program.pipe(
        Effect.timeoutFail({ duration: "5 seconds", onTimeout: () => "resumeNode HUNG" }),
      ) as unknown as Effect.Effect<{ summary: string }>,
    )

    expect(result.summary).toBe("resumed and done")
    const entry = [...entries.values()][0]!
    expect(entry.node.status).toBe("ok")
    expect(entry.node.returnSummary).toBe("resumed and done")
    // the follow-up was appended to the SAME node (original + follow-up)
    expect(entry.messages.filter((m) => m.role === "user").length).toBe(2)
  })
})

// --- spawnAgent: the job router seeds mission + interactionPolicy ------------

describe("ScopeRuntime.spawnAgent — mission + interactionPolicy seeding (the JobController fix)", () => {
  // A model that captures the ambient RunContext of the run it's invoked in, so
  // we can assert the run's own loop sees the mission + headless policy (the
  // childRc the run executes under), then ends the turn.
  const capturingModel = (sink: { rc?: RunContext }) =>
    Layer.succeed(
      LanguageModel.LanguageModel,
      LanguageModel.LanguageModel.of({
        generateText: () =>
          FiberRef.get(RunContextRef).pipe(
            Effect.tap((rc) => Effect.sync(() => void (sink.rc = rc))),
            Effect.as({ content: [], text: "done", finishReason: "stop", usage: undefined }),
          ),
        generateObject: () => Effect.die("unused"),
        streamText: () => Effect.die("unused"),
      } as never),
    )

  const portsWith = (model: Layer.Layer<LanguageModel.LanguageModel>) =>
    Layer.mergeAll(
      Layer.succeed(
        FileSystem,
        FileSystem.of({
          read: () => Effect.fail({ _tag: "FileNotFound" }),
          write: () => Effect.void,
          list: () => Effect.succeed([]),
          glob: () => Effect.succeed([]),
        } as never),
      ),
      Layer.succeed(
        Shell,
        Shell.of({ exec: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }) } as never),
      ),
      Layer.succeed(Http, Http.of({ get: () => Effect.die("unused") } as never)),
      Layer.succeed(WebSearch, WebSearch.of({ search: () => Effect.die("unused") } as never)),
      ApprovalAllowAllLive,
      verifierStub,
      model,
    )

  test("a scheduled-style spawn seeds the mission preamble into the node AND runs headless", async () => {
    const { entries, layer } = stubTreeStore()
    const sink: { rc?: RunContext } = {}
    const rt = buildScopeRuntime(rootScope, { skills: [], memory: [], agents: [], tools: [] })
    const rootConvId = crypto.randomUUID() as ConversationId

    const program = rt
      .spawnAgent({
        rootConversationId: rootConvId,
        folder: "pkg",
        task: "run the nightly review",
        mission: "Keep the build green every night",
        interactionPolicy: "headless",
      })
      .pipe(
        Effect.provide(rt.handlerLayer),
        Effect.provide(Layer.mergeAll(layer, portsWith(capturingModel(sink)))),
        // The driver IS the root: a fresh, unseeded RunContext (depth 0).
        Effect.locally(RunContextRef, {
          rootConversationId: rootConvId,
          parentNodeId: null,
          depth: 0,
          tokenPool: null,
        }),
      )

    const result = await Effect.runPromise(
      program.pipe(
        Effect.timeoutFail({ duration: "5 seconds", onTimeout: () => "spawnAgent HUNG" }),
      ) as unknown as Effect.Effect<{ summary: string; nodeId: ContextNodeId }>,
    )

    expect(result.summary).toBe("done")

    // 1) The node's seed messages carry the mission preamble ahead of the task —
    //    so the unattended run isn't blind to the goal it serves.
    const entry = [...entries.values()][0]!
    const userMsgs = entry.messages.filter((m) => m.role === "user").map((m) => String(m.content))
    expect(userMsgs.length).toBe(2)
    expect(userMsgs[0]?.toLowerCase()).toContain("mission")
    expect(userMsgs[0]).toContain("Keep the build green every night")
    expect(userMsgs[1]).toBe("run the nightly review")

    // 2) The run's OWN loop executed under a RunContext carrying the mission +
    //    the headless policy — so its approval would park-and-deny, not block.
    expect(sink.rc?.interactionPolicy).toBe("headless")
    expect(sink.rc?.mission).toBe("Keep the build green every night")
  })
})

// --- run_agent (the model tool) is non-blocking; wait_for_agents gathers ------

describe("run_agent — async, non-blocking spawn + wait_for_agents gather", () => {
  // The whole point of the fix: spawning must NOT block the caller on the
  // subtree (that was the "parent hangs" bug). run_agent returns a running
  // handle at once; the work happens in a background fiber; the caller collects
  // it later with wait_for_agents — which never freezes anyone.
  test("run_agent returns { status: 'running' } immediately; wait_for_agents returns the finished result", async () => {
    const { layer } = stubTreeStore()
    const rt = buildScopeRuntime(rootScope, { skills: [], memory: [], agents: [], tools: [] })

    const program = Effect.gen(function* () {
      const tk = yield* rt.toolkit
      // The erased toolkit (Record<string, Tool.Any>) types handle's params as
      // `never`; call it through a loose signature (runtime decodes the args).
      const call = (tk as unknown as {
        handle: (name: string, params: unknown) => Effect.Effect<{ result: unknown }>
      }).handle
      const spawned = yield* call("run_agent", {
        name: "worker",
        folder: "pkg",
        task: "do the thing",
      })
      const handle = spawned.result as { nodeId: string; name: string; status: string }
      // Gather it — wait_for_agents blocks only this fiber, interruptibly, and
      // returns when the agent finishes (the fake model ends turn 0).
      const gathered = yield* call("wait_for_agents", {
        nodeIds: [handle.nodeId],
        timeoutSeconds: 5,
      })
      return { handle, gathered: gathered.result as {
        agents: ReadonlyArray<{ status: string; summary?: string; name: string }>
        allDone: boolean
      } }
    }).pipe(
      Effect.provide(rt.handlerLayer),
      Effect.provide(Layer.mergeAll(layer, stubPorts)),
      Effect.locally(RunContextRef, {
        rootConversationId: null,
        parentNodeId: null,
        depth: 0,
        tokenPool: null,
      }),
    )

    const result = await Effect.runPromise(
      program.pipe(
        Effect.timeoutFail({ duration: "5 seconds", onTimeout: () => "run_agent HUNG" }),
      ) as unknown as Effect.Effect<{
        handle: { nodeId: string; name: string; status: string }
        agents?: never
        gathered: {
          agents: ReadonlyArray<{ status: string; summary?: string; name: string }>
          allDone: boolean
        }
      }>,
    )

    // The spawn call did not wait for the work — it returned a running handle.
    expect(result.handle.status).toBe("running")
    expect(result.handle.name).toBe("worker")
    // The gather collected the finished agent's outcome.
    expect(result.gathered.allDone).toBe(true)
    expect(result.gathered.agents).toHaveLength(1)
    expect(result.gathered.agents[0]?.status).toBe("ok")
    expect(result.gathered.agents[0]?.summary).toBe("resumed and done")
  })

  test("an INLINE agent (instructions + tools) spawns + gathers like any other — new params decode and flow through", async () => {
    const { layer } = stubTreeStore()
    const rt = buildScopeRuntime(rootScope, { skills: [], memory: [], agents: [], tools: [] })

    const program = Effect.gen(function* () {
      const tk = yield* rt.toolkit
      const call = (tk as unknown as {
        handle: (name: string, params: unknown) => Effect.Effect<{ result: unknown }>
      }).handle
      // No predefined role — a one-off persona with a read-only allowlist.
      const spawned = yield* call("run_agent", {
        name: "secret auditor",
        folder: "pkg",
        task: "scan for hard-coded secrets",
        instructions: "You audit for committed secrets. Report file:line; change nothing.",
        tools: ["read_file", "grep", "glob", "ls"],
      })
      const handle = spawned.result as { nodeId: string; name: string; status: string }
      const gathered = yield* call("wait_for_agents", { nodeIds: [handle.nodeId], timeoutSeconds: 5 })
      return { handle, gathered: gathered.result as { agents: ReadonlyArray<{ status: string }>; allDone: boolean } }
    }).pipe(
      Effect.provide(rt.handlerLayer),
      Effect.provide(Layer.mergeAll(layer, stubPorts)),
      Effect.locally(RunContextRef, { rootConversationId: null, parentNodeId: null, depth: 0, tokenPool: null }),
    )

    const result = await Effect.runPromise(
      program.pipe(Effect.timeoutFail({ duration: "5 seconds", onTimeout: () => "inline run_agent HUNG" })) as unknown as Effect.Effect<{
        handle: { name: string; status: string }
        gathered: { agents: ReadonlyArray<{ status: string }>; allDone: boolean }
      }>,
    )

    expect(result.handle.status).toBe("running")
    expect(result.handle.name).toBe("secret auditor") // display title from `name`, not "inline"
    expect(result.gathered.allDone).toBe(true)
    expect(result.gathered.agents[0]?.status).toBe("ok")
  })
})

// --- interruption finalizer: a wedged/killed run notifies the parent ----------

describe("runSpawnedAgent — interruption records an error return + notifies the parent", () => {
  // A model that never returns — the spawned loop blocks on its first turn,
  // so the only way the run ends is interruption (Esc / :stop / teardown).
  const blockingModel = Layer.succeed(
    LanguageModel.LanguageModel,
    LanguageModel.LanguageModel.of({
      generateText: () => Effect.never,
      generateObject: () => Effect.die("unused"),
      streamText: () => Effect.die("unused"),
    } as never),
  )

  const blockingPorts = Layer.mergeAll(
    Layer.succeed(
      FileSystem,
      FileSystem.of({
        read: () => Effect.fail({ _tag: "FileNotFound" }),
        write: () => Effect.void,
        list: () => Effect.succeed([]),
        glob: () => Effect.succeed([]),
      } as never),
    ),
    Layer.succeed(
      Shell,
      Shell.of({ exec: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }) } as never),
    ),
    Layer.succeed(Http, Http.of({ get: () => Effect.die("unused") } as never)),
    Layer.succeed(WebSearch, WebSearch.of({ search: () => Effect.die("unused") } as never)),
    ApprovalAllowAllLive,
    verifierStub,
    blockingModel,
  )

  test("an interrupted spawn → node status 'error' (INTERRUPTED_NOTE) + a completion in the parent's inbox", async () => {
    const { entries, layer } = stubTreeStore()
    const rt = buildScopeRuntime(rootScope, { skills: [], memory: [], agents: [], tools: [] })
    // A real root conversation id so the spawned node's parentKey is set and
    // bus.complete delivers the completion to the parent's mailbox.
    const rootConvId = crypto.randomUUID() as ConversationId

    const program = Effect.gen(function* () {
      // Register the parent's live mailbox first, so the child's completion
      // lands in it (rather than the idle-parent `pending` buffer).
      yield* rt.bus.markRunning(rootConvId, "the lead agent", { parentKey: null })

      const tk = yield* rt.toolkit
      const call = (tk as unknown as {
        handle: (name: string, params: unknown) => Effect.Effect<{ result: unknown }>
      }).handle
      const spawned = yield* call("run_agent", {
        name: "wedged worker",
        folder: "pkg",
        task: "block forever",
      })
      const handle = spawned.result as { nodeId: string; status: string }

      // The spawn is non-blocking: it returns a running handle immediately.
      expect(handle.status).toBe("running")

      // Wait until the run is registered as running on the bus, then interrupt
      // it (the Esc / :stop path). interrupt returns false until the fiber is set.
      yield* Effect.gen(function* () {
        while (!(yield* rt.bus.interrupt(handle.nodeId))) {
          yield* Effect.sleep("10 millis")
        }
      }).pipe(Effect.timeout("3 seconds"))

      // Poll the node until the finalizer has recorded its terminal return.
      yield* Effect.gen(function* () {
        while (entries.get(handle.nodeId)?.node.status === "running") {
          yield* Effect.sleep("10 millis")
        }
      }).pipe(Effect.timeout("3 seconds"))

      // The parent's inbox should now carry the child's completion note.
      const inbox = yield* rt.bus.drain(rootConvId)
      return { nodeId: handle.nodeId, inbox }
    }).pipe(
      Effect.provide(rt.handlerLayer),
      Effect.provide(Layer.mergeAll(layer, blockingPorts)),
      Effect.locally(RunContextRef, {
        rootConversationId: rootConvId,
        parentNodeId: null,
        depth: 0,
        tokenPool: null,
      }),
    )

    const { nodeId, inbox } = await Effect.runPromise(
      program.pipe(
        Effect.timeoutFail({ duration: "8 seconds", onTimeout: () => "interrupt test HUNG" }),
      ) as unknown as Effect.Effect<{
        nodeId: string
        inbox: ReadonlyArray<{ from: string; content: string }>
      }>,
    )

    // The DB node is no longer stuck `running` — the finalizer recorded an error.
    const node = entries.get(nodeId)!.node
    expect(node.status).toBe("error")
    expect(node.returnSummary).toBe("[interrupted — run did not finish]")

    // The parent was notified immediately (a "failed: …" completion line),
    // instead of relying on the mid-session sweeper.
    expect(inbox.length).toBeGreaterThan(0)
    expect(inbox.some((m) => m.content.includes("[interrupted — run did not finish]"))).toBe(true)
    expect(inbox[0]?.content.startsWith("failed:")).toBe(true)
  })
})

describe("schedule management tools — schedule / list_scheduled_jobs / cancel_scheduled_job", () => {
  // A tiny stateful FileSystem backing cron.json, so the schedule trio
  // round-trips through the real loadJobs/addJob/removeJob (which read/write it).
  const fsBackedPorts = () => {
    const files = new Map<string, string>()
    const fsLayer = Layer.succeed(
      FileSystem,
      FileSystem.of({
        read: (path: string) =>
          files.has(path)
            ? Effect.succeed({ content: files.get(path)! })
            : Effect.fail({ _tag: "FileNotFound" }),
        write: (path: string, content: string) => Effect.sync(() => void files.set(path, content)),
        list: () => Effect.succeed([]),
        glob: () => Effect.succeed([]),
      } as never),
    )
    return Layer.mergeAll(
      fsLayer,
      Layer.succeed(Shell, Shell.of({ exec: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }) } as never)),
      Layer.succeed(Http, Http.of({ get: () => Effect.die("unused") } as never)),
      Layer.succeed(WebSearch, WebSearch.of({ search: () => Effect.die("unused") } as never)),
      ApprovalAllowAllLive,
      verifierStub,
      doneModel,
    )
  }

  test("a scheduled job is listed, then cancelled (found); a bad cron is a returned failure", async () => {
    const { layer } = stubTreeStore()
    const rt = buildScopeRuntime(rootScope, { skills: [], memory: [], agents: [], tools: [] })

    const program = Effect.gen(function* () {
      const tk = yield* rt.toolkit
      const call = (tk as unknown as {
        handle: (name: string, params: unknown) => Effect.Effect<{ result: unknown }>
      }).handle

      const scheduled = yield* call("schedule", {
        cron: "0 9 * * 1",
        task: "weekly review",
        folder: "pkg",
      })
      const id = (scheduled.result as { id: string }).id

      const listed = yield* call("list_scheduled_jobs", {})
      const jobs = (listed.result as { jobs: ReadonlyArray<{ id: string; task: string; folder: string; cron: string }> }).jobs

      // Folder filter narrows correctly: a non-matching folder yields none.
      const filteredOut = yield* call("list_scheduled_jobs", { folder: "other" })
      const noneJobs = (filteredOut.result as { jobs: ReadonlyArray<unknown> }).jobs

      const cancelled = yield* call("cancel_scheduled_job", { id })
      const cancelMiss = yield* call("cancel_scheduled_job", { id: "nope" })
      const afterCancel = yield* call("list_scheduled_jobs", {})

      // A malformed cron is returned to the model as data, not thrown.
      const bad = yield* call("schedule", { cron: "not a cron", task: "x" })

      return {
        id,
        jobs,
        noneJobs,
        cancelled: cancelled.result as { id: string; found: boolean },
        cancelMiss: cancelMiss.result as { found: boolean },
        afterCancel: (afterCancel.result as { jobs: ReadonlyArray<unknown> }).jobs,
        bad: bad.result as { error?: string; isFailure?: boolean },
      }
    }).pipe(
      Effect.provide(rt.handlerLayer),
      Effect.provide(Layer.mergeAll(layer, fsBackedPorts())),
      Effect.locally(RunContextRef, {
        rootConversationId: null,
        parentNodeId: null,
        depth: 0,
        tokenPool: null,
      }),
    )

    const r = await Effect.runPromise(program as unknown as Effect.Effect<{
      id: string
      jobs: ReadonlyArray<{ id: string; task: string; folder: string; cron: string }>
      noneJobs: ReadonlyArray<unknown>
      cancelled: { id: string; found: boolean }
      cancelMiss: { found: boolean }
      afterCancel: ReadonlyArray<unknown>
      bad: { error?: string; isFailure?: boolean }
    }>)

    expect(r.jobs).toHaveLength(1)
    expect(r.jobs[0]?.id).toBe(r.id)
    expect(r.jobs[0]?.task).toBe("weekly review")
    expect(r.jobs[0]?.folder).toBe("pkg")
    expect(r.jobs[0]?.cron).toBe("0 9 * * 1")
    expect(r.noneJobs).toHaveLength(0)
    expect(r.cancelled).toEqual({ id: r.id, found: true })
    expect(r.cancelMiss.found).toBe(false)
    expect(r.afterCancel).toHaveLength(0)
    // failureMode:"return" surfaces the bad-cron failure as a tool result.
    expect(r.bad.isFailure ?? r.bad.error).toBeTruthy()
  })
})
