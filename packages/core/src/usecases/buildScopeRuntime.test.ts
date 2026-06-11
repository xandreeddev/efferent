import { describe, expect, test } from "bun:test"
import { Effect, FiberRef, Layer } from "effect"
import { LanguageModel } from "@effect/ai"
import { ModelOverrideRef } from "./modelOverride.js"
import type { AgentContextNode, ContextNodeId } from "../entities/AgentContext.js"
import type { AgentMessage } from "../entities/Conversation.js"
import type { Scope } from "../entities/Scope.js"
import { ApprovalAllowAllLive } from "../ports/Approval.js"
import { ContextTreeStore } from "../ports/ContextTreeStore.js"
import { FileSystem } from "../ports/FileSystem.js"
import { Http } from "../ports/Http.js"
import { Shell } from "../ports/Shell.js"
import { WebSearch } from "../ports/WebSearch.js"
import { buildScopeRuntime } from "./buildScopeRuntime.js"

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
    const { toolkit } = buildScopeRuntime(rootScope, { skills: [], allowBash: true })
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
    const a = Object.keys(buildScopeRuntime(rootScope, { skills: [] }).toolkit.tools).sort()
    const b = Object.keys(buildScopeRuntime(withChild, { skills: [] }).toolkit.tools).sort()
    expect(b).toEqual(a)
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

/** A model that answers every call with plain text — the loop ends on turn 1.
 *  The reply embeds the fiber's `ModelOverrideRef` (like the real router reads
 *  it), so a test can assert which TIER the loop actually ran on. */
const doneModel = Layer.succeed(
  LanguageModel.LanguageModel,
  LanguageModel.LanguageModel.of({
    generateText: () =>
      Effect.gen(function* () {
        const override = yield* FiberRef.get(ModelOverrideRef)
        return {
          content: [],
          text:
            override !== undefined
              ? `resumed and done on ${override.provider}:${override.modelId}`
              : "resumed and done",
          finishReason: "stop",
          usage: undefined,
        }
      }),
    generateObject: () => Effect.die("unused"),
    streamText: () => {
      throw new Error("unused")
    },
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
  doneModel,
)

describe("ScopeRuntime.resumeNode", () => {
  test("resumes a finished node in place: appends the task, re-runs, records the return", async () => {
    const { entries, layer } = stubTreeStore()
    const rt = buildScopeRuntime(rootScope, { skills: [] })

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

  test("a fastModel runs the sub-agent loop on the FAST tier (ModelOverrideRef set)", async () => {
    const { layer } = stubTreeStore()
    const rt = buildScopeRuntime(rootScope, { skills: [] })

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
      const onFast = yield* rt.resumeNode({
        nodeId,
        task: "follow-up",
        fastModel: "google:gemini-3.5-flash",
      })
      // And WITHOUT fastModel the override stays unset (main selection).
      const onMain = yield* rt.resumeNode({ nodeId, task: "another follow-up" })
      return { onFast, onMain }
    }).pipe(Effect.provide(Layer.mergeAll(layer, stubPorts)))

    const { onFast, onMain } = await Effect.runPromise(
      program.pipe(
        Effect.timeoutFail({ duration: "5 seconds", onTimeout: () => "resumeNode HUNG" }),
      ) as unknown as Effect.Effect<{
        onFast: { summary: string }
        onMain: { summary: string }
      }>,
    )
    expect(onFast.summary).toBe("resumed and done on google:gemini-3.5-flash")
    expect(onMain.summary).toBe("resumed and done")
  })
})
