import { Match, Option } from "effect"
import { canonicalJson, hostNote, resumeRefusal, UserMessage } from "@xandreed/core"
import type { InboxItemId, OpenTurn, SessionAddress } from "@xandreed/core"
import { DrainEvent, DrainTarget } from "./inbox-drain.entity.js"
import type { DrainHistory, DrainJob, DrainPolicy, DrainScheduler, DrainTakeover, InboxDrainConfig } from "./inbox-drain.entity.js"

export const emptyDrainScheduler: DrainScheduler = { jobs: {}, nextOrder: 0 }
export const drainKeyOf = (address: SessionAddress): string => canonicalJson([address.owner, address.id])
export const targetIdentity = (target: DrainTarget): string => DrainTarget.match(target, {
  Resume: (value) => canonicalJson(["resume", value.turn]),
  Queued: (value) => canonicalJson(["input", value.input]),
  Inbox: (value) => canonicalJson(["notice", value.first]),
})

/** The default is a host note, never words the user did not type; private queue metadata never enters this user message. */
export const resumeMessageOf = (policy: Extract<InboxDrainConfig["resume"], { readonly _tag: "Before" }>): UserMessage =>
  policy.userMessage ?? new UserMessage({ text: hostNote("The previous turn stopped before it finished. Continue it.") })

/** Queue facts, including claims, rather than head sequence numbers determine what still needs a turn. */
export const drainHistoryOf = (events: ReadonlyArray<DrainEvent>): DrainHistory => {
  const slots = new Map<InboxItemId, DrainHistory["slots"][number]>()
  const turns = new Map<number, DrainHistory["turns"][number]>()
  const claims = new Map<number, Set<InboxItemId>>()
  for (const event of events) DrainEvent.match(event, {
    Enqueued: (value) => {
      if (!slots.has(value.id)) slots.set(value.id, { id: value.id, delivery: value.delivery, claimedBy: Option.none() })
    },
    Started: (value) => {
      turns.set(value.turn, { turn: value.turn, runId: value.runId, origin: value.origin, resumes: value.resumes, input: value.input, ended: Option.none(), code: Option.none(), endedAt: Option.none() })
      for (const id of [...value.claimed, ...Option.toArray(value.input)]) {
        const slot = slots.get(id)
        if (slot === undefined || Option.isSome(slot.claimedBy)) continue
        slots.set(id, { ...slot, claimedBy: Option.some(value.turn) })
        const held = claims.get(value.turn)
        if (held) held.add(id)
        else claims.set(value.turn, new Set([id]))
      }
    },
    Ended: (value) => {
      const turn = turns.get(value.turn)
      if (turn) turns.set(value.turn, { ...turn, ended: Option.some(value.reason), code: value.code, endedAt: Option.some(value.seq) })
      for (const id of claims.get(value.turn) ?? []) {
        const slot = slots.get(id)
        if (slot === undefined || !Option.contains(slot.claimedBy, value.turn)) continue
        if (value.reason === "completed" || value.reason === "cancelled" || value.reason === "waiting" || (Option.isNone(slot.delivery) && value.reason === "partial")) slots.delete(id)
        else slots.set(id, { ...slot, claimedBy: Option.none() })
      }
      claims.delete(value.turn)
    },
    Removed: (value) => {
      const slot = slots.get(value.id)
      if (slot) Option.match(slot.claimedBy, { onNone: () => undefined, onSome: (turn) => claims.get(turn)?.delete(value.id) })
      slots.delete(value.id)
    },
  })
  return { slots: [...slots.values()], turns: [...turns.values()] }
}

/** Closes that say the turn's holder was gone (its lease ran out, it was taken over, its process shut down): never the work's fault. */
const HOLDER_GONE: ReadonlyArray<string> = ["turn.lease", "turn.takeover", "turn.shutdown"]

type DrainTurn = DrainHistory["turns"][number]

