import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { AgentContextNode, ContextNodeId } from "../entities/AgentContext.js"
import type { ConversationId } from "../entities/Conversation.js"
import type { DeliverableVerdict } from "../entities/Distillation.js"
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

const run = (
  params: Parameters<typeof gateOnce>[0],
  verdict: DeliverableVerdict | VerifierError,
): Promise<{ step: GateStep; calls: GateInput[] }> => {
  const calls: GateInput[] = []
  return Effect.runPromise(
    gateOnce(params).pipe(
      Effect.provide(scriptedVerifier(verdict, calls)),
      Effect.map((step) => ({ step, calls })),
    ),
  )
}

// gateOnce's R is just `Verifier` now — the in-gate distill (and the ports it
// dragged in) is gone; learning happens once, at the turn boundary.
const base = {
  task: "ship the rate limiter",
  summary: "added a token-bucket limiter",
  repoDir: "/ws",
  attempt: 1,
  maxAttempts: 3,
}

describe("gateOnce — the swarm-gate decision (the ONE root-tier gate)", () => {
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

  test("needs_work on a research/prose deliverable (NO files changed) → stop with advisory notes, NOT retry (even below the cap)", async () => {
    const { step, calls } = await run(
      // freshNodes changed nothing → prose/research: the report IS the deliverable.
      { ...base, attempt: 1, maxAttempts: 3, freshNodes: [node(), node()] },
      { verdict: "needs_work", reasons: ["one source is unverified", "ignores part 2"] },
    )
    expect(step.kind).toBe("stop") // NOT "retry" — no fail-closed loop for prose
    if (step.kind === "stop") {
      expect(step.event.verdict).toBe("needs_work")
      expect(step.event.advisory).toBe(true) // delivered WITH the reviewer's notes
      expect([...step.event.reasons]).toEqual(["one source is unverified", "ignores part 2"])
      expect(step.event.filesChanged).toHaveLength(0)
    }
    expect(calls).toHaveLength(1) // gated once, never re-ran the fleet
  })

  test("blocked on a prose deliverable → stop advisory (delivered, not re-run)", async () => {
    const { step } = await run(
      { ...base, attempt: 1, freshNodes: [node()] },
      { verdict: "blocked", reasons: ["the question is contradictory"] },
    )
    expect(step.kind).toBe("stop")
    if (step.kind === "stop") {
      expect(step.event.verdict).toBe("blocked")
      expect(step.event.advisory).toBe(true)
    }
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
