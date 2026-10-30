import { LanguageModel } from "effect/ai"
import type { Prompt, Response } from "effect/ai"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Result, Scope, Stream } from "effect"
import { ConformanceFailure } from "../conformance.entity.js"
import type { ConformanceCheck } from "../conformance.entity.js"
import { failureCode, pixelPng, sameUsage } from "../conformance.functions.js"
import { mediaFromBase64 } from "../domain/media.entity.functions.js"
import type { AgentMessage } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { addUsage, tokenUsage, zeroUsage } from "../domain/token-usage.entity.functions.js"
import { HarnessError } from "../harness/plugin.entity.js"
import { IntentMatcher } from "../ports/capability.port.js"
import { RunContext } from "../ports/run-context.port.js"
import { Sessions } from "../ports/sessions.port.js"
import { entriesOfEvents, readStored, readStoredKeys, turnUsageOf } from "../session/session-event.entity.functions.js"
import type { SessionLogEvent } from "../session/session-log.entity.js"
import { InboxItemId } from "../session/sessions.entity.js"
import type { SessionAddress, TurnBeginError, TurnError } from "../session/sessions.entity.js"
import type { TurnRunner } from "../ports/turn.port.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import { replayModelRequest } from "./model-request.entity.functions.js"
import { UserMessage } from "./user-message.entity.js"

const fail = (check: string) => (message: string) => Effect.fail(new ConformanceFailure({ check, message }))
const expect = (check: string, holds: boolean, message: string): Effect.Effect<void, ConformanceFailure> => holds ? Effect.void : fail(check)(message)

/** How long the checks that cancel a turn, or feed its bus past a queue's size, wait for it on the live clock. */
const WAIT = "2 seconds"

/** A Sessions failure in a check, as the HarnessError the check fails with. */
const sessionFailure = (error: { readonly _tag: string }) => new HarnessError({ code: "conformance.session", message: error._tag })

/** The conformance session: the Sessions of the turn services, and one session made for the check. */
interface Session {
  readonly sessions: Context.Service.Shape<typeof Sessions>
  readonly address: SessionAddress
}

const stored = (session: Session) => session.sessions.read(session.address).pipe(
  Effect.mapError((error) => new HarnessError({ code: "conformance.session", message: error._tag })),
)
/** Stored data that does not decode, as the HarnessError the check fails with. */
const undecodable = (error: { readonly message: string }) => new HarnessError({ code: "conformance.session", message: `undecodable stored data: ${error.message}` })
/** The `turn.started` of the turn run `runId` began, found by its keys. */
const startOf = (all: ReadonlyArray<SessionLogEvent>, runId: string): Effect.Effect<Option.Option<SessionLogEvent>, HarnessError> =>
  readStoredKeys("turn.started", all).pipe(
    Effect.map((starts) => Option.map(Option.fromNullishOr(starts.find((started) => started.keys.runId === runId)), (started) => started.event)),
    Effect.mapError(undecodable),
  )
/** The events of the turn run `runId` began. */
const ofRun = (all: ReadonlyArray<SessionLogEvent>, runId: string): Effect.Effect<ReadonlyArray<SessionLogEvent>, HarnessError> =>
  startOf(all, runId).pipe(Effect.map((start) => Option.match(Option.flatMap(start, (event) => event.turn), {
    onNone: () => [],
    onSome: (number) => all.filter((event) => Option.contains(event.turn, number)),
  })))
const names = (session: Session, runId: string) => stored(session).pipe(Effect.flatMap((all) => ofRun(all, runId)), Effect.map((events) => events.map((event) => event.kind)))

/** What the billing model reports for its call `index` (from 0): every count, cache reads and writes inside the input, reasoning inside the output. */
const billedCall = (index: number) => ({
  inputTokens: { total: 100 + index, uncached: 50 + index, cacheRead: 40, cacheWrite: 10 },
  outputTokens: { total: 20, text: 15, reasoning: 5 },
})

