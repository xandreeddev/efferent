import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { LanguageModel, type Toolkit } from "@effect/ai"
import type { AgentContextNode, ContextNodeId } from "../entities/AgentContext.js"
import type { AgentMessage, ConversationId } from "../entities/Conversation.js"
import type { DeliverableVerdict } from "../entities/Distillation.js"
import type { AgentGateEvent, AgentHooks } from "../entities/AgentHooks.js"
import type { Prompt } from "../entities/Prompt.js"
import { ContextTreeStore } from "../ports/ContextTreeStore.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import { FileSystem } from "../ports/FileSystem.js"
import { SettingsStore } from "../ports/SettingsStore.js"
import { UtilityLlm } from "../ports/UtilityLlm.js"
import { Verifier, VerifierError } from "../ports/Verifier.js"
import type { AgentConfig } from "./agentConfig.js"
import { runAgent } from "./runAgent.js"

/**
 * The mandatory swarm gate (`driveLoop` in runAgent.ts) is the self-improving
 * loop's enforcement point: if a run used sub-agents, the deliverable MUST go
 * through the Opus gate before the run is done — and on `needs_work` it retries.
 * These tests prove that structurally, with a fake model/verifier/tree, so no
 * `claude` and no real LLM are needed.
 */

/** Model that always ends a turn immediately (no tool calls); counts attempts. */
const recordingModel = () => {
  let n = 0
  const layer = Layer.succeed(
    LanguageModel.LanguageModel,
    LanguageModel.LanguageModel.of({
      generateText: () =>
        Effect.sync(() => {
          n += 1
          return { content: [], text: "done", finishReason: "stop", usage: undefined }
        }),
      generateObject: () => Effect.die("unused"),
      streamText: () => Effect.die("unused"),
    } as never),
  )
  return { layer, attempts: () => n }
}

const trivialToolkit = Effect.succeed({
  tools: {},
  handle: () => Effect.die("no tools"),
}) as unknown as Toolkit.Toolkit<Record<string, never>>

const prompt: Prompt = { name: "test", version: "1", text: "system" }
const config: AgentConfig<Record<string, never>> = {
  key: "test",
  prompt,
  toolkit: trivialToolkit,
}
const cid = "conv-1" as unknown as ConversationId

/** In-memory ConversationStore — only the methods runAgent/driveLoop touch. */
const convStore = () => {
  let pos = -1
  return Layer.succeed(ConversationStore, {
    ensure: () => Effect.void,
    getLatestCheckpoint: () => Effect.succeed(undefined),
    listActive: () => Effect.succeed([] as ReadonlyArray<AgentMessage>),
    list: () => Effect.succeed([] as ReadonlyArray<AgentMessage>),
    append: () => Effect.sync(() => (pos += 1)),
    markPending: () => Effect.void,
    clearPending: () => Effect.void,
  } as never)
}

/** A tree that reports NO nodes before the run and `nodes` afterward — emulating
 *  a run that spawned sub-agents. The first `listTree` (driveLoop's before-snapshot)
 *  sees nothing; later ones (the settle/gate) see the fresh, terminal nodes. */
const treeThatSpawns = (nodes: ReadonlyArray<{ id: string; files: ReadonlyArray<string> }>) => {
  let seen = 0
  const materialized = nodes.map(
    (n) =>
      ({ id: n.id, status: "ok", filesChanged: n.files }) as unknown as AgentContextNode,
  )
  return Layer.succeed(ContextTreeStore, {
    listTree: () =>
      Effect.sync(() => {
        const r = seen === 0 ? ([] as ReadonlyArray<AgentContextNode>) : materialized
        seen += 1
        return r
      }),
  } as never)
}

/** Tree that never spawns anything (the no-sub-agent / non-swarm case). */
const emptyTree = Layer.succeed(ContextTreeStore, {
  listTree: () => Effect.succeed([] as ReadonlyArray<AgentContextNode>),
} as never)

const settings = (over: Record<string, unknown> = {}) =>
  Layer.succeed(SettingsStore, {
    get: () => Effect.succeed({ model: "test:model", autoDistill: false, ...over }),
  } as never)

