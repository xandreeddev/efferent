import { Effect, Option, Ref, Schema } from "effect"
import type { Context, Scope } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect, freshId, pixelPng } from "../conformance.functions.js"
import { mediaFromBase64 } from "../domain/media.entity.functions.js"
import { RunId } from "../domain/run.entity.js"
import { HarnessError } from "../harness/plugin.entity.js"
import { entryId } from "../memory/memory-log.entity.functions.js"
import type { InboxRunner } from "../ports/inbox-runner.port.js"
import type { TurnWriter } from "../ports/sessions.port.js"
import type { TurnOutcome } from "../ports/turn.port.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { TurnStartedData } from "./session-event.entity.js"
import { InboxItemId } from "./sessions.entity.js"
import type { AdmittedTurn, TurnError } from "./sessions.entity.js"

/**
 * Opens the runner around an injected execution body. A composed adapter can
 * supply a TurnRunner whose prebegun path calls use(input.turn), proving the
 * bridge without depending on a model or a particular SDK in this kit.
 */
export interface InboxRunnerSubject {
  readonly open: (options: {
    readonly use: (writer: TurnWriter) => Effect.Effect<TurnOutcome, TurnError>
  }) => Effect.Effect<Context.Service.Shape<typeof InboxRunner>, unknown, Scope.Scope>
}

const fixture = (owner: string) => Effect.gen(function* () {
  const session = { id: yield* freshId, owner }
  const runId = RunId.make(`runner-${session.id}`)
  const image = yield* mediaFromBase64(pixelPng, { name: "queued.png", alt: "queued attachment" })
  const userMessage = new UserMessage({ text: "answer the queued user", attachments: [image] })
  const input = { id: InboxItemId.make("runner-kit"), userMessage, delivery: "next" as const, source: { kind: "kit" } }
  const admitted: AdmittedTurn = {
    session, turn: 7, runId, key: "input:runner-kit", origin: "user", userMessage,
    command: {}, claimed: [], meta: { runner: "kit" },
    input,
  }
  const data = yield* Schema.encodeEffect(TurnStartedData)({
    runId, key: admitted.key, origin: admitted.origin, userMessage, command: {}, claimed: [],
    input: input.id, entry: entryId(runId, 0), at: 1, meta: admitted.meta,
  })
  const ends = yield* Ref.make(0)
  const writer: TurnWriter = {
    admitted, started: { session: session.id, turn: Option.some(7), seq: 1, at: 1, kind: "turn.started", data },
    history: () => Effect.succeed([]), snapshot: () => Effect.succeed([]),
    steers: Effect.succeed([]), take: () => Effect.succeed(false),
    append: () => Effect.void, write: (op) => op,
    transact: (decide) => decide([]).pipe(Effect.map((decision) => ({ result: decision.result, events: [] }))),
    flush: Effect.void, closing: () => Effect.void,
    end: () => Ref.update(ends, (n) => n + 1).pipe(Effect.as({ pending: 0 })), closed: Effect.never,
  }
  return { writer, ends }
})

/** The prebegun runner bridge: exact writer, outcomes, errors and caller-owned lifetime. */
export const inboxRunnerConformance = (subject: InboxRunnerSubject): ReadonlyArray<ConformanceCheck> => [
  check("the runner executes the exact borrowed writer once, preserving queued user input and media", "borrowed-writer", (owner) => Effect.scoped(Effect.gen(function* () {
    const { writer } = yield* fixture(owner)
    const seen = yield* Ref.make<ReadonlyArray<TurnWriter>>([])
    const runner = yield* subject.open({ use: (received) => Ref.update(seen, (all) => [...all, received]).pipe(Effect.as({ outcome: "completed", reply: Option.none() })) })
    yield* runner.run(writer)
    const received = yield* Ref.get(seen)
    yield* expect("borrowed-writer", received.length === 1 && received[0] === writer && received[0].admitted === writer.admitted,
      "the runner did not execute the same prebegun writer exactly once")
    yield* expect("borrowed-writer", writer.admitted.origin === "user" && writer.admitted.claimed.length === 0
      && writer.admitted.input?.userMessage === writer.admitted.userMessage && writer.admitted.userMessage.attachments?.[0]?.data === pixelPng,
      "the borrowed writer's queued input, origin or attachment changed")
  }))),

  check("the runner preserves completed, partial, failed and waiting outcomes and their replies", "outcome", (owner) => Effect.scoped(Effect.gen(function* () {
    const { writer } = yield* fixture(owner)
    yield* Effect.forEach(["completed", "partial", "failed", "waiting"] as const, (outcome) => Effect.gen(function* () {
      const reply = Option.some(`${outcome} reply`)
      const runner = yield* subject.open({ use: () => Effect.succeed({ outcome, reply }) })
      const result = yield* runner.run(writer)
      yield* expect("outcome", result.outcome === outcome && Option.contains(result.reply, `${outcome} reply`),
        `the runner returned ${result.outcome} for ${outcome}, or changed its reply`)
    }), { concurrency: 1 })
  }))),

  check("the runner preserves an execution TurnError as the same typed failure", "failure", (owner) => Effect.scoped(Effect.gen(function* () {
    const { writer } = yield* fixture(owner)
    const failure = new HarnessError({ code: "conformance.runner", message: "scripted runner failure" })
    const runner = yield* subject.open({ use: () => Effect.fail(failure) })
    const result = yield* Effect.result(runner.run(writer))
    yield* expect("failure", result._tag === "Failure" && result.failure === failure, "the runner swallowed or replaced the TurnError")
  }))),

  check("the runner leaves its borrowed writer open on success and failure", "writer-lifetime", (owner) => Effect.scoped(Effect.gen(function* () {
    const { writer, ends } = yield* fixture(owner)
    const calls = yield* Ref.make(0)
    const failure = new HarnessError({ code: "conformance.runner", message: "scripted runner failure" })
    const runner = yield* subject.open({ use: () => Ref.updateAndGet(calls, (n) => n + 1).pipe(Effect.flatMap((n) => n === 1
      ? Effect.succeed({ outcome: "partial" as const, reply: Option.none<string>() }) : Effect.fail(failure))) })
    yield* Effect.result(runner.run(writer))
    yield* Effect.result(runner.run(writer))
    yield* expect("writer-lifetime", (yield* Ref.get(calls)) === 2 && (yield* Ref.get(ends)) === 0,
      "the runner skipped execution or ended the borrowed writer")
  }))),
]
