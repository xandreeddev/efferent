import { Option } from "effect"
import { canonicalJson, resumeRefusal, UserMessage } from "@xandreed/core"
import type { OpenTurn, SessionAddress } from "@xandreed/core"
import { DrainEvent, DrainTarget } from "./inbox-drain.entity.js"
import type { DrainHistory, DrainJob, DrainScheduler, InboxDrainConfig } from "./inbox-drain.entity.js"

export const emptyDrainScheduler: DrainScheduler = { jobs: {}, nextOrder: 0 }
export const drainKeyOf = (address: SessionAddress): string => canonicalJson([address.owner, address.id])
export const targetIdentity = (target: DrainTarget): string => DrainTarget.match(target, {
  Resume: (value) => canonicalJson(["resume", value.turn]),
  Queued: (value) => canonicalJson(["input", value.input]),
  Inbox: (value) => canonicalJson(["notice", value.first]),
})

/** The default is deliberately small; private queue metadata never enters this user message. */
export const resumeMessageOf = (policy: Extract<InboxDrainConfig["resume"], { readonly _tag: "Before" }>): UserMessage =>
  policy.userMessage ?? new UserMessage({ text: "Continue." })

/** Queue facts, including claims, rather than head sequence numbers determine what still needs a turn. */
export const drainHistoryOf = (events: ReadonlyArray<DrainEvent>): DrainHistory => events.reduce((history: DrainHistory, event): DrainHistory => DrainEvent.match(event, {
  Enqueued: (value) => history.slots.some((slot) => slot.id === value.id) ? history
    : { ...history, slots: [...history.slots, { id: value.id, delivery: value.delivery, claimedBy: Option.none() }] },
  Started: (value) => ({
    turns: [...history.turns, { turn: value.turn, runId: value.runId, origin: value.origin, resumes: value.resumes, ended: Option.none() }],
    slots: history.slots.map((slot) => Option.isNone(slot.claimedBy) && (value.claimed.includes(slot.id) || Option.contains(value.input, slot.id))
      ? { ...slot, claimedBy: Option.some(value.turn) } : slot),
  }),
  Ended: (value) => ({
    turns: history.turns.map((turn) => turn.turn === value.turn ? { ...turn, ended: Option.some(value.reason) } : turn),
    slots: history.slots.flatMap((slot) => !Option.contains(slot.claimedBy, value.turn) ? [slot]
      : value.reason === "completed" || value.reason === "cancelled" || (Option.isNone(slot.delivery) && value.reason === "partial") ? []
        : [{ ...slot, claimedBy: Option.none() }]),
  }),
  Removed: (value) => ({ ...history, slots: history.slots.filter((slot) => slot.id !== value.id) }),
}), { slots: [], turns: [] })

/** Only interrupted user branches recover automatically; cancellation of the latest attempt stops the branch. */
export const targetOf = (history: DrainHistory, open: Option.Option<OpenTurn>, policy: InboxDrainConfig["resume"], takeOver: boolean): Option.Option<DrainTarget> => {
  if (Option.isSome(open) && !takeOver) return Option.none()
  const turns = history.turns.map((turn) => Option.isNone(turn.ended) ? { ...turn, ended: Option.some("interrupted" as const) } : turn)
  const latest = turns.filter((turn) => turn.origin === "user").at(-1)
  const candidates = policy._tag === "Before" && latest !== undefined && !Option.contains(latest.ended, "cancelled")
    ? turns.filter((turn) => turn.origin === "user" && Option.contains(turn.ended, "interrupted") && Option.isNone(resumeRefusal(turn.turn, turns))) : []
  const root = candidates.at(0)
  if (root !== undefined) return Option.some({ _tag: "Resume", turn: root.turn, after: latest?.turn ?? root.turn })
  const abandoned = history.turns.filter((turn) => Option.isNone(turn.ended)).map((turn) => turn.turn)
  const first = history.slots.find((slot) => Option.isNone(slot.claimedBy) || Option.exists(slot.claimedBy, (turn) => abandoned.includes(turn)))
  return Option.map(Option.fromNullishOr(first), (slot): DrainTarget => Option.isSome(slot.delivery) ? { _tag: "Queued", input: slot.id } : { _tag: "Inbox", first: slot.id })
}