/** A model answering every call with text and `billedCall`'s usage; `calls` counts the calls it answered. */
const billingModel = Effect.gen(function* () {
  const calls = yield* Ref.make(0)
  const model = yield* LanguageModel.make({
    generateText: () => Ref.getAndUpdate(calls, (count) => count + 1).pipe(Effect.map((index): Array<Response.PartEncoded> => [
      { type: "text", text: `answer ${index}` },
      { type: "finish", reason: "stop", usage: billedCall(index) },
    ])),
    streamText: () => Stream.die("the conformance model does not stream"),
  })
  return { model, calls: Ref.get(calls) }
})

/** The usage of the billing model's first `count` calls, summed. */
const billedTotal = (count: number) => Array.from({ length: count }, (_, index) => billedCall(index)).reduce(
  (total, call) => addUsage(total, tokenUsage({
    inputTokens: call.inputTokens.total, outputTokens: call.outputTokens.total,
    cacheReadTokens: call.inputTokens.cacheRead, cacheWriteTokens: call.inputTokens.cacheWrite, reasoningTokens: call.outputTokens.reasoning,
  })),
  zeroUsage,
)

/**
 * The turn contract, as checks any composition of the turn must pass (an
 * `Agent`, or a host's own composition of `TurnLive` and the lifecycle):
 * the session's writer is the bus's first subscriber; the user's message
 * is in memory before the matcher reads the history; the reply is recorded
 * and the turn ended exactly once on success, failure and interrupt; the
 * reply is stored in the turn's closing commit, right before its
 * `turn.ended`, with a reason its outcome allows (completed and partial
 * their own, failed a failed or interrupted one), stored failed when a
 * reaction to it fails; tasks
 * are joined before the reply; a model-driven turn's `TurnResult.usage` is
 * what its stored `step.usage` records sum to (`turnUsageOf`); the user's
 * attachments reach the first request as image parts; two runs of one
 * turn each rebuild their own request from the stored events, the second
 * never with the first's step context; the host layer sees only earlier turns; a turn the runner begins and ends returns the
 * inbox items its end left waiting (`TurnResult.pending`), for its caller
 * to drain; a turn that cannot begin (one begun while another is open)
 * fails with the refusal itself (`SessionBusy`), running and storing
 * nothing; an interrupted turn ends at once, its reply and end recorded,
 * though a background reaction to its reply never returns; and a
 * background reaction publishing what it takes past its queue's size does
 * not hang the turn. Those last two wait up to two seconds on the live
 * clock, so run the kit on it.
 *
 * `runner` is acquired afresh for each check. `services` are merged into
 * every turn's services (the model, the `Sessions` the turns begin with, and
 * whatever else the runner requires); each check makes its own session, and
 * the kit adds its own IntentMatcher, which the runner's tools must consult
 * (plugin-tool-discovery does). The usage check runs the turn's loop twice
 * with the kit's own model, which answers with text only, under a policy
 * that completes after the first reply (`requireCompletion: false`, a
 * complete verdict); its expected counts follow the calls the model answered.
 * The attachments check runs the loop once, and the runs check twice (with
 * a step context only in the first run, at the end of the request, as the
 * policy's default `stepContext: "tail"` puts it), with a model of its own
 * that records each request; the attachments check needs the composition's
 * memory to admit one small image (the memory plugins' defaults do;
 * `maxMediaChars: 0` does not).
 */
