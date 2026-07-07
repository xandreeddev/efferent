import { Clock, Effect } from "effect"
import type { AgentHooks } from "../entities/AgentHooks.js"
import type { AgentResult } from "../entities/Conversation.js"
import { inboxToMessages } from "./agentBus.js"
import type { AgentBus } from "./agentBus.js"

/**
 * **Headless fleet completion** — make one-shot drivers (`-p` / `--json` / a
 * forge attempt) wait for an outstanding fleet and deliver its result.
 *
 * The root delegates **non-blocking** by design (it spawns, acknowledges, and
 * ends its turn, expecting to relay results at the *next* turn — great
 * interactively). In a one-shot headless run there is no next turn, so the
 * background fleet would be abandoned and the answer lost. This automates what a
 * human does interactively: after a turn, if the root left agents running, block
 * until the fleet goes idle, then give the root another turn to gather its inbox
 * and synthesize — looping until nothing is outstanding (or a round cap).
 *
 * Two requirements the caller must honour:
 * 1. The service layers (handler layer / Approval) must be provided
 *    **around this whole call**, NOT per turn — the fleet's forked fibers
 *    keep running between turns and need those layers alive.
 * 2. `runTurn` must use hooks wrapped with {@link withInboxDrain} so a synthesis
 *    turn actually sees the fleet's completions.
 */

const MAX_SYNTHESIS_ROUNDS = 10
/** Idle ceiling per wait; the bus wakes instantly on real progress, so this just
 *  bounds a stuck wait (the loop re-checks `childrenOf` and waits again). */
const FLEET_WAIT_TIMEOUT_MS = 30_000
/** Wall-clock deadline for the WHOLE headless run. A one-shot `-p`/`--json` must
 *  terminate with a deliverable; a fleet that won't converge (some models
 *  over-research) is cut off here and the root synthesizes from partial results.
 *  Override with `EFFERENT_FLEET_DEADLINE_MS`; genuine long-running work belongs
 *  in the daemon/TUI, not one-shot headless. 20 min — the old 6 min could not
 *  fit a real multi-agent fleet, so the deadline routinely mass-killed healthy
 *  cohorts mid-work (13/13 nodes `[interrupted]` in the run forensics). */
const DEFAULT_DEADLINE_MS = 20 * 60_000

const deadlineMs = (): number => {
  const raw = Number(process.env["EFFERENT_FLEET_DEADLINE_MS"])
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEADLINE_MS
}

const CONTINUE_PROMPT =
  "[The background agents you spawned have now finished — their results are in the conversation above. " +
  "Gather them and complete the ORIGINAL request: deliver the final, synthesized answer. " +
  "If a piece genuinely still needs doing, do it; otherwise give the complete final response now. " +
  "Do NOT spawn agents just to re-check work that already finished.]"

const FINALIZE_PROMPT =
  "[The background agents were taking too long and have been STOPPED. Do NOT spawn any more agents. " +
  "Deliver the best answer you can RIGHT NOW from the partial results in the conversation above and the " +
  "blackboard (blackboard_read), and state plainly what is incomplete or unverified.]"

/** Drain the root's fleet inbox into the prompt at each turn boundary, so a
 *  synthesis turn sees the completions (mirrors the interactive `submit.ts` path). */
export const withInboxDrain = <R>(
  base: AgentHooks<R>,
  bus: AgentBus,
  rootKey: string,
): AgentHooks<R> => ({
  ...base,
  onTransformContext: (messages) =>
    Effect.gen(function* () {
      const inbox = yield* bus.drain(rootKey)
      return inbox.length === 0 ? messages : [...messages, ...inboxToMessages(inbox)]
    }),
})

/** Block until no agents the root spawned are still running, OR `budgetMs`
 *  elapses. Returns `true` if the fleet went idle, `false` on the deadline. */
const waitFleetIdle = (
  bus: AgentBus,
  rootKey: string,
  budgetMs: number,
): Effect.Effect<boolean> => {
  const poll = (start: number): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const running = yield* bus.runningChildrenOf(rootKey)
      if (running.length === 0) return true
      const elapsed = (yield* Clock.currentTimeMillis) - start
      if (elapsed >= budgetMs) return false
      yield* bus.awaitChange({
        waiterKey: rootKey,
        watch: running,
        timeoutMs: Math.min(FLEET_WAIT_TIMEOUT_MS, budgetMs - elapsed),
      })
      return yield* poll(start)
    })
  return Effect.flatMap(Clock.currentTimeMillis, poll)
}

interface FleetLoopState {
  readonly result: AgentResult
  readonly rounds: number
  readonly done: boolean
}

export const runFleetToCompletion = <R>(args: {
  readonly bus: AgentBus
  /** The root's bus key — its `conversationId` (as a string). */
  readonly rootKey: string
  readonly firstPrompt: string
  /** One root turn, already error-handled (so a failed turn can't break the loop). */
  readonly runTurn: (prompt: string) => Effect.Effect<AgentResult, never, R>
}): Effect.Effect<AgentResult, never, R> =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis
    const deadline = deadlineMs()
    const first = yield* args.runTurn(args.firstPrompt)
    const final = yield* Effect.iterate(
      { result: first, rounds: 0, done: false } as FleetLoopState,
      {
        while: (state) => !state.done && state.rounds < MAX_SYNTHESIS_ROUNDS,
        body: (state) =>
          Effect.gen(function* () {
            const running = yield* args.bus.runningChildrenOf(args.rootKey)
            // No outstanding fleet — the run is complete.
            if (running.length === 0) return { ...state, done: true }
            const remaining = deadline - ((yield* Clock.currentTimeMillis) - start)
            const idled =
              remaining > 0
                ? yield* waitFleetIdle(args.bus, args.rootKey, remaining)
                : false
            if (!idled) {
              // Deadline hit: stop THIS run's fleet — the root's own subtree,
              // never the whole bus — and force one synthesis from whatever
              // finished (interrupted children record their return + post to the
              // root's inbox, which the synthesis turn drains). `interruptAll`
              // here once killed every fleet on the bus, including other runs'
              // healthy agents.
              yield* args.bus.interruptSubtree(args.rootKey, "deadline")
              const result = yield* args.runTurn(FINALIZE_PROMPT)
              return { result, rounds: state.rounds, done: true }
            }
            const result = yield* args.runTurn(CONTINUE_PROMPT)
            return { result, rounds: state.rounds + 1, done: false }
          }),
      },
    )
    return final.result
  })