/** A foreign claim blocks execution without acknowledging its pending payload. */
export const targetPending = (history: DrainHistory, target: DrainTarget, policy: InboxDrainConfig["resume"]): boolean => DrainTarget.match(target, {
  Queued: (value) => history.slots.some((slot) => slot.id === value.input && Option.isSome(slot.delivery)),
  Inbox: (value) => history.slots.some((slot) => slot.id === value.first && Option.isNone(slot.delivery)),
  Resume: () => Option.exists(targetOf(history, Option.none(), policy, false), (candidate) => targetIdentity(candidate) === targetIdentity(target)),
})

/** Wakes refresh targets without resetting payload-specific retry deadlines or stealing a running session. */
export const observeDrains = (state: DrainScheduler, candidates: ReadonlyArray<{ readonly address: SessionAddress; readonly target: DrainTarget }>, startup: boolean): DrainScheduler => {
  const observed = candidates.reduce((current: DrainScheduler, candidate): DrainScheduler => {
    const key = drainKeyOf(candidate.address)
    const previous = current.jobs[key]
    if (previous?._tag === "Running") return current
    const same = previous !== undefined && targetIdentity(previous.target) === targetIdentity(candidate.target)
    const job: DrainJob = same ? { ...previous, target: candidate.target } : {
      _tag: "Ready", ...candidate, failures: 0, order: current.nextOrder, startup: previous === undefined && startup,
    }
    return { jobs: { ...current.jobs, [key]: job }, nextOrder: same ? current.nextOrder : current.nextOrder + 1 }
  }, state)
  const wanted = new Set(candidates.map((candidate) => drainKeyOf(candidate.address)))
  return { ...observed, jobs: Object.fromEntries(Object.entries(observed.jobs).filter(([key, job]) => job._tag !== "Ready" || wanted.has(key))) }
}

/** Atomic claim gives each address one running owner and consumes startup authority before the attempt. */
export const claimDrain = (state: DrainScheduler, now: number): readonly [Option.Option<Extract<DrainJob, { readonly _tag: "Running" }>>, DrainScheduler] => {
  const first = Object.values(state.jobs).filter((job) => job._tag === "Ready" || (job._tag === "Delayed" && job.due <= now)).sort((a, b) => a.order - b.order).at(0)
  if (first === undefined) return [Option.none(), state]
  const claimed = { ...first, _tag: "Running" as const }
  return [Option.some(claimed), { ...state, jobs: { ...state.jobs, [drainKeyOf(first.address)]: { ...claimed, startup: false } } }]
}

/** Retried work takes a new fair ticket; its identity, not a newer journal seq, carries the failure streak. */
export const finishDrain = (state: DrainScheduler, job: DrainJob, target: Option.Option<DrainTarget>, retry: boolean, now: number, backoff: InboxDrainConfig["backoff"]): DrainScheduler => {
  const key = drainKeyOf(job.address)
  if (Option.isNone(target) || !retry) return { ...state, jobs: Object.fromEntries(Object.entries(state.jobs).filter(([held]) => held !== key)) }
  const failures = targetIdentity(job.target) === targetIdentity(target.value) ? Math.min(Number.MAX_SAFE_INTEGER, job.failures + 1) : 1
  const delay = Math.min(backoff.maxMs, backoff.initialMs * 2 ** Math.min(failures - 1, 52))
  return {
    jobs: { ...state.jobs, [key]: { _tag: "Delayed", address: job.address, target: target.value, failures, due: now + delay, startup: false, order: state.nextOrder } },
    nextOrder: state.nextOrder + 1,
  }
}

export const nextDrainDelay = (state: DrainScheduler, now: number, fallback: number): number =>
  Object.values(state.jobs).reduce((delay, job) => job._tag === "Delayed" ? Math.min(delay, Math.max(1, job.due - now)) : delay, fallback)
