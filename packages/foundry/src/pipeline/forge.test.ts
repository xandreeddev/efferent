import { describe, expect, test } from "bun:test"
import { Array as Arr, Effect, Layer, Option, Ref } from "effect"
import { GateName, RuleId, WorkspacePath } from "../domain/Brands.js"
import { WorkspaceError } from "../domain/Errors.js"
import { Finding } from "../domain/Finding.js"
import { ForgeLimits, Spec } from "../domain/Spec.js"
import type { Gate, Workspace } from "../ports/Gate.js"
import { Implementor } from "../ports/Implementor.js"
import { RunSink } from "../ports/RunSink.js"
import { forge } from "./forge.js"

const ws: Workspace = { rootDir: "/tmp/x", files: [] }

const spec = (maxAttempts: number) =>
  new Spec({
    goal: "implement stringStats",
    acceptance: ["longest returns Option<string>"],
    limits: new ForgeLimits({ maxAttempts, budgetMillis: 60_000 }),
  })

const noLetFinding = new Finding({
  rule: RuleId.make("effect/no-let"),
  severity: "error",
  message: "`let` is banned; fold state instead",
  location: Option.none(),
  fixHint: Option.some("use Effect.iterate or Array combinators"),
})

/** Records every brief it was handed; writes nothing (the fake gate below is
 *  keyed on the attempt counter instead). */
const recordingImplementor = (briefs: Ref.Ref<ReadonlyArray<Option.Option<string>>>) =>
  Layer.succeed(Implementor, {
    implement: (input) =>
      Ref.update(briefs, (all) => [...all, input.feedback]).pipe(
        Effect.as({ filesTouched: [WorkspacePath.make("src/stringStats.ts")] }),
      ),
  })

/** Fails with `noLetFinding` until the workspace has been "fixed" (call N). */
const failingUntil = (green: number, calls: Ref.Ref<number>): Gate<never> => ({
  name: GateName.make("effect-idioms"),
  kind: "static",
  deterministic: true,
  run: () =>
    Ref.updateAndGet(calls, (n) => n + 1).pipe(
      Effect.map((call) => (call >= green ? [] : [noLetFinding])),
    ),
})

/** Records `path → outcome tag` per persist call — the upsert story. */
const memorySink = (writes: Ref.Ref<ReadonlyArray<{ path: string; outcome: string }>>) =>
  Layer.succeed(RunSink, {
    persist: (run) =>
      Ref.update(writes, (all) => [
        ...all,
        { path: `.foundry/runs/${run.id}.json`, outcome: run.outcome._tag },
      ]).pipe(Effect.as(`.foundry/runs/${run.id}.json`)),
  })

