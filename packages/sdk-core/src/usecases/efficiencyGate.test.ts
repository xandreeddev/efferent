import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import type { ConversationId } from "../entities/Conversation.js"
import { ContextTreeStore } from "../ports/ContextTreeStore.js"
import {
  EFFICIENCY_SPAWN_THRESHOLD,
  RESEARCH_BUDGET_SLUG,
  efficiencyConstraint,
  efficiencyGate,
  measureFleetEfficiency,
} from "./efficiencyGate.js"

const cid = "c" as unknown as ConversationId

describe("efficiencyConstraint — the deterministic over-research lesson", () => {
  it("a right-sized run yields no lesson (no noise)", () => {
    expect(efficiencyConstraint({ spawns: 3, tokens: 200_000 }, cid)).toBeNull()
  })

  it("over-spawning yields a research-budget constraint", () => {
    const c = efficiencyConstraint(
      { spawns: EFFICIENCY_SPAWN_THRESHOLD + 4, tokens: 100_000 },
      cid,
    )
    expect(c).not.toBeNull()
    expect(c?.kind).toBe("constraint")
    expect(c?.name).toBe(RESEARCH_BUDGET_SLUG)
    expect(c?.evidence.conversationId).toBe("c")
  })

  it("over-spending yields a constraint even with few spawns", () => {
    expect(efficiencyConstraint({ spawns: 2, tokens: 2_000_000 }, cid)).not.toBeNull()
  })
})

describe("measureFleetEfficiency — sum the context tree", () => {
  const tree = (nodes: ReadonlyArray<{ usage?: { inputTokens: number; outputTokens: number } }>) =>
    Layer.succeed(ContextTreeStore, { listTree: () => Effect.succeed(nodes) } as never)

  it("counts nodes and sums their billed tokens", async () => {
    const eff = await Effect.runPromise(
      measureFleetEfficiency(cid).pipe(
        Effect.provide(
          tree([
            { usage: { inputTokens: 100, outputTokens: 50 } },
            { usage: { inputTokens: 200, outputTokens: 0 } },
            {}, // a node with no recorded usage contributes 0
          ]),
        ),
      ),
    )
    expect(eff.spawns).toBe(3)
    expect(eff.tokens).toBe(350)
  })

  it("a store error degrades to zeros (never breaks the turn)", async () => {
    const failing = Layer.succeed(ContextTreeStore, {
      listTree: () => Effect.fail(new Error("tree down")),
    } as never)
    const eff = await Effect.runPromise(
      measureFleetEfficiency(cid).pipe(Effect.provide(failing)),
    )
    expect(eff).toEqual({ spawns: 0, tokens: 0 })
  })

  it("efficiencyGate ties them together: empty tree → null", async () => {
    const out = await Effect.runPromise(
      efficiencyGate(cid).pipe(
        Effect.provide(Layer.succeed(ContextTreeStore, { listTree: () => Effect.succeed([]) } as never)),
      ),
    )
    expect(out).toBeNull()
  })
})