/** Verifier that returns the scripted verdicts in order (repeating the last). */
const recordingVerifier = (verdicts: ReadonlyArray<DeliverableVerdict | "unavailable">) => {
  const calls: unknown[] = []
  let i = 0
  const layer = Layer.succeed(Verifier, {
    refute: () => Effect.die("refute unused"),
    gate: (input: unknown) => {
      calls.push(input)
      const v = verdicts[Math.min(i, verdicts.length - 1)]
      i += 1
      return v === "unavailable"
        ? Effect.fail(new VerifierError({ message: "no claude" }))
        : Effect.succeed(v)
    },
  } as never)
  return { layer, gateCalls: () => calls.length }
}

const utilDies = Layer.succeed(UtilityLlm, { complete: () => Effect.die("util unused") } as never)
const fsDies = Layer.succeed(FileSystem, { write: () => Effect.die("fs unused") } as never)

const run = (args: {
  tree: Layer.Layer<ContextTreeStore>
  verdicts: ReadonlyArray<DeliverableVerdict | "unavailable">
  maxLoopAttempts?: number
}) => {
  const model = recordingModel()
  const verifier = recordingVerifier(args.verdicts)
  const events: AgentGateEvent[] = []
  const hooks: AgentHooks = {
    onGateResult: (e) => Effect.sync(() => events.push(e)),
  }
  const layers = Layer.mergeAll(
    model.layer,
    convStore(),
    args.tree,
    verifier.layer,
    settings(args.maxLoopAttempts !== undefined ? { maxLoopAttempts: args.maxLoopAttempts } : {}),
    utilDies,
    fsDies,
  )
  const program = runAgent(config, cid, "do it", hooks, "/repo").pipe(
    Effect.provide(layers),
  ) as unknown as Effect.Effect<unknown>
  return Effect.runPromise(program).then(() => ({
    attempts: model.attempts(),
    gateCalls: verifier.gateCalls(),
    events,
  }))
}

const sound: DeliverableVerdict = { verdict: "sound", reasons: [] }
const needsWork: DeliverableVerdict = { verdict: "needs_work", reasons: ["fix it"] }
const oneNode = [{ id: "n1", files: ["a.txt"] }]

describe("driveLoop — mandatory swarm gate", () => {
  it("does NOT gate a run that used no sub-agents", async () => {
    const r = await run({ tree: emptyTree, verdicts: [sound] })
    expect(r.gateCalls).toBe(0)
    expect(r.attempts).toBe(1)
    expect(r.events).toEqual([])
  })

  it("gates exactly once when sub-agents were used and the verdict is sound", async () => {
    const r = await run({ tree: treeThatSpawns(oneNode), verdicts: [sound] })
    expect(r.gateCalls).toBe(1)
    expect(r.attempts).toBe(1) // no retry on sound
    expect(r.events.map((e) => e.verdict)).toEqual(["sound"])
  })

  it("needs_work → LEARN/RUN-AGAIN → re-gate until sound", async () => {
    const r = await run({ tree: treeThatSpawns(oneNode), verdicts: [needsWork, sound] })
    expect(r.gateCalls).toBe(2)
    expect(r.attempts).toBe(2) // the loop re-ran with the gate's feedback
    expect(r.events.map((e) => e.verdict)).toEqual(["needs_work", "sound"])
  })

  it("stops retrying at maxLoopAttempts when the gate keeps rejecting", async () => {
    const r = await run({
      tree: treeThatSpawns(oneNode),
      verdicts: [needsWork],
      maxLoopAttempts: 2,
    })
    expect(r.gateCalls).toBe(2)
    expect(r.attempts).toBe(2)
    expect(r.events.map((e) => e.verdict)).toEqual(["needs_work", "needs_work"])
  })

  it("surfaces an unavailable verifier loudly and does not loop forever", async () => {
    const r = await run({ tree: treeThatSpawns(oneNode), verdicts: ["unavailable"] })
    expect(r.gateCalls).toBe(1)
    expect(r.attempts).toBe(1)
    expect(r.events.map((e) => e.verdict)).toEqual(["unavailable"])
  })
})
