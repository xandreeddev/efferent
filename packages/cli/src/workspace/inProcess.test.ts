import { describe, expect, test } from "bun:test"
import { Chunk, Effect, FiberRef, Layer, Ref, Stream } from "effect"
import { LanguageModel } from "@effect/ai"
import {
  type AgentContextNode,
  type AgentMessage,
  type ContextNodeId,
  type Scope,
  ApprovalAllowAllLive,
  ContextTreeStore,
  ConversationStore,
  conversationSessionId,
  DefaultSettings,
  FileSystem,
  Http,
  RunContextRef,
  SettingsStore,
  Shell,
  UtilityLlm,
  WebSearch,
} from "@xandreed/sdk-core"
import { NoopTerminalSessionLive } from "@xandreed/sdk-adapters"
import { makeInProcessWorkspace } from "./inProcess.js"
import { makeFleetSupervisor } from "../cli/state/fleet.js"

// Exercises the real in-process Workspace end-to-end with a scripted model: a
// `send` forks a turn whose events flow through the EventLedger to a subscriber,
// the loop ends, and the persisted log reflects it. No live provider, no Docker.

const rootScope: Scope = {
  name: "root",
  description: "the whole workspace",
  rootDir: "/tmp/ws",
  displayRoot: "/tmp/ws",
  systemPrompt: "you are a coder",
  isRoot: true,
  enforceWrite: false,
  children: [],
}

const ROOT_CID = "11111111-1111-1111-1111-111111111111"

/** A model that answers with plain text and stops on turn 0. */
const doneModel = Layer.succeed(
  LanguageModel.LanguageModel,
  LanguageModel.LanguageModel.of({
    generateText: () =>
      Effect.succeed({
        content: [],
        text: "all done",
        finishReason: "stop",
        usage: undefined,
      }),
    generateObject: () => Effect.die("unused"),
    streamText: () => Effect.die("unused"),
  } as never),
)

/** Minimal in-memory ContextTreeStore (no sub-agents spawned in this test). */
const stubTree = Layer.succeed(
  ContextTreeStore,
  ContextTreeStore.of({
    spawn: () => Effect.succeed(crypto.randomUUID() as ContextNodeId),
    append: () => Effect.void,
    listMessages: () => Effect.succeed<ReadonlyArray<AgentMessage>>([]),
    recordReturn: () => Effect.void,
    get: () => Effect.die("unused"),
    listTree: () => Effect.succeed<ReadonlyArray<AgentContextNode>>([]),
    drop: () => Effect.void,
  }),
)

const stubPortsNoModel = Layer.mergeAll(
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
  Layer.succeed(
    UtilityLlm,
    UtilityLlm.of({ complete: () => Effect.die("unused") } as never),
  ),
  Layer.succeed(
    SettingsStore,
    SettingsStore.of({
      get: () => Effect.succeed(DefaultSettings),
      global: () => Effect.succeed(DefaultSettings),
      update: () => Effect.succeed(DefaultSettings),
      load: () => Effect.succeed(DefaultSettings),
    }),
  ),
  stubTree,
  NoopTerminalSessionLive,
)

const stubPorts = Layer.mergeAll(stubPortsNoModel, doneModel)

/** A model that records the general model pinned on RunContext for the turn. */
const capturingModel = (captured: Ref.Ref<string | undefined>) =>
  Layer.succeed(
    LanguageModel.LanguageModel,
    LanguageModel.LanguageModel.of({
      generateText: () =>
        FiberRef.get(RunContextRef).pipe(
          Effect.flatMap((rc) => Ref.set(captured, rc.pinnedModels?.general)),
          Effect.as({
            content: [],
            text: "ok",
            finishReason: "stop",
            usage: undefined,
          }),
        ),
      generateObject: () => Effect.die("unused"),
      streamText: () => Effect.die("unused"),
    } as never),
  )

/** A fresh in-memory ConversationStore (just what `runAgent`/`getState` touch). */
const stubConv = () =>
  Layer.effect(
    ConversationStore,
    Effect.gen(function* () {
      const msgs = yield* Ref.make<ReadonlyArray<AgentMessage>>([])
      const pending = yield* Ref.make<string | undefined>(undefined)
      return ConversationStore.of({
        create: () => Effect.succeed(ROOT_CID as never),
        ensure: () => Effect.void,
        append: (_id, m) => Ref.updateAndGet(msgs, (a) => [...a, m]).pipe(Effect.map((a) => a.length - 1)),
        list: () => Ref.get(msgs),
        listActive: () => Ref.get(msgs),
        getLatestCheckpoint: () => Effect.succeed(undefined),
        listCheckpoints: () => Effect.succeed([]),
        checkpoint: () => Effect.void,
        setTitle: () => Effect.void,
        setModel: () => Effect.void,
        listByWorkspace: () => Effect.succeed([]),
        markPending: (_id, prompt) => Ref.set(pending, prompt),
        clearPending: () => Ref.set(pending, undefined),
        listPending: () => Effect.succeed([]),
      })
    }),
  )