export const turnConformance = (
  runner: Effect.Effect<TurnRunner, HarnessError, Scope.Scope>,
  services: Context.Context<never> = Context.empty(),
): ReadonlyArray<ConformanceCheck> => {
  const check = (
    name: string,
    id: string,
    body: (runner: TurnRunner, session: Session, history: Ref.Ref<ReadonlyArray<ReadonlyArray<AgentMessage>>>) => Effect.Effect<void, ConformanceFailure | TurnBeginError | TurnError, Scope.Scope>,
  ): ConformanceCheck => ({
    name,
    run: Effect.scoped(Effect.gen(function* () {
      const history = yield* Ref.make<ReadonlyArray<ReadonlyArray<AgentMessage>>>([])
      const matcher = Context.make(IntentMatcher, IntentMatcher.of({
        id: "conformance", version: "1",
        match: (request) => Ref.update(history, (all) => [...all, request.history]).pipe(
          Effect.as({ skills: [], probabilities: Option.none(), abstained: true }),
        ),
      }))
      const sessions = yield* Option.match(Context.getOption(services, Sessions), {
        onNone: () => fail(id)("the turn services hold no Sessions to begin turns with"),
        onSome: (found) => Effect.succeed(found),
      })
      const view = yield* sessions.create({ owner: "conformance" }).pipe(Effect.mapError((error) => new HarnessError({ code: "conformance.session", message: error._tag })))
      const acquired = yield* runner
      yield* body({
        turn: (input, use) => acquired.turn({ ...input, services: Context.merge(Context.merge(services, matcher), input.services) }, use),
      }, { sessions, address: { id: view.header.id, owner: "conformance" } }, history)
    })).pipe(Effect.catch((error) => error._tag === "ConformanceFailure" ? Effect.fail(error) : fail(id)(`${failureCode(error)}: ${error.message}`))),
  })
  const input = (session: Session, runId: string) => ({
    turn: { session: session.address, userMessage: new UserMessage({ text: `the message of ${runId}` }), runId: RunId.make(runId) }, services: Context.empty(),
  })
  const reply = (text: string) => Effect.succeed({ outcome: "completed" as const, reply: Option.some(text) })

  return [
    check("the session's writer is the bus's first subscriber", "journal-first", (turns, session) => Effect.gen(function* () {
      const outcome = yield* turns.turn(input(session, "run-1"), (turn) => Effect.gen(function* () {
        const journaled = yield* Ref.make(false)
        yield* turn.events.subscribe(
          (event) => event._tag === "host" && event.name === "conformance.probe" ? Option.some(event) : Option.none(),
          () => turn.flush.pipe(Effect.andThen(names(session, "run-1")), Effect.flatMap((kinds) => Ref.set(journaled, kinds.includes("conformance.probe")))),
        )
        yield* turn.events.publish({ _tag: "host", name: "conformance.probe", data: {} })
        return yield* reply((yield* Ref.get(journaled)) ? "journaled first" : "not journaled")
      }))
      yield* expect("journal-first", Option.contains(outcome.reply, "journaled first"), "a subscriber ran before the session stored the event it received")
    })),
    check("the user's message is recorded before the matcher reads the history", "message-first", (turns, session, history) => Effect.gen(function* () {
      yield* turns.turn(input(session, "run-1"), (turn) => turn.tools.match(turn.userMessage).pipe(Effect.andThen(reply("matched"))))
      const seen = yield* Ref.get(history)
      const last = Option.fromNullishOr(seen.at(-1)?.at(-1))
      yield* expect("message-first", seen.length === 1, `the matcher was consulted ${seen.length} times, not once`)
      yield* expect("message-first", Option.exists(last, (message) => message.role === "user" && JSON.stringify(message.content).includes("the message of run-1")),
        "the matcher's history does not end with the turn's own message")
    })),
    check("the reply is recorded and the turn ended exactly once, on success, failure and interrupt", "ended-once", (turns, session) => Effect.gen(function* () {
      yield* turns.turn(input(session, "run-1"), () => reply("done"))
      yield* Effect.result(turns.turn(input(session, "run-2"), () => Effect.fail(new HarnessError({ code: "conformance.host", message: "the host failed" }))))
      const started = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(turns.turn(input(session, "run-3"), () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const all = yield* stored(session)
      // Each run's replies (its memory's TurnEnded entries) and ends, decoded.
      const runs = yield* Effect.forEach(["run-1", "run-2", "run-3"], (runId) => ofRun(all, runId).pipe(
        Effect.flatMap((own) => Effect.all([entriesOfEvents(own.filter((event) => event.kind === "turn.reply")), readStored("turn.ended", own)], { concurrency: 1 }).pipe(
          Effect.mapError(undecodable))),
        Effect.map(([entries, ends]) => ({
          reply: `${runId}:${entries.flatMap((entry) => entry.body._tag === "TurnEnded" ? [entry.body.outcome] : []).join("+")}`,
          ending: `${runId}:${ends.map((ended) => ended.data.reason).join("+")}`,
        })),
      ), { concurrency: 1 })
      const replies = runs.map((run) => run.reply)
      const endings = runs.map((run) => run.ending)
      yield* expect("ended-once", replies.join() === "run-1:completed,run-2:failed,run-3:failed", `the replies were ${replies.join()}`)
      yield* expect("ended-once", endings.join() === "run-1:completed,run-2:failed,run-3:interrupted", `the turns ended ${endings.join()}`)
    })),
    check("the reply is stored in the turn's closing commit, right before turn.ended, with a reason its outcome allows: one whose reactions fail is stored failed", "closing", (turns, session) => Effect.gen(function* () {
      const outer = yield* Effect.scope
      yield* turns.turn(input(session, "run-1"), () => reply("done"))
      // Subscribed in the check's scope, so the reaction takes the turn's reply, then fails the drain after it.
      yield* Effect.result(turns.turn(input(session, "run-2"), (turn) => turn.events.subscribe(
        (event) => event._tag === "turn.ended" ? Option.some(event) : Option.none(),
        () => Effect.fail(new HarnessError({ code: "conformance.reaction", message: "a reaction to the reply failed" })),
        { mode: "background" },
      ).pipe(Scope.provide(outer), Effect.andThen(reply("answered")))))
      const started = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(turns.turn(input(session, "run-3"), () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const all = yield* stored(session)
      const closings = yield* Effect.forEach(["run-1", "run-2", "run-3"], (runId) => ofRun(all, runId).pipe(Effect.flatMap((own) => {
        const replies = own.filter((event) => event.kind === "turn.reply")
        const ends = own.filter((event) => event.kind === "turn.ended")
        return Effect.all([entriesOfEvents(replies), readStored("turn.ended", ends)], { concurrency: 1 }).pipe(
          Effect.mapError(undecodable),
          Effect.map(([entries, ended]) => {
            const outcome = entries.flatMap((entry) => entry.body._tag === "TurnEnded" ? [entry.body.outcome] : []).join("+")
            const reason = ended.map((end) => end.data.reason).join("+")
            const adjacent = replies.length === 1 && ends.length === 1 && ends[0]!.seq === replies[0]!.seq + 1
            const allowed = outcome === "failed" ? reason === "failed" || reason === "interrupted" : reason === outcome
            return `${runId}:${outcome}/${reason}${adjacent ? "" : " (not stored right before turn.ended)"}${allowed ? "" : " (a reason its outcome does not allow)"}`
          }),
        )
      })), { concurrency: 1 })
      yield* expect("closing", closings.join() === "run-1:completed/completed,run-2:failed/failed,run-3:failed/interrupted",
        `the turns stored their reply and end as ${closings.join()}`)
    })),
    check("tasks are joined before the reply", "tasks-joined", (turns, session) => Effect.gen(function* () {
      yield* turns.turn(input(session, "run-1"), (turn) => turn.tasks.fork("late", Effect.sleep("10 millis").pipe(
        Effect.andThen(turn.events.publish({ _tag: "host", name: "conformance.task", data: {} })),
      )).pipe(Effect.andThen(reply("forked"))))
      const kinds = yield* names(session, "run-1")
      yield* expect("tasks-joined", kinds.includes("conformance.task") && kinds.indexOf("conformance.task") < kinds.indexOf("turn.reply"),
        `the task's event came ${kinds.includes("conformance.task") ? "after the reply" : "never"}`)
    })),
    check("a model-driven turn returns its usage: what its stored step.usage records sum to", "usage", (turns, session) => Effect.gen(function* () {
      const billing = yield* billingModel
      const runs = yield* Ref.make(zeroUsage)
      const during = yield* Ref.make(zeroUsage)
      const result = yield* turns.turn({ ...input(session, "run-1"), services: Context.make(LanguageModel.LanguageModel, billing.model) }, (turn) => Effect.gen(function* () {
        // Pinned against the runner's own limits: no completion nudge, so each run makes one call.
        const policy = {
          limits: { streaming: false, maxSteps: 2, requireCompletion: false },
          completion: () => Effect.succeed({ complete: true, awaiting: [], facts: {} }),
        }
        const first = yield* turn.run(policy)
        const second = yield* turn.run(policy)
        yield* Ref.set(runs, addUsage(first.usage, second.usage))
        yield* Ref.set(during, yield* turn.usage)
        return { outcome: "completed" as const, reply: Option.some(second.text) }
      }))
      yield* expect("usage", sameUsage(yield* Ref.get(during), yield* Ref.get(runs)), `Turn.usage read ${JSON.stringify(yield* Ref.get(during))}, the turn's runs ${JSON.stringify(yield* Ref.get(runs))}`)
      const all = yield* stored(session)
      const number = Option.flatMap(yield* startOf(all, "run-1"), (event) => event.turn)
      yield* expect("usage", Option.isSome(number), "the turn's turn.started was not stored")
      const total = yield* turnUsageOf(all, Option.getOrElse(number, () => -1)).pipe(Effect.mapError((error) => new ConformanceFailure({ check: "usage", message: error.message })))
      yield* expect("usage", sameUsage(result.usage, total), `the turn returned ${JSON.stringify(result.usage)}, its stored step.usage records sum to ${JSON.stringify(total)}`)
      yield* expect("usage", sameUsage(result.usage, yield* Ref.get(runs)), `the turn returned ${JSON.stringify(result.usage)}, its runs ${JSON.stringify(yield* Ref.get(runs))}`)
      const calls = yield* billing.calls
      yield* expect("usage", calls >= 2 && sameUsage(result.usage, billedTotal(calls)),
        `the turn's usage lost the provider's counts: ${JSON.stringify(result.usage)} for ${calls} model calls, which reported ${JSON.stringify(billedTotal(calls))}`)
    })),
    check("the user's attachments are stored with the turn and reach the first request as image parts", "attachments", (turns, session) => Effect.gen(function* () {
      const image = yield* mediaFromBase64(pixelPng, { name: "pixel.png" }).pipe(
        Effect.mapError((error) => new ConformanceFailure({ check: "attachments", message: error.message })),
      )
      const requests = yield* Ref.make<ReadonlyArray<Prompt.Prompt>>([])
      const model = yield* LanguageModel.make({
        generateText: (options) => Ref.update(requests, (all) => [...all, options.prompt]).pipe(Effect.as<Array<Response.PartEncoded>>([
          { type: "text", text: "a pixel" },
          { type: "finish", reason: "stop", usage: billedCall(0) },
        ])),
        streamText: () => Stream.die("the conformance model does not stream"),
      })
      const userMessage = new UserMessage({ text: "what is this?", attachments: [image] })
      yield* turns.turn({ turn: { session: session.address, userMessage, runId: RunId.make("run-1") }, services: Context.make(LanguageModel.LanguageModel, model) }, (turn) =>
        turn.run({
          limits: { streaming: false, maxSteps: 1, requireCompletion: false },
          completion: () => Effect.succeed({ complete: true, awaiting: [], facts: {} }),
        }).pipe(Effect.map((result) => ({ outcome: "completed" as const, reply: Option.some(result.text) }))))
      const first = (yield* Ref.get(requests))[0]
      yield* expect("attachments", first !== undefined, "the turn made no request")
      const files = (first?.content ?? []).flatMap((message) => message.role === "user"
        ? message.content.flatMap((part) => part.type === "file" ? [part] : []) : [])
      yield* expect("attachments", files.some((part) => part.mediaType === image.mediaType && part.data === image.data),
        `the first request carried ${files.length} file parts, none of them the attached ${image.mediaType}`)
      const started = yield* startOf(yield* stored(session), "run-1")
      yield* expect("attachments", Option.exists(started, (event) => JSON.stringify(event.data.userMessage ?? null).includes(image.fingerprint)), "the stored turn.started does not hold the attachment")
    })),
    check("two runs of one turn each rebuild their own request, never with the other's step context", "runs", (turns, session) => Effect.gen(function* () {
      const marker = "STEP OF THE FIRST RUN"
      const requests = yield* Ref.make<ReadonlyArray<Prompt.Prompt>>([])
      const model = yield* LanguageModel.make({
        generateText: (options) => Ref.update(requests, (all) => [...all, options.prompt]).pipe(Effect.as<Array<Response.PartEncoded>>([
          { type: "text", text: "done" },
          { type: "finish", reason: "stop", usage: billedCall(0) },
        ])),
        streamText: () => Stream.die("the conformance model does not stream"),
      })
      const policy = (context: Option.Option<string>) => ({
        limits: { streaming: false, maxSteps: 1, requireCompletion: false },
        step: () => Effect.succeed({ context, toolChoice: Option.none() }),
        completion: () => Effect.succeed({ complete: true, awaiting: [], facts: {} }),
      })
      yield* turns.turn({ ...input(session, "run-1"), services: Context.make(LanguageModel.LanguageModel, model) }, (turn) => Effect.gen(function* () {
        yield* turn.run(policy(Option.some(marker)))
        const second = yield* turn.run(policy(Option.none()))
        return { outcome: "completed" as const, reply: Option.some(second.text) }
      }))
      const shows = (prompt: Prompt.Prompt) => canonicalJson(prompt.content).includes(marker)
      const sent = (yield* Ref.get(requests)).map(shows)
      yield* expect("runs", sent.join() === "true,false", `the step context of the turn's first run reached its two runs' requests as ${sent.join() || "none"}, not only the first's`)
      const all = yield* stored(session)
      const rebuilt = yield* Effect.forEach([0, 1], (ordinal) => replayModelRequest(all, RunId.make("run-1"), 0, RunOrdinal.make(ordinal)).pipe(
        Effect.map((request) => shows(request.prompt)),
        Effect.catch((error) => Effect.succeed(`not rebuilt (${error.code})`)),
      ), { concurrency: 1 })
      yield* expect("runs", rebuilt.join() === "true,false",
        `the requests of the turn's two runs at step 0 rebuilt from the stored events as ${rebuilt.map((shown) => typeof shown === "string" ? shown : shown ? "with the first run's step context" : "without it").join(" and ")}`)
    })),
    check("the host layer is built before the message: it sees only earlier turns", "layer-before-message", (turns, session) => Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const layer = Layer.effectDiscard(Effect.gen(function* () {
        const run = yield* RunContext
        const own = (yield* run.memory.entries).filter((entry) => entry.runId === run.runId).length
        const turn = yield* run.memory.turn
        yield* Ref.update(seen, (all) => [...all, `${run.runId}:turn ${turn}, own entries ${own}`])
      }))
      yield* turns.turn({ ...input(session, "run-1"), layer }, () => reply("first"))
      yield* turns.turn({ ...input(session, "run-2"), layer }, () => reply("second"))
      const built = (yield* Ref.get(seen)).join("; ")
      yield* expect("layer-before-message", built === "run-1:turn 0, own entries 0; run-2:turn 1, own entries 0", `the host layer saw ${built}`)
    })),
    check("a turn the runner begins and ends returns the inbox items left waiting for it, one delivered while it ran", "pending", (turns, session) => Effect.gen(function* () {
      const result = yield* turns.turn(input(session, "run-1"), () => session.sessions.deliver(session.address, {
        id: InboxItemId.make("conformance-result"), source: { kind: "conformance" }, content: "a result delivered while the turn ran",
      }).pipe(Effect.mapError(sessionFailure), Effect.andThen(reply("delivered"))))
      yield* expect("pending", result.pending === 1, `the turn returned pending ${result.pending ?? "absent"} with one item delivered while it ran (its caller drains what waits)`)
      const waiting = (yield* session.sessions.get(session.address).pipe(Effect.mapError(sessionFailure))).pending
      yield* expect("pending", waiting === 1, `after the turn ${waiting} items wait in the session's inbox`)
    })),
    check("a turn that cannot begin fails with the refusal itself, running and storing nothing", "begin-refusal", (turns, session) => Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const first = yield* Effect.forkChild(turns.turn(input(session, "run-1"), () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(reply("first")))))
      yield* Deferred.await(started)
      const ran = yield* Ref.make(false)
      const second = yield* Effect.result(turns.turn(input(session, "run-2"), () => Ref.set(ran, true).pipe(Effect.andThen(reply("second")))))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      const ended = Result.match(second, { onSuccess: () => "success", onFailure: (error) => `${error._tag} (${failureCode(error)})` })
      yield* expect("begin-refusal", Result.isFailure(second) && second.failure._tag === "SessionBusy",
        `a turn begun while another was open ended with ${ended}, not the refusal SessionBusy itself`)
      yield* expect("begin-refusal", !(yield* Ref.get(ran)), "the refused turn ran its use")
      const refused = (yield* ofRun(yield* stored(session), "run-2")).map((event) => event.kind)
      yield* expect("begin-refusal", refused.length === 0, `the refused turn stored ${refused.join(", ")}`)
    })),
    check("an interrupted turn ends at once, its reply and end recorded, while a background reaction to its reply never returns", "stuck-reaction", (turns, session) => Effect.gen(function* () {
      const outer = yield* Effect.scope
      const started = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(turns.turn(input(session, "run-1"), (turn) => Effect.gen(function* () {
        // Subscribed in the check's scope, so the subscription still takes the turn's reply after `use` is cut.
        yield* turn.events.subscribe((event) => event._tag === "turn.ended" ? Option.some(event) : Option.none(), () => Effect.never, { mode: "background" }).pipe(Scope.provide(outer))
        yield* Deferred.succeed(started, undefined)
        return yield* Effect.never
      })))
      yield* Deferred.await(started)
      const stopped = yield* Fiber.interrupt(fiber).pipe(Effect.timeoutOption(WAIT))
      yield* expect("stuck-reaction", Option.isSome(stopped), `the interrupted turn did not end within ${WAIT} while a background reaction to its reply was stuck`)
      const own = yield* ofRun(yield* stored(session), "run-1")
      const recorded = ["turn.reply", "turn.ended"].map((kind) => own.filter((event) => event.kind === kind).length).join()
      yield* expect("stuck-reaction", recorded === "1,1", `the interrupted turn stored ${recorded} of turn.reply and turn.ended, not one each`)
    })),
    check("a background reaction that publishes what it takes, past its queue's size, does not hang the turn", "self-publication", (turns, session) => Effect.gen(function* () {
      const handled = yield* Ref.make<ReadonlyArray<number>>([])
      const echo = (n: number) => ({ _tag: "host" as const, name: "conformance.echo", data: { n } })
      const result = yield* turns.turn(input(session, "run-1"), (turn) => Effect.gen(function* () {
        yield* turn.events.subscribe(
          (event) => event._tag === "host" && event.name === "conformance.echo" && typeof event.data.n === "number" ? Option.some(event.data.n) : Option.none(),
          (n) => Ref.update(handled, (all) => [...all, n]).pipe(Effect.andThen(n === 0 ? Effect.forEach([1, 2, 3], (next) => turn.events.publish(echo(next)), { concurrency: 1, discard: true }) : Effect.void)),
          { mode: "background", capacity: 1 },
        )
        yield* turn.events.publish(echo(0))
        return yield* reply("echoed")
      })).pipe(Effect.timeoutOption(WAIT))
      yield* expect("self-publication", Option.isSome(result), `the turn did not end within ${WAIT}: a background reaction publishing to its own full queue hung it`)
      const seen = (yield* Ref.get(handled)).join()
      yield* expect("self-publication", seen === "0,1,2,3", `the reaction handled [${seen}], not each event once in order`)
    })),
  ]
}
