import { Clock, Context, Deferred, Effect, Fiber, FiberSet, Match, Option, Predicate, Ref, Result, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { harnessCodeOf } from "@xandreed/core"
import type { SessionAddress, SessionLog, TurnRunner } from "@xandreed/core"
import { ProcessPeer } from "./ports/process-peer.port.js"
import type { ProcessPeerError } from "./process-peer.entity.js"
import { PROCESS_PROTOCOL_VERSION } from "./process-protocol.entity.js"
import type { ProcessCommand, ProcessEvent, ProcessRequestId } from "./process-protocol.entity.js"
import { processLifecycleOf, processProgressOf } from "./process-protocol.entity.functions.js"
import { ProcessHostConfig, ProcessHostError, processHostDefaults } from "./process-host.entity.js"
import type { ProcessActiveRequest, ProcessBinding, ProcessDispatchState, ProcessHostOptions, ProcessHostResult, ProcessObservers } from "./process-host.entity.js"
import { admitProcessRequest, endedProcessRequestOf, noteProcessTurn, openProcessDispatch, processRequestOf, releaseProcessRequest, stopProcessDispatch } from "./process-host.entity.functions.js"

interface StopRequest {
  readonly reason: ProcessHostResult["reason"]
  readonly requestId?: ProcessRequestId
  readonly deadlineMs?: number
}

const peerFailure = (cause: ProcessPeerError) => new ProcessHostError({
  reason: cause.direction === "input" && ["InvalidFrame", "InvalidUtf8", "FrameTooLarge"].includes(cause.reason) ? "Protocol" : "Peer",
  code: cause.direction === "input" && ["InvalidFrame", "InvalidUtf8", "FrameTooLarge"].includes(cause.reason) ? "protocol.invalid" : "host.peer",
  message: cause.direction === "input" ? "the process input could not be read" : "the process output could not be written",
  cause,
})

const correlation = (requestId: Option.Option<ProcessRequestId>) => Option.match(requestId, { onNone: () => ({}), onSome: (requestId) => ({ requestId }) })

/**
 * Serve one connection with a host-supplied runtime. Setup owns startup
 * recovery and installs the observers before constructing its services.
 * This scope keeps storage open through graceful shutdown and output ACKs.
 * No native process exit or automatic task/drainer construction occurs here.
 * @public
 */
export const serveProcess = Effect.fn("process.serve")(function* <E>(options: ProcessHostOptions<E>): Effect.fn.Return<ProcessHostResult, ProcessHostError, ProcessPeer | Scope.Scope> {
  const stoppingNotified = yield* Ref.make(false)
  const notifyStopping = Ref.getAndSet(stoppingNotified, true).pipe(Effect.flatMap((already) => already ? Effect.void : options.onStopping ?? Effect.void))
  return yield* Effect.scoped(Effect.gen(function* () {
  const config = yield* Schema.decodeUnknownEffect(ProcessHostConfig)({
    owners: options.owners,
    events: options.events ?? processHostDefaults.events,
    maxBegins: options.maxBegins ?? processHostDefaults.maxBegins,
    maxShortCommands: options.maxShortCommands ?? processHostDefaults.maxShortCommands,
    controlCapacity: options.controlCapacity ?? processHostDefaults.controlCapacity,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? processHostDefaults.handshakeTimeoutMs,
    shutdown: { ...processHostDefaults.shutdown, ...options.shutdown },
  }).pipe(Effect.mapError((cause) => new ProcessHostError({ reason: "Config", code: "host.runtime", message: "invalid process host options", cause })))
  const peer = yield* ProcessPeer
  const state = yield* Ref.make<ProcessDispatchState>({ _tag: "AwaitingHello", requests: [] })
  const binding = yield* Ref.make<Option.Option<ProcessBinding>>(Option.none())
  const failure = yield* Ref.make<Option.Option<ProcessHostError>>(Option.none())
  const stopped = yield* Deferred.make<StopRequest>()
  const workers = yield* FiberSet.make<void, never>()

  const stop = (request: StopRequest): Effect.Effect<void> => Effect.uninterruptible(Effect.gen(function* () {
    const first = yield* Ref.modify(state, (current): readonly [boolean, ProcessDispatchState] => [current._tag !== "Stopping", stopProcessDispatch(current)])
    if (!first) return
    const notified = yield* Effect.exit(notifyStopping)
    if (notified._tag === "Failure") yield* Ref.update(failure, (current) => Option.isSome(current) ? current : Option.some(new ProcessHostError({ reason: "Runtime", code: "host.runtime", message: "the process stopping hook failed", cause: notified.cause })))
    yield* Deferred.succeed(stopped, request)
  }))
  const fatal = (error: ProcessHostError, requestId?: ProcessRequestId): Effect.Effect<void> => Ref.update(failure, (current) => Option.isSome(current) ? current : Option.some(error)).pipe(
    Effect.andThen(stop({ reason: "eof", ...(requestId === undefined ? {} : { requestId }) })),
  )
  const send = (event: ProcessEvent): Effect.Effect<void> => peer.send(event).pipe(
    Effect.catch((error) => fatal(peerFailure(error))),
    Effect.catchDefect((cause) => fatal(new ProcessHostError({ reason: "Peer", code: "host.peer", message: "the process output failed", cause }))),
  )
  const refuse = (requestId: ProcessRequestId, code: "host.busy" | "host.owner" | "host.stopping" | "host.unsupported" | "host.command", message: string, frameworkCode?: string) => send({
    _tag: "error", requestId, code, message, fatal: false, ...(frameworkCode === undefined ? {} : { frameworkCode }),
  })

  const observe: ProcessObservers = {
    sessionLog: (inner: Context.Service.Shape<typeof SessionLog>) => ({
      create: (header) => inner.create(header),
      head: (id) => inner.head(id),
      list: (query) => inner.list(query),
      read: (id, query) => inner.read(id, query),
      remove: (id) => inner.remove(id),
      commit: (id, commit) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const header = (yield* restore(inner.head(id))).header
        const receipt = yield* restore(inner.commit(id, commit))
        if (!config.owners.includes(header.owner)) return receipt
        const address: SessionAddress = { id, owner: header.owner }
        yield* Effect.forEach(receipt.events, (row) => processLifecycleOf(address, row).pipe(Effect.flatMap(Option.match({
          onNone: () => Effect.void,
          onSome: (event) => Match.value(event).pipe(
            Match.tag("turn.started", (started) => Ref.modify(state, (current) => [
              processRequestOf(current, address, started.runId), noteProcessTurn(current, address, started.runId, started.turn),
            ] as const).pipe(Effect.flatMap((requestId) => send({ ...started, ...correlation(requestId) })))),
            Match.tag("turn.ended", (ended) => Ref.get(state).pipe(Effect.flatMap((current) => send({ ...ended, ...correlation(endedProcessRequestOf(current, address, ended.turn)) })))),
            Match.orElse(() => Effect.void),
          ),
        })), Effect.catch((cause) => fatal(new ProcessHostError({ reason: "Runtime", code: "host.runtime", message: "a committed process lifecycle event could not be observed", cause }))), Effect.catchDefect((cause) => fatal(new ProcessHostError({ reason: "Runtime", code: "host.runtime", message: "a committed process lifecycle observation failed", cause })))), { concurrency: 1, discard: true })
        // Observation must never turn a successful storage ACK into a failed write.
        return receipt
      })),
    }),
    turnRunner: (inner: TurnRunner): TurnRunner => ({
      turn: (input, use) => inner.turn(input, (turn) => Effect.gen(function* () {
        const address = turn.admitted.session
        if (config.owners.includes(address.owner)) yield* turn.events.subscribe(Option.some, (event) => processProgressOf(event, config.events).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (progress) => Ref.get(state).pipe(Effect.flatMap((current) => send({
            _tag: "turn.event", session: address, turn: turn.turn, runId: turn.runId, progress, ...correlation(processRequestOf(current, address, turn.runId)),
          }))) })),
          Effect.catch((cause) => fatal(peerFailure(cause))),
          Effect.catchDefect((cause) => fatal(new ProcessHostError({ reason: "Peer", code: "host.peer", message: "a process progress event could not be observed", cause }))),
        ), { mode: "inline" })
        return yield* use(turn)
      })),
    }),
  }

  const runCommand = (host: ProcessBinding, command: ProcessCommand): Effect.Effect<void> => Match.valueTags(command, {
    hello: () => fatal(new ProcessHostError({ reason: "Protocol", code: "protocol.sequence", message: "hello is only accepted as the first command" }), command.requestId),
    begin: (begin) => {
      const { _tag, requestId, ...turn } = begin
      return host.runner.turn({ turn, services: host.services }, host.use).pipe(Effect.flatMap((result) => send({ _tag: "begin.result", requestId, result })))
    },
    send: (queued) => host.sessions.enqueue(queued.session, { ...queued.input, delivery: "next" }).pipe(Effect.flatMap((result) => send({ _tag: "queued", requestId: queued.requestId, command: "send", ...result }))),
    steer: (queued) => host.sessions.enqueue(queued.session, { ...queued.input, delivery: "steer" }).pipe(Effect.flatMap((result) => send({ _tag: "queued", requestId: queued.requestId, command: "steer", ...result }))),
    answer: (answer) => Option.match(host.tasks, {
      onNone: () => refuse(answer.requestId, "host.unsupported", "task answers are not available in this host"),
      onSome: (tasks) => tasks.answer(answer.parent, answer.taskId, { questionId: answer.questionId, text: answer.text }).pipe(Effect.flatMap((result) => send({ _tag: "answered", requestId: answer.requestId, ...result }))),
    }),
    cancel: (cancel) => host.sessions.cancel(cancel.session, cancel.turn).pipe(Effect.flatMap((result) => send({ _tag: "cancelled", requestId: cancel.requestId, ...result }))),
    ping: (ping) => host.activity.pipe(Effect.flatMap((activity) => send({ _tag: "pong", requestId: ping.requestId, activity }))),
    shutdown: (shutdown) => stop({ reason: "shutdown", requestId: shutdown.requestId, ...(shutdown.deadlineMs === undefined ? {} : { deadlineMs: shutdown.deadlineMs }) }),
  }).pipe(
    Effect.catch((error) => Predicate.isTagged(error, "SessionLogError")
      ? fatal(new ProcessHostError({ reason: "Runtime", code: "host.runtime", message: "the process storage operation failed", cause: error }), command.requestId)
      : refuse(command.requestId, "host.command", "the process command could not complete", Option.getOrUndefined(harnessCodeOf(error)))),
    Effect.catchDefect((cause) => fatal(new ProcessHostError({ reason: "Runtime", code: "host.runtime", message: "the process command failed", cause }), command.requestId)),
  )

  const dispatch = (host: ProcessBinding, command: ProcessCommand): Effect.Effect<void> => Effect.gen(function* () {
    const active: ProcessActiveRequest = {
      requestId: command.requestId,
      lane: Match.value(command).pipe(Match.tag("begin", () => "begin" as const), Match.tag("cancel", "ping", "shutdown", () => "control" as const), Match.orElse(() => "short" as const)),
      begin: Match.value(command).pipe(Match.tag("begin", (begin) => Option.some({ session: begin.session, runId: begin.runId, turn: Option.none<number>() })), Match.orElse(() => Option.none())),
    }
    const admitted = yield* Ref.modify(state, (current) => {
      const next = admitProcessRequest(current, active, config)
      return [next, Result.getOrElse(next, () => current)] as const
    })
    if (Result.isFailure(admitted)) return yield* Match.value(admitted.failure).pipe(
      Match.when("Duplicate", () => fatal(new ProcessHostError({ reason: "Protocol", code: "protocol.sequence", message: "a command request id is already outstanding" }), command.requestId)),
      Match.when("Stopping", () => refuse(command.requestId, "host.stopping", "the process host is stopping")),
      Match.when("Busy", () => refuse(command.requestId, "host.busy", "the process command capacity is full")),
      Match.exhaustive,
    )
    const address = Match.value(command).pipe(
      Match.tag("begin", "send", "steer", "cancel", (value) => Option.some(value.session)),
      Match.tag("answer", (value) => Option.some(value.parent)), Match.orElse(() => Option.none()),
    )
    const released = Ref.update(state, (current) => releaseProcessRequest(current, command.requestId))
    if (Option.exists(address, (session) => !config.owners.includes(session.owner))) return yield* refuse(command.requestId, "host.owner", "the session owner is not available in this host").pipe(Effect.ensuring(released))
    if (command._tag === "shutdown") {
      if (command.deadlineMs !== undefined && command.deadlineMs > config.shutdown.deadlineMs) return yield* refuse(command.requestId, "host.command", "the shutdown deadline exceeds the host maximum").pipe(Effect.ensuring(released))
      return yield* runCommand(host, command)
    }
    yield* FiberSet.run(workers, runCommand(host, command).pipe(Effect.ensuring(released)))
  })

  const accept = (command: ProcessCommand): Effect.Effect<void, never, Scope.Scope> => Effect.gen(function* () {
    const current = yield* Ref.get(state)
    if (current._tag === "AwaitingHello") {
      if (command._tag !== "hello") return yield* fatal(new ProcessHostError({ reason: "Protocol", code: "protocol.handshake", message: "the first process command must be hello" }), command.requestId)
      if (command.protocolVersion !== PROCESS_PROTOCOL_VERSION) return yield* fatal(new ProcessHostError({ reason: "Protocol", code: "protocol.version", message: "the process protocol version is unsupported" }), command.requestId)
      yield* Ref.set(state, { _tag: "Starting", requests: [] })
      yield* send({ _tag: "hello", requestId: command.requestId, protocolVersion: PROCESS_PROTOCOL_VERSION })
      if ((yield* Ref.get(state))._tag === "Stopping") return
      const built = yield* options.setup(observe).pipe(Effect.map(Option.some),
        Effect.catch((cause) => fatal(new ProcessHostError({ reason: "Setup", code: "host.setup", message: "the process host could not be set up", cause })).pipe(Effect.as(Option.none<ProcessBinding>()))),
        Effect.catchDefect((cause) => fatal(new ProcessHostError({ reason: "Setup", code: "host.setup", message: "the process host setup failed", cause })).pipe(Effect.as(Option.none<ProcessBinding>()))),
      )
      if (Option.isSome(built)) {
        yield* Ref.set(binding, built)
        yield* Ref.update(state, openProcessDispatch)
      }
      return
    }
    const host = yield* Ref.get(binding)
    if (Option.isSome(host)) return yield* dispatch(host.value, command)
  })

  const reader = yield* peer.commands.pipe(Stream.runForEach(accept),
    Effect.andThen(Ref.get(state).pipe(Effect.flatMap((current) => current._tag === "AwaitingHello"
      ? fatal(new ProcessHostError({ reason: "Protocol", code: "protocol.handshake", message: "the process input ended before hello" }))
      : stop({ reason: "eof" })))),
    Effect.catch((cause) => fatal(peerFailure(cause))),
    Effect.catchDefect((cause) => fatal(new ProcessHostError({ reason: "Runtime", code: "host.runtime", message: "the process command reader failed", cause }))),
    Effect.forkScoped,
  )
  yield* Effect.sleep(config.handshakeTimeoutMs).pipe(Effect.andThen(Ref.get(state)), Effect.flatMap((current) => current._tag === "AwaitingHello"
    ? fatal(new ProcessHostError({ reason: "Protocol", code: "protocol.handshake", message: "the process hello deadline expired" })) : Effect.void), Effect.forkScoped)
  yield* (options.stop ?? Effect.never).pipe(Effect.andThen(stop({ reason: "signal" })),
    Effect.catchDefect((cause) => fatal(new ProcessHostError({ reason: "Runtime", code: "host.runtime", message: "the process stop signal failed", cause }))), Effect.forkScoped)

  const request = yield* Deferred.await(stopped)
  // Do not wait for a blocked reader before starting the host's shutdown.
  yield* Effect.forkScoped(Fiber.interrupt(reader))
  const host = yield* Ref.get(binding)
  const shutdownStarted = yield* Clock.currentTimeMillis
  const report = yield* Option.match(host, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (host) => host.shutdown({ deadline: request.deadlineMs ?? config.shutdown.deadlineMs, reserve: Math.min(config.shutdown.reserveMs, request.deadlineMs ?? config.shutdown.deadlineMs) }).pipe(
      Effect.map(Option.some), Effect.catchDefect((cause) => fatal(new ProcessHostError({ reason: "Runtime", code: "host.runtime", message: "the process shutdown failed", cause })).pipe(Effect.as(Option.none()))),
    ),
  })
  const remaining = Math.max(0, (request.deadlineMs ?? config.shutdown.deadlineMs) - ((yield* Clock.currentTimeMillis) - shutdownStarted))
  const responses = yield* FiberSet.awaitEmpty(workers).pipe(Effect.timeoutOption(Math.min(config.shutdown.reserveMs, remaining)))
  if (Option.isNone(responses)) yield* FiberSet.clear(workers)
  if (Option.isSome(report)) yield* send({ _tag: "shutdown", ...correlation(Option.fromNullishOr(request.requestId)), report: report.value })
  const failed = yield* Ref.get(failure)
  if (Option.isSome(failed)) yield* peer.send({ _tag: "error", ...correlation(Option.fromNullishOr(request.requestId)), code: failed.value.code, message: failed.value.message, fatal: true }).pipe(
    Effect.catch((cause) => Effect.logWarning("the process peer could not report the host failure").pipe(Effect.andThen(fatal(peerFailure(cause))))),
    Effect.catchDefect((cause) => fatal(new ProcessHostError({ reason: "Peer", code: "host.peer", message: "the process failure could not be written", cause }))),
  )
  yield* peer.flush.pipe(Effect.catch((cause) => fatal(peerFailure(cause))), Effect.catchDefect((cause) => fatal(new ProcessHostError({ reason: "Peer", code: "host.peer", message: "the process output could not be flushed", cause }))))
  const finalFailure = yield* Ref.get(failure)
  if (Option.isSome(finalFailure)) return yield* Effect.fail(finalFailure.value)
  return { reason: request.reason, report }
  }).pipe(Effect.onExit(() => notifyStopping)))
})
