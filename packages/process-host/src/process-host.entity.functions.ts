import { Match, Option, Result } from "effect"
import type { RunId, SessionAddress } from "@xandreed/core"
import type { ProcessRequestId } from "./process-protocol.entity.js"
import type { ProcessActiveRequest, ProcessDispatchState, ProcessHostConfig } from "./process-host.entity.js"

/** Decide admission without blocking the reader behind a running command. */
export const admitProcessRequest = (state: ProcessDispatchState, request: ProcessActiveRequest, config: ProcessHostConfig): Result.Result<ProcessDispatchState, "Duplicate" | "Stopping" | "Busy"> => {
  if (state.requests.some((active) => active.requestId === request.requestId)) return Result.fail("Duplicate")
  return Match.value(state).pipe(Match.tag("Open", (open): Result.Result<ProcessDispatchState, "Busy"> => {
    const maximum = { begin: config.maxBegins, short: config.maxShortCommands, control: config.controlCapacity }[request.lane]
    if (open.requests.filter((active) => active.lane === request.lane).length >= maximum) return Result.fail("Busy")
    return Result.succeed({ ...open, requests: [...open.requests, request] })
  }), Match.orElse(() => Result.fail("Stopping" as const)))
}

export const openProcessDispatch = (state: ProcessDispatchState): ProcessDispatchState => Match.value(state).pipe(
  Match.tag("Stopping", (stopping) => stopping),
  Match.orElse((current) => ({ _tag: "Open" as const, requests: current.requests })),
)

export const stopProcessDispatch = (state: ProcessDispatchState): ProcessDispatchState => ({ _tag: "Stopping", requests: state.requests })

export const releaseProcessRequest = (state: ProcessDispatchState, requestId: ProcessRequestId): ProcessDispatchState => ({ ...state, requests: state.requests.filter((request) => request.requestId !== requestId) })

export const processRequestOf = (state: ProcessDispatchState, session: SessionAddress, runId: RunId): Option.Option<ProcessRequestId> => {
  const candidates = state.requests.filter((request) => Option.exists(request.begin, (begin) => begin.session.id === session.id && begin.session.owner === session.owner && begin.runId === runId))
  return candidates.length === 1 ? Option.fromNullishOr(candidates[0]).pipe(Option.map((request) => request.requestId)) : Option.none()
}

export const noteProcessTurn = (state: ProcessDispatchState, session: SessionAddress, runId: RunId, turn: number): ProcessDispatchState => {
  const requestId = processRequestOf(state, session, runId)
  return { ...state, requests: state.requests.map((request) => Option.contains(requestId, request.requestId)
    ? { ...request, begin: Option.map(request.begin, (begin) => ({ ...begin, turn: Option.some(turn) })) } : request) }
}

export const endedProcessRequestOf = (state: ProcessDispatchState, session: SessionAddress, turn: number): Option.Option<ProcessRequestId> => Option.fromNullishOr(state.requests.find((request) =>
  Option.exists(request.begin, (begin) => begin.session.id === session.id && begin.session.owner === session.owner && Option.contains(begin.turn, turn)),
)).pipe(Option.map((request) => request.requestId))