/**
 * How a turn stopped, for automatic recovery: `done` (completed, cancelled,
 * waiting); `failed` (failed or partial), which counts toward `attempts`;
 * `recoverable`, its holder gone (open with no live holder, or closed with
 * a lease, takeover or shutdown code) or interrupted at or before the
 * startup `baseline`, by an earlier process; `deliberate`, any other
 * interruption (its time limit, or the host interrupting it in this
 * process), which is never restarted automatically.
 */
type Stop = "done" | "failed" | "recoverable" | "deliberate"
const stopOf = (turn: DrainTurn, baseline: Option.Option<number>): Stop => Option.match(turn.ended, {
  onNone: (): Stop => "recoverable",
  onSome: (reason): Stop => Match.value(reason).pipe(
    Match.when("interrupted", (): Stop => Option.exists(turn.code, (code) => HOLDER_GONE.includes(code)) ? "recoverable"
      : Option.contains(turn.code, "turn.time-limit") ? "deliberate"
        : Option.exists(baseline, (seen) => Option.exists(turn.endedAt, (at) => at <= seen)) ? "recoverable" : "deliberate"),
    Match.when("failed", (): Stop => "failed"),
    Match.when("partial", (): Stop => "failed"),
    Match.orElse((): Stop => "done"),
  ),
})

/**
 * The interrupted user root to resume, when the latest user turn allows it
 * (its holder was gone, or it is a failed resume), with the failed resumes
 * of that root so far.
 */
const resumeRoot = (history: DrainHistory, policy: DrainPolicy): Option.Option<{ readonly root: number; readonly after: number; readonly failures: number }> => {
  const latest = history.turns.filter((turn) => turn.origin === "user").at(-1)
  if (policy.resume._tag !== "Before" || latest === undefined) return Option.none()
  const stop = stopOf(latest, policy.baseline)
  if (stop !== "recoverable" && !(stop === "failed" && Option.isSome(latest.resumes))) return Option.none()
  const turns = history.turns.map((turn) => Option.isNone(turn.ended) ? { ...turn, ended: Option.some("interrupted" as const) } : turn)
  const root = turns.find((turn) => turn.origin === "user" && Option.contains(turn.ended, "interrupted") && Option.isNone(resumeRefusal(turn.turn, turns)))
  return Option.map(Option.fromNullishOr(root), (found) => ({
    root: found.turn, after: latest.turn,
    failures: history.turns.filter((turn) => Option.contains(turn.resumes, found.turn) && stopOf(turn, policy.baseline) === "failed").length,
  }))
}

/**
 * Whether the drainer parked a queued input: as many of its runs as the
 * policy allows failed or stopped partial, or its latest run was stopped
 * deliberately. A parked input stays queued (only completion or a cancel
 * acknowledges it). A notice is bounded by the Sessions' own attempts.
 */
const inputParked = (history: DrainHistory, slot: DrainHistory["slots"][number], policy: DrainPolicy): boolean => {
  if (Option.isNone(slot.delivery)) return false
  const claims = history.turns.filter((turn) => Option.contains(turn.input, slot.id))
  const last = claims.at(-1)
  return claims.filter((turn) => stopOf(turn, policy.baseline) === "failed").length >= policy.attempts
    || (last !== undefined && stopOf(last, policy.baseline) === "deliberate")
}

/** Whether the drainer parked this target: a queued input, or an interrupted root whose resumes kept failing. */
export const isParked = (history: DrainHistory, target: DrainTarget, policy: DrainPolicy): boolean => DrainTarget.match(target, {
  Queued: (value) => history.slots.some((slot) => slot.id === value.input && inputParked(history, slot, policy)),
  Inbox: () => false,
  Resume: (value) => Option.exists(resumeRoot(history, policy), (found) => found.root === value.turn && found.failures >= policy.attempts),
})

/**
 * The next work for a session: its interrupted user root first, when the
 * latest user turn stopped because its holder was gone (or, for a startup
 * baseline, with an earlier process) or is a failed resume of it, while
 * fewer than `attempts` resumes of it failed; then its oldest waiting item
 * that is not parked. A turn stopped deliberately (its time limit, the host
 * interrupting it) or cancelled is not resumed. An open turn yields nothing
 * unless `takeOver` grants it.
 */
