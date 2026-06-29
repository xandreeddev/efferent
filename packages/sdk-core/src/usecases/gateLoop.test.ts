import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { AgentContextNode, ContextNodeId } from "../entities/AgentContext.js"
import type { ConversationId } from "../entities/Conversation.js"
import type { DeliverableVerdict } from "../entities/Distillation.js"
import { ContextTreeStore } from "../ports/ContextTreeStore.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import { FileSystem } from "../ports/FileSystem.js"
import { UtilityLlm } from "../ports/UtilityLlm.js"
import { type GateInput, Verifier, VerifierError } from "../ports/Verifier.js"
import { GATE_FEEDBACK_PREAMBLE, gateOnce, type GateStep } from "./gateLoop.js"

const CONV = crypto.randomUUID() as ConversationId

const node = (over: Partial<AgentContextNode> = {}): AgentContextNode =>
  ({
    id: crypto.randomUUID() as ContextNodeId,
    parentId: null,
    rootConversationId: CONV,
    edgeKind: "spawned",
    folder: "/ws/pkg",
    displayRoot: "/ws",
    seed: { kind: "task", preview: "t" },
    status: "ok",
    filesChanged: [],
    createdAt: 0,
    ...over,
  }) as AgentContextNode

/** A Verifier whose `gate` returns one scripted verdict (or fails), recording
 *  every call so the test can assert what was judged. `refute` is never used. */
const scriptedVerifier = (
  result: DeliverableVerdict | VerifierError,
  calls: GateInput[],
) =>
  Layer.succeed(
    Verifier,
    Verifier.of({
      refute: () => Effect.die("unused"),
      gate: (input: GateInput) =>
        Effect.sync(() => {
          calls.push(input)
        }).pipe(
          Effect.zipRight(
            result instanceof VerifierError ? Effect.fail(result) : Effect.succeed(result),
          ),
        ),
    } as never),
  )

/** Ports gateOnce names in its `R` only because the distill step *might* run.
 *  With `autoDistill: false` (or the no-gate branches) they're never touched, so
 *  dying stubs both satisfy the types AND prove they weren't called. */
const inertPorts = Layer.mergeAll(
  Layer.succeed(ContextTreeStore, ContextTreeStore.of({} as never)),
  Layer.succeed(ConversationStore, ConversationStore.of({} as never)),
  Layer.succeed(UtilityLlm, UtilityLlm.of({} as never)),
  Layer.succeed(FileSystem, FileSystem.of({} as never)),
)

const run = (
  params: Parameters<typeof gateOnce>[0],
  verdict: DeliverableVerdict | VerifierError,
): Promise<{ step: GateStep; calls: GateInput[] }> => {
  const calls: GateInput[] = []
  return Effect.runPromise(
    gateOnce(params).pipe(
      Effect.provide(Layer.mergeAll(scriptedVerifier(verdict, calls), inertPorts)),
      Effect.map((step) => ({ step, calls })),
    ),
  )
}

const base = {
  task: "ship the rate limiter",
  summary: "added a token-bucket limiter",
  repoDir: "/ws",
  conversationId: CONV,
  attempt: 1,
  maxAttempts: 3,
  autoDistill: false,
}

describe("gateOnce — the shared swarm-gate decision (root + coordinator tiers)", () => {
  test("no fresh sub-agent nodes → no-subagents, the verifier is never called", async () => {
    const { step, calls } = await run(
      { ...base, freshNodes: [] },
      { verdict: "sound", reasons: [] },
    )
    expect(step.kind).toBe("no-subagents")
    expect(calls).toHaveLength(0)
  })

  test("sound → accept; the gate ran once over the deduped union of changed files", async () => {
    const { step, calls } = await run(
      {
        ...base,
        freshNodes: [
          node({ filesChanged: ["a.ts", "b.ts"] }),
          node({ filesChanged: ["b.ts", "c.ts"] }),
        ],
      },
      { verdict: "sound", reasons: [] },
    )
    expect(step.kind).toBe("accept")
    if (step.kind === "accept") {
      expect(step.event.verdict).toBe("sound")
      expect(step.event.attempt).toBe(1)
      expect([...step.event.filesChanged].sort()).toEqual(["a.ts", "b.ts", "c.ts"])
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]?.task).toBe("ship the rate limiter")
    expect(calls[0]?.summary).toBe("added a token-bucket limiter")
  })

  test("needs_work under the attempt cap → retry, with the reasons fed back verbatim", async () => {
    const { step } = await run(
      { ...base, attempt: 1, freshNodes: [node({ filesChanged: ["x.ts"] })] },
      { verdict: "needs_work", reasons: ["missing tests", "no error handling"] },
    )
    expect(step.kind).toBe("retry")
    if (step.kind === "retry") {
      expect(step.event.verdict).toBe("needs_work")
      expect(step.feedback.role).toBe("user")
      const body = String(step.feedback.content)
      expect(body.startsWith(GATE_FEEDBACK_PREAMBLE)).toBe(true)
      expect(body).toContain("- missing tests")
      expect(body).toContain("- no error handling")
    }
  })

  test("needs_work AT the attempt cap → stop (no further retry)", async () => {
    const { step } = await run(
      { ...base, attempt: 3, maxAttempts: 3, freshNodes: [node({ filesChanged: ["x.ts"] })] },
      { verdict: "needs_work", reasons: ["still broken"] },
    )
    expect(step.kind).toBe("stop")
    if (step.kind === "stop") expect(step.event.verdict).toBe("needs_work")
  })

  test("blocked → stop immediately, even below the cap", async () => {
    const { step } = await run(
      { ...base, attempt: 1, freshNodes: [node({ filesChanged: ["x.ts"] })] },
      { verdict: "blocked", reasons: ["needs a human decision"] },
    )
    expect(step.kind).toBe("stop")
    if (step.kind === "stop") expect(step.event.verdict).toBe("blocked")
  })

  test("a verifier error → stop with an `unavailable` verdict (surfaced, never a silent pass)", async () => {
    const { step } = await run(
      { ...base, freshNodes: [node({ filesChanged: ["x.ts"] })] },
      new VerifierError({ message: "no claude binary" }),
    )
    expect(step.kind).toBe("stop")
    if (step.kind === "stop") {
      expect(step.event.verdict).toBe("unavailable")
      expect(step.event.reasons).toEqual(["no claude binary"])
    }
  })
})
