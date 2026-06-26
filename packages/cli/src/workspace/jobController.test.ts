import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import {
  ApprovalAllowAllLive,
  type ContextNodeId,
  type ConversationId,
  type Job,
  type ScopeRuntime,
  SettingsStore,
  UtilityLlm,
} from "@xandreed/sdk-core"
import { makeJobController } from "./inProcess.js"

const cid = "33333333-3333-3333-3333-333333333333" as ConversationId

// A stub `spawnAgent` that captures the args the router hands it, then succeeds.
type SpawnArgs = Parameters<ScopeRuntime["spawnAgent"]>[0]
const captureRuntime = (sink: { args?: SpawnArgs }): Pick<ScopeRuntime, "spawnAgent"> => ({
  spawnAgent: (args) =>
    Effect.sync(() => void (sink.args = args)).pipe(
      Effect.as({
        summary: "ok",
        filesChanged: [] as ReadonlyArray<string>,
        nodeId: "44444444-4444-4444-4444-444444444444" as ContextNodeId,
      }),
    ) as ReturnType<ScopeRuntime["spawnAgent"]>,
})

// The router provides its `scheduledApproval` over the spawn; an allow-all + a
// no-op UtilityLlm/SettingsStore satisfy the layer's requirements for the test.
const env = Layer.mergeAll(
  ApprovalAllowAllLive,
  Layer.succeed(SettingsStore, SettingsStore.of({} as never)),
  Layer.succeed(UtilityLlm, UtilityLlm.of({} as never)),
)

describe("JobController.submitJob — routing + consistent policy/mission", () => {
  test("a SCHEDULED job → spawnAgent with mission = prompt AND interactionPolicy = headless", async () => {
    const sink: { args?: SpawnArgs } = {}
    const controller = makeJobController({
      runtime: captureRuntime(sink),
      // Reuse allow-all as the (provided) scheduled approval layer for the test.
      scheduledApproval: ApprovalAllowAllLive as never,
    })
    const job: Job = {
      conversationId: cid,
      source: "scheduled",
      interactionPolicy: "headless",
      folder: "pkg",
      prompt: "run the nightly review",
      agent: "reviewer",
      title: "scheduled: nightly",
    }

    const out = await Effect.runPromise(
      controller.submitJob(job).pipe(Effect.provide(env)) as unknown as Effect.Effect<{
        conversationId: ConversationId
        nodeId?: ContextNodeId
      }>,
    )

    // The router seeded mission + headless on the spawn (the central fix) and
    // forwarded the rest verbatim.
    expect(sink.args?.mission).toBe("run the nightly review")
    expect(sink.args?.interactionPolicy).toBe("headless")
    expect(sink.args?.rootConversationId).toBe(cid)
    expect(sink.args?.folder).toBe("pkg")
    expect(sink.args?.task).toBe("run the nightly review")
    expect(sink.args?.agent).toBe("reviewer")
    expect(sink.args?.title).toBe("scheduled: nightly")
    expect(out.conversationId).toBe(cid)
    expect(out.nodeId).toBe("44444444-4444-4444-4444-444444444444" as ContextNodeId)
  })

  test("an INTERACTIVE job → delegates to `send` (NOT spawnAgent), interactive policy preserved by the caller", async () => {
    const sink: { args?: SpawnArgs } = {}
    const sent: Array<{ cid: ConversationId; prompt: string }> = []
    const controller = makeJobController({
      runtime: captureRuntime(sink),
      scheduledApproval: ApprovalAllowAllLive as never,
      send: (c, p) => Effect.sync(() => void sent.push({ cid: c, prompt: p })),
    })
    const job: Job = {
      conversationId: cid,
      source: "interactive",
      interactionPolicy: "interactive",
      folder: ".",
      prompt: "hello there",
    }

    const out = await Effect.runPromise(
      controller.submitJob(job).pipe(Effect.provide(env)) as unknown as Effect.Effect<{
        conversationId: ConversationId
      }>,
    )

    // It went through send, never the scheduled spawn.
    expect(sent).toEqual([{ cid, prompt: "hello there" }])
    expect(sink.args).toBeUndefined()
    expect(out.conversationId).toBe(cid)
  })

  test("a QUEUED job also routes to `send` (same interactive path)", async () => {
    const sent: Array<string> = []
    const controller = makeJobController({
      runtime: captureRuntime({}),
      scheduledApproval: ApprovalAllowAllLive as never,
      send: (_c, p) => Effect.sync(() => void sent.push(p)),
    })
    await Effect.runPromise(
      controller
        .submitJob({
          conversationId: cid,
          source: "queued",
          interactionPolicy: "interactive",
          folder: ".",
          prompt: "queued one",
        })
        .pipe(Effect.provide(env)) as unknown as Effect.Effect<unknown>,
    )
    expect(sent).toEqual(["queued one"])
  })
})
