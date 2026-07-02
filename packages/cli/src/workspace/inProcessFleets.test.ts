import { describe, expect, test } from "bun:test"
import { Chunk, Effect, Layer, Ref, Stream } from "effect"
import {
  type AgentMessage,
  ApprovalAllowAllLive,
  ConversationStore,
  ConversationNotFound,
  type ConversationId,
} from "@xandreed/sdk-core"
import { makeInProcessWorkspace } from "./inProcess.js"
import { makeFleetSupervisor } from "../cli/state/fleet.js"
import { fakeEnvLayersNoConv, fakeRootScope } from "./fakeAppEnv.js"

// Multi-fleet: one daemon hosts several fleets (deployments). Each fleet is its
// own root coordinator with its own pinned model; createFleet/listSessions/send
// are all per-fleet. Backed by a multi-conversation in-memory store (distinct
// ids on create, per-conv messages + model).

interface Conv {
  msgs: ReadonlyArray<AgentMessage>
  model?: string
}

const multiConv = Layer.effect(
  ConversationStore,
  Effect.gen(function* () {
    const convs = yield* Ref.make(new Map<string, Conv>())
    const get = (id: string) => Ref.get(convs).pipe(Effect.map((m) => m.get(id)))
    return ConversationStore.of({
      create: () =>
        Effect.gen(function* () {
          const id = crypto.randomUUID()
          yield* Ref.update(convs, (m) => new Map(m).set(id, { msgs: [] }))
          return id as ConversationId
        }),
      ensure: (id) =>
        Ref.update(convs, (m) => (m.has(id) ? m : new Map(m).set(id, { msgs: [] }))),
      append: (id, msg) =>
        Ref.updateAndGet(convs, (m) => {
          const c = m.get(id) ?? { msgs: [] }
          return new Map(m).set(id, { ...c, msgs: [...c.msgs, msg] })
        }).pipe(Effect.map((m) => (m.get(id)?.msgs.length ?? 1) - 1)),
      list: (id) => get(id).pipe(Effect.map((c) => c?.msgs ?? [])),
      listActive: (id) => get(id).pipe(Effect.map((c) => c?.msgs ?? [])),
      getLatestCheckpoint: () => Effect.succeed(undefined),
      listCheckpoints: () => Effect.succeed([]),
      checkpoint: () => Effect.void,
      setTitle: () => Effect.void,
      setModel: (id, model) =>
        Effect.gen(function* () {
          const c = yield* get(id)
          if (c === undefined) return yield* Effect.fail(new ConversationNotFound({ id }))
          yield* Ref.update(convs, (m) => new Map(m).set(id, { ...c, model }))
        }),
      listByWorkspace: () =>
        Ref.get(convs).pipe(
          Effect.map((m) =>
            [...m.entries()].map(([id, c]) => ({
              id: id as ConversationId,
              createdAt: 0,
              ...(c.model !== undefined ? { model: c.model } : {}),
            })),
          ),
        ),
      markPending: () => Effect.void,
      clearPending: () => Effect.void,
      listPending: () => Effect.succeed([]),
      recordGateVerdict: () => Effect.void,
      listGateVerdicts: () => Effect.succeed([]),
    })
  }),
)

const env = Layer.merge(fakeEnvLayersNoConv("fleet ok"), multiConv)

const build = () =>
  makeInProcessWorkspace({
    roots: [], // start with no fleets; createFleet makes them
    rootScope: fakeRootScope,
    cwd: "/tmp/ws",
    skills: [],
    memory: [],
    agents: [],
    tools: [],
    instructionFiles: [],
    approvalLayer: ApprovalAllowAllLive,
    fleet: makeFleetSupervisor(),
  })

describe("in-process Workspace — multiple fleets", () => {
  test("createFleet hosts distinct fleets; listSessions shows each root with its pinned model", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ws = yield* build()
        const a = yield* ws.createFleet({ folder: "/tmp/ws/a", model: "openai:gpt-4o" })
        const b = yield* ws.createFleet({ folder: "/tmp/ws/b", model: "google:gemini-3.5-flash" })
        const sessions = yield* ws.listSessions()
        return { a, b, roots: sessions.filter((s) => s.kind === "root") }
      }).pipe(Effect.provide(env)),
    )
    expect(result.a).not.toBe(result.b) // distinct fleet roots
    expect(result.roots).toHaveLength(2)
    const byId = new Map(result.roots.map((r) => [r.id, r]))
    expect(byId.get(result.a)?.model).toBe("openai:gpt-4o")
    expect(byId.get(result.b)?.model).toBe("google:gemini-3.5-flash")
  })

  test("createFleet with a task drives that fleet's first turn; its log persists", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ws = yield* build()
        const a = yield* ws.createFleet({ folder: "/tmp/ws/a", task: "do A" })
        const events = yield* ws
          .subscribe(a, 0)
          .pipe(
            Stream.takeUntil((e) => e.event.type === "agent_end"),
            Stream.runCollect,
            Effect.timeout("8 seconds"),
          )
        // Settle, then read the fleet's state.
        let spins = 0
        while ((yield* ws.getState(a)).busy && spins < 200) {
          yield* Effect.sleep("20 millis")
          spins += 1
        }
        const state = yield* ws.getState(a)
        return {
          types: Chunk.toReadonlyArray(events).map((e) => e.event.type),
          users: state.log.filter((m) => m.role === "user").length,
          kind: state.session.kind,
        }
      }).pipe(Effect.provide(env)),
    )
    expect(result.types).toContain("turn_start")
    expect(result.types).toContain("agent_end")
    expect(result.users).toBeGreaterThanOrEqual(1)
    expect(result.kind).toBe("root")
  })

  test("setFleetModel re-pins a fleet's model (visible in listSessions)", async () => {
    const model = await Effect.runPromise(
      Effect.gen(function* () {
        const ws = yield* build()
        const a = yield* ws.createFleet({ folder: "/tmp/ws/a" })
        yield* ws.setFleetModel(a, "anthropic:claude-sonnet-4-6")
        const sessions = yield* ws.listSessions()
        return sessions.find((s) => s.id === a)?.model
      }).pipe(Effect.provide(env)),
    )
    expect(model).toBe("anthropic:claude-sonnet-4-6")
  })
})