describe("forge — the factory loop", () => {
  test("fails once, reads the feedback, passes on attempt 2", async () => {
    const program = Effect.gen(function* () {
      const briefs = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([])
      const calls = yield* Ref.make(0)
      const writes = yield* Ref.make<ReadonlyArray<{ path: string; outcome: string }>>([])
      const result = yield* forge({
        spec: spec(3),
        pipeline: { gates: Arr.of(failingUntil(2, calls)), policy: "staged" },
        workspaceDir: "/tmp/x",
        snapshot: Effect.succeed(ws),
      }).pipe(
        Effect.provide(Layer.mergeAll(recordingImplementor(briefs), memorySink(writes))),
      )
      return { result, briefs: yield* Ref.get(briefs), writes: yield* Ref.get(writes) }
    })
    const { result, briefs, writes } = await Effect.runPromise(program)

    expect(result.run.outcome._tag).toBe("accepted")
    expect(result.run.attempts.length).toBe(2)
    // Attempt 1 got no feedback; attempt 2 got attempt 1's rendered findings.
    expect(Option.isNone(briefs[0]!)).toBe(true)
    const second = briefs[1]!
    expect(Option.isSome(second)).toBe(true)
    expect(Option.getOrThrow(second)).toContain("effect/no-let")
    expect(Option.getOrThrow(second)).toContain("rejected attempt 1")
    // INCREMENTAL persistence: every attempt upserts the SAME artifact as
    // in-flight; the final strict persist overwrites with the real outcome.
    expect(writes.map((w) => w.outcome)).toEqual(["in-flight", "in-flight", "accepted"])
    expect(new Set(writes.map((w) => w.path)).size).toBe(1)
    expect(writes[writes.length - 1]!.path).toBe(result.artifact)
  })

  test("a mid-run sink failure never kills the run; the final persist stays strict", async () => {
    const flakySink = (attempted: Ref.Ref<number>) =>
      Layer.succeed(RunSink, {
        persist: (run) =>
          Ref.updateAndGet(attempted, (n) => n + 1).pipe(
            Effect.flatMap((n) =>
              run.outcome._tag === "in-flight"
                ? Effect.fail(new WorkspaceError({ message: `disk full (write ${n})` }))
                : Effect.succeed(`.foundry/runs/${run.id}.json`),
            ),
          ),
      })
    const program = Effect.gen(function* () {
      const briefs = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([])
      const calls = yield* Ref.make(0)
      const attempted = yield* Ref.make(0)
      const result = yield* forge({
        spec: spec(3),
        pipeline: { gates: Arr.of(failingUntil(2, calls)), policy: "staged" },
        workspaceDir: "/tmp/x",
        snapshot: Effect.succeed(ws),
      }).pipe(Effect.provide(Layer.mergeAll(recordingImplementor(briefs), flakySink(attempted))))
      return { result, attempted: yield* Ref.get(attempted) }
    })
    const { result, attempted } = await Effect.runPromise(program)
    expect(result.run.outcome._tag).toBe("accepted")
    expect(attempted).toBe(3) // 2 refused partials + the strict final
  })

  test("attempts-exhausted: a never-green pipeline stops at the cap with every report intact", async () => {
    const program = Effect.gen(function* () {
      const briefs = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([])
      const calls = yield* Ref.make(0)
      const writes = yield* Ref.make<ReadonlyArray<{ path: string; outcome: string }>>([])
      return yield* forge({
        spec: spec(2),
        pipeline: { gates: Arr.of(failingUntil(99, calls)), policy: "staged" },
        workspaceDir: "/tmp/x",
        snapshot: Effect.succeed(ws),
      }).pipe(
        Effect.provide(Layer.mergeAll(recordingImplementor(briefs), memorySink(writes))),
      )
    })
    const result = await Effect.runPromise(program)

    expect(result.run.outcome).toEqual({ _tag: "rejected", reason: "attempts-exhausted" })
    expect(result.run.attempts.length).toBe(2)
    // Both reports are preserved; the final attempt carries no feedback (no next attempt).
    expect(result.run.attempts.every((a) => !a.report.ok)).toBe(true)
    expect(Option.isNone(result.run.attempts[1]!.feedback)).toBe(true)
  })

  test("stalled: two consecutive no-op attempts on an identical verdict stop the loop early", async () => {
    // The zig-run failure class: an environment-level red the coder cannot
    // move. ONE no-op repeat is tolerated (a model can pause an attempt,
    // and recurrence-lessons need a repeat) — the SECOND identical no-op is
    // confirmed immobility; the remaining attempts are NOT spent.
    const writeOnceImplementor = Layer.succeed(Implementor, {
      implement: (input) =>
        Effect.succeed({
          filesTouched:
            input.attempt === 1 ? [WorkspacePath.make("zig/build.zig")] : [],
        }),
    })
    const program = Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const writes = yield* Ref.make<ReadonlyArray<{ path: string; outcome: string }>>([])
      return yield* forge({
        spec: spec(5),
        pipeline: { gates: Arr.of(failingUntil(99, calls)), policy: "staged" },
        workspaceDir: "/tmp/x",
        snapshot: Effect.succeed(ws),
      }).pipe(Effect.provide(Layer.mergeAll(writeOnceImplementor, memorySink(writes))))
    })
    const result = await Effect.runPromise(program)

    expect(result.run.outcome).toEqual({ _tag: "rejected", reason: "stalled" })
    // Attempts 4 and 5 were never spent — the breaker fired on attempt 3
    // (attempt 2 = tolerated first repeat; attempt 3 = confirmation).
    expect(result.run.attempts.length).toBe(3)
    expect(Option.isNone(result.run.attempts[2]!.feedback)).toBe(true)
  })

  test("hooks fire in loop order at every seam", async () => {
    const program = Effect.gen(function* () {
      const briefs = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([])
      const calls = yield* Ref.make(0)
      const writes = yield* Ref.make<ReadonlyArray<{ path: string; outcome: string }>>([])
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (entry: string) => Ref.update(seen, (all) => [...all, entry])
      yield* forge({
        spec: spec(3),
        pipeline: { gates: Arr.of(failingUntil(2, calls)), policy: "staged" },
        workspaceDir: "/tmp/x",
        snapshot: Effect.succeed(ws),
        hooks: {
          onAttemptStart: (attempt) => note(`start:${attempt}`),
          onImplemented: (attempt, receipt) =>
            note(`impl:${attempt}:${receipt.filesTouched.length}`),
          onReport: (attempt, report, feedback) =>
            note(`report:${attempt}:${report.ok ? "ok" : "fail"}:${Option.isSome(feedback) ? "brief" : "none"}`),
          onOutcome: (run) => note(`outcome:${run.outcome._tag}`),
        },
      }).pipe(
        Effect.provide(Layer.mergeAll(recordingImplementor(briefs), memorySink(writes))),
      )
      return yield* Ref.get(seen)
    })
    const seen = await Effect.runPromise(program)

    expect(seen).toEqual([
      "start:1",
      "impl:1:1",
      "report:1:fail:brief",
      "start:2",
      "impl:2:1",
      "report:2:ok:none",
      "outcome:accepted",
    ])
  })

  test("the implementor's ref threads into each attempt record", async () => {
    const refImplementor = Layer.succeed(Implementor, {
      implement: () =>
        Effect.succeed({
          filesTouched: [WorkspacePath.make("src/stringStats.ts")],
          ref: Option.some("conversation:abc-123"),
        }),
    })
    const program = Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const writes = yield* Ref.make<ReadonlyArray<{ path: string; outcome: string }>>([])
      return yield* forge({
        spec: spec(2),
        pipeline: { gates: Arr.of(failingUntil(2, calls)), policy: "staged" },
        workspaceDir: "/tmp/x",
        snapshot: Effect.succeed(ws),
      }).pipe(Effect.provide(Layer.mergeAll(refImplementor, memorySink(writes))))
    })
    const result = await Effect.runPromise(program)

    expect(result.run.attempts.length).toBe(2)
    expect(
      result.run.attempts.map((a) => Option.getOrNull(a.implementorRef)),
    ).toEqual(["conversation:abc-123", "conversation:abc-123"])
    // A receipt without a ref (the recording implementor) stays None — covered
    // by the first test's artifact via the same decode path.
  })
})