export const targetOf = (history: DrainHistory, open: Option.Option<OpenTurn>, policy: DrainPolicy, takeOver: boolean): Option.Option<DrainTarget> => {
  if (Option.isSome(open) && !takeOver) return Option.none()
  const root = Option.filter(resumeRoot(history, policy), (found) => found.failures < policy.attempts)
  if (Option.isSome(root)) return Option.some({ _tag: "Resume", turn: root.value.root, after: root.value.after })
  const abandoned = history.turns.filter((turn) => Option.isNone(turn.ended)).map((turn) => turn.turn)
  const first = history.slots.find((slot) => (Option.isNone(slot.claimedBy) || Option.exists(slot.claimedBy, (turn) => abandoned.includes(turn))) && !inputParked(history, slot, policy))
  return Option.map(Option.fromNullishOr(first), (slot): DrainTarget => Option.isSome(slot.delivery) ? { _tag: "Queued", input: slot.id } : { _tag: "Inbox", first: slot.id })
}

/** A foreign claim blocks execution without acknowledging its pending payload; a parked target no longer waits for the drainer. */
export const targetPending = (history: DrainHistory, target: DrainTarget, policy: DrainPolicy): boolean => DrainTarget.match(target, {
  Queued: (value) => history.slots.some((slot) => slot.id === value.input && Option.isSome(slot.delivery) && !inputParked(history, slot, policy)),
  Inbox: (value) => history.slots.some((slot) => slot.id === value.first && Option.isNone(slot.delivery)),
  Resume: () => Option.exists(targetOf(history, Option.none(), policy, false), (candidate) => targetIdentity(candidate) === targetIdentity(target)),
})

/** Wakes refresh targets without resetting payload-specific retry deadlines or stealing a running session. */
export const observeDrains = (state: DrainScheduler, candidates: ReadonlyArray<{ readonly address: SessionAddress; readonly target: DrainTarget; readonly takeOver: Option.Option<DrainTakeover> }>, startup: boolean): DrainScheduler => {
  const observed = candidates.reduce((current: DrainScheduler, candidate): DrainScheduler => {
    const key = drainKeyOf(candidate.address)
    const previous = current.jobs[key]
    if (previous?._tag === "Running") return current
    const same = previous !== undefined && targetIdentity(previous.target) === targetIdentity(candidate.target)
    const job: DrainJob = same ? { ...previous, target: candidate.target } : {
      _tag: "Ready", address: candidate.address, target: candidate.target, failures: 0, order: current.nextOrder,
      takeOver: previous === undefined && startup ? candidate.takeOver : Option.none(),
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
  return [Option.some(claimed), { ...state, jobs: { ...state.jobs, [drainKeyOf(first.address)]: { ...claimed, takeOver: Option.none() } } }]
}

/** Retried work takes a new fair ticket; its identity, not a newer journal seq, carries the failure streak. */
export const finishDrain = (state: DrainScheduler, job: DrainJob, target: Option.Option<DrainTarget>, retry: boolean, now: number, backoff: InboxDrainConfig["backoff"]): DrainScheduler => {
  const key = drainKeyOf(job.address)
  if (Option.isNone(target) || !retry) return { ...state, jobs: Object.fromEntries(Object.entries(state.jobs).filter(([held]) => held !== key)) }
  const failures = targetIdentity(job.target) === targetIdentity(target.value) ? Math.min(Number.MAX_SAFE_INTEGER, job.failures + 1) : 1
  const delay = Math.min(backoff.maxMs, backoff.initialMs * 2 ** Math.min(failures - 1, 52))
  return {
    jobs: { ...state.jobs, [key]: { _tag: "Delayed", address: job.address, target: target.value, failures, due: now + delay, takeOver: Option.none(), order: state.nextOrder } },
    nextOrder: state.nextOrder + 1,
  }
}

export const nextDrainDelay = (state: DrainScheduler, now: number, fallback: number): number =>
  Object.values(state.jobs).reduce((delay, job) => job._tag === "Delayed" ? Math.min(delay, Math.max(1, job.due - now)) : delay, fallback)
