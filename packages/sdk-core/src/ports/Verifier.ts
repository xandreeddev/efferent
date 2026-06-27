import { Context, Data, type Effect } from "effect"
import type {
  Candidate,
  DeliverableVerdict,
  Verdict,
} from "../entities/Distillation.js"

/** The verify gate could not produce a verdict (no `claude` binary, a non-zero
 *  exit, unparseable output). The orchestrator treats this as a **reject** —
 *  fail-closed: an unverifiable candidate is never persisted. */
export class VerifierError extends Data.TaggedError("VerifierError")<{
  readonly message: string
}> {}

export interface VerifyContext {
  /** Repo dir the verifier inspects + grounds against (the gate runs here, so it
   *  can read the files / grep / run the cited test, not just judge text). */
  readonly repoDir: string
  /** Names already in the skill/memory/constraint library — for the
   *  non-redundancy check. */
  readonly existing: ReadonlyArray<string>
}

/** Input to the **deliverable gate** ({@link Verifier.gate}) — the swarm's output
 *  to validate against the task it was given. */
export interface GateInput {
  /** What the swarm was asked to do (the brief / spec). */
  readonly task: string
  /** What it claims it did (the coordinator's summary of the deliverable). */
  readonly summary: string
  /** Files the swarm changed — the gate reads them in the repo to verify. */
  readonly filesChanged: ReadonlyArray<string>
  /** Repo dir the gate runs in, so Opus checks against ground truth. */
  readonly repoDir: string
}

/**
 * The **closer** — the self-improving loop's single verify gate
 * (`docs/self-improving-loop.md`). Its only job is to *refute*: given a
 * candidate learning + its evidence, decide whether it's true, general,
 * non-redundant, safe, and worth saving. The default adapter
 * (`ClaudeHeadlessVerifierLive`) runs Opus via the real `claude` headless CLI
 * **in the repo dir**, so the model checks against ground truth and the
 * subscription rate applies — a separate process the engine can't bias.
 */
export class Verifier extends Context.Tag("@xandreed/sdk-core/Verifier")<
  Verifier,
  {
    /**
     * The **learning gate**: refute a candidate skill/constraint/memory before it
     * enters the library. Fail-CLOSED — an error means the orchestrator drops the
     * candidate (never persist the unverified). Drives `runDistillation`.
     */
    readonly refute: (
      candidate: Candidate,
      ctx: VerifyContext,
    ) => Effect.Effect<Verdict, VerifierError>
    /**
     * The **deliverable gate**: Opus *validates the task output* (SOUND / NEEDS
     * WORK / BLOCKED) and is the final sign-off that drives the retry loop. Opus
     * only judges — it never edits. Fail-SOFT at the call site: a missing `claude`
     * / error returns a `VerifierError` the coordinator catches and falls back to
     * the Kimi architect's verdict, so a broken gate never blocks the user's task.
     */
    readonly gate: (
      input: GateInput,
    ) => Effect.Effect<DeliverableVerdict, VerifierError>
  }
>() {}