describe("in-process Workspace", () => {
  test("send drives a turn; events flow through the ledger; the log persists", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ws = yield* makeInProcessWorkspace({
          roots: [{ cid: ROOT_CID as never }],
          rootScope,
          cwd: "/tmp/ws",
          skills: [],
          memory: [],
          agents: [],
          tools: [],
          instructionFiles: [],
          approvalLayer: ApprovalAllowAllLive,
          fleet: makeFleetSupervisor(),
          allowBash: true,
        })
        const rootId = conversationSessionId(ROOT_CID as never)

        yield* ws.send(rootId, "hello there")

        // The run is a detached fiber — wait for it to settle (bounded).
        let spins = 0
        while ((yield* ws.getState(rootId)).busy && spins < 300) {
          yield* Effect.sleep("20 millis")
          spins += 1
        }

        // Replay the ledger from the start — the ring holds the whole short run.
        const events = yield* ws
          .subscribe(rootId, 0)
          .pipe(
            Stream.takeUntil((e) => e.event.type === "agent_end"),
            Stream.runCollect,
            Effect.timeout("3 seconds"),
          )
        const state = yield* ws.getState(rootId)
        return {
          types: Chunk.toReadonlyArray(events).map((e) => e.event.type),
          state,
        }
      }).pipe(Effect.provide(Layer.mergeAll(stubPorts, stubConv()))),
    )

    // The lifecycle flowed through the ledger: a turn started, the model spoke,
    // the run ended — all observed by a subscriber.
    expect(result.types).toContain("turn_start")
    expect(result.types).toContain("assistant_message")
    expect(result.types).toContain("agent_end")
    // The session settled idle, and the user prompt was persisted.
    expect(result.state.busy).toBe(false)
    // The daemon-authoritative phase settled to idle too — this is what a
    // (re)attaching client reads to clear a phantom "thinking" spinner.
    expect(result.state.phase).toBe("idle")
    const userMsgs = result.state.log.filter((m) => m.role === "user")
    expect(userMsgs.length).toBeGreaterThanOrEqual(1)
    expect(result.state.session.kind).toBe("root")
  })

  test("setFleetModel changes the model a subsequent turn uses (the daemon honors a model switch)", async () => {
    const used = await Effect.runPromise(
      Effect.gen(function* () {
        const captured = yield* Ref.make<string | undefined>(undefined)
        const program = Effect.gen(function* () {
          const ws = yield* makeInProcessWorkspace({
            roots: [{ cid: ROOT_CID as never }],
            rootScope,
            cwd: "/tmp/ws",
            skills: [],
            memory: [],
            agents: [],
            tools: [],
            instructionFiles: [],
            approvalLayer: ApprovalAllowAllLive,
            fleet: makeFleetSupervisor(),
            allowBash: true,
          })
          const rootId = conversationSessionId(ROOT_CID as never)
          // Switch the fleet's model, then run a turn. The remote-path bug was
          // that a `:login`/`:model` switch never reached the daemon, so turns
          // kept using the boot-time default; this asserts the switch lands on
          // the turn (`RunContext.pinnedModels.general`), which the router uses.
          yield* ws.setFleetModel(rootId, "opencode:switched-model")
          yield* ws.send(rootId, "go")
          let spins = 0
          while ((yield* ws.getState(rootId)).busy && spins < 300) {
            yield* Effect.sleep("20 millis")
            spins += 1
          }
        }).pipe(
          Effect.provide(Layer.mergeAll(stubPortsNoModel, capturingModel(captured), stubConv())),
        )
        yield* program
        return yield* Ref.get(captured)
      }),
    )
    expect(used).toBe("opencode:switched-model")
  })

  test("getState reports the authoritative phase: idle before a turn, idle after it settles", async () => {
    const phases = await Effect.runPromise(
      Effect.gen(function* () {
        const ws = yield* makeInProcessWorkspace({
          roots: [{ cid: ROOT_CID as never }],
          rootScope,
          cwd: "/tmp/ws",
          skills: [],
          memory: [],
          agents: [],
          tools: [],
          instructionFiles: [],
          approvalLayer: ApprovalAllowAllLive,
          fleet: makeFleetSupervisor(),
          allowBash: true,
        })
        const rootId = conversationSessionId(ROOT_CID as never)
        // A fresh session has never run → idle (not a phantom thinking).
        const before = (yield* ws.getState(rootId)).phase
        yield* ws.send(rootId, "hello")
        // Let the detached turn settle.
        let spins = 0
        while ((yield* ws.getState(rootId)).busy && spins < 300) {
          yield* Effect.sleep("20 millis")
          spins += 1
        }
        const after = (yield* ws.getState(rootId)).phase
        return { before, after }
      }).pipe(Effect.provide(Layer.mergeAll(stubPorts, stubConv()))),
    )
    expect(phases.before).toBe("idle")
    expect(phases.after).toBe("idle")
  })

})
