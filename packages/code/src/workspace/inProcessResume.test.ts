import { describe, expect, test } from "bun:test"
import { Chunk, Effect, Layer, Ref, Stream } from "effect"
import {
  type AgentMessage,
  type ConversationId,
  ApprovalAllowAllLive,
  ConversationStore,
  ConversationNotFound,
  conversationSessionId,
} from "@xandreed/sdk-core"
import { makeInProcessWorkspace } from "./inProcess.js"
import { makeFleetSupervisor } from "../cli/state/fleet.js"
import { FAKE_ROOT_CID, fakeEnvLayersNoConv, fakeRootScope } from "./fakeAppEnv.js"

// Restorability: a daemon that died mid-turn restarts and AUTO-RESUMES it. We
// model that by building the in-process Workspace over a ConversationStore that
// reports a pending in-flight marker + the prompt's history — and assert the
// adapter re-drives the loop on construction and clears the marker.

describe("in-process Workspace — auto-resume in-flight turn", () => {
  test("re-drives a pending turn on build (no new send) and clears the marker", async () => {
    const flags = { cleared: false }
    // A conv pre-seeded with an in-flight prompt + a pending marker for the root.
    const pendingConv = Layer.effect(
      ConversationStore,
      Effect.gen(function* () {
        const msgs = yield* Ref.make<ReadonlyArray<AgentMessage>>([
          { role: "user", content: "the interrupted task" },
        ])
        const pending = yield* Ref.make<string | undefined>("the interrupted task")
        return ConversationStore.of({
          create: () => Effect.succeed(FAKE_ROOT_CID as never),
          ensure: () => Effect.void,
          append: (_id, m) => Ref.update(msgs, (a) => [...a, m]),
          list: () => Ref.get(msgs),
          listActive: () => Ref.get(msgs),
          getLatestCheckpoint: () => Effect.succeed(undefined),
          listCheckpoints: () => Effect.succeed([]),
          checkpoint: () => Effect.void,
          setTitle: () => Effect.fail(new ConversationNotFound({ id: FAKE_ROOT_CID as never })),
          setModel: () => Effect.void,
          listByWorkspace: () => Effect.succeed([]),
          markPending: (_id, p) => Ref.set(pending, p),
          clearPending: () =>
            Effect.sync(() => {
              flags.cleared = true
            }).pipe(Effect.zipRight(Ref.set(pending, undefined))),
          listPending: () =>
            Ref.get(pending).pipe(
              Effect.map((p) =>
                p !== undefined ? [{ id: FAKE_ROOT_CID as ConversationId, prompt: p }] : [],
              ),
            ),
        })
      }),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ws = yield* makeInProcessWorkspace({
          roots: [{ cid: FAKE_ROOT_CID as never }],
          rootScope: fakeRootScope,
          cwd: "/tmp/ws",
          skills: [],
          agents: [],
          tools: [],
          instructionFiles: [],
          approvalLayer: ApprovalAllowAllLive,
          fleet: makeFleetSupervisor(),
        })
        const rootId = conversationSessionId(FAKE_ROOT_CID as never)
        // The auto-resume was forked during build — observe it via the stream.
        const events = yield* ws
          .subscribe(rootId, 0)
          .pipe(
            Stream.takeUntil((e) => e.event.type === "agent_end"),
            Stream.runCollect,
            Effect.timeout("8 seconds"),
          )
        // Settle.
        let spins = 0
        while ((yield* ws.getState(rootId)).busy && spins < 200) {
          yield* Effect.sleep("20 millis")
          spins += 1
        }
        return { types: Chunk.toReadonlyArray(events).map((e) => e.event.type) }
      }).pipe(Effect.provide(Layer.merge(fakeEnvLayersNoConv("resumed!"), pendingConv))),
    )

    // The loop ran without any send — proof the in-flight turn auto-resumed —
    // and the pending marker was cleared (bounded retry).
    expect(result.types).toContain("turn_start")
    expect(result.types).toContain("agent_end")
    expect(flags.cleared).toBe(true)
  })
})
