import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { ConversationId, InboxItemId, RunId, UserMessage } from "@xandreed/core"
import { claimDrain, drainHistoryOf, drainKeyOf, emptyDrainScheduler, finishDrain, isParked, observeDrains, resumeMessageOf, targetOf, targetIdentity, targetPending } from "./inbox-drain.entity.functions.js"
import { inboxDrainDefaults, InboxDrainConfig } from "./inbox-drain.entity.js"
import type { DrainEvent, DrainPolicy, DrainTarget } from "./inbox-drain.entity.js"

const address = (n: number) => ({ owner: "owner", id: ConversationId.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`) })
const target = (id: string): DrainTarget => ({ _tag: "Queued", input: InboxItemId.make(id) })
const started = (turn: number, resumes?: number, input?: string): Extract<DrainEvent, { _tag: "Started" }> => ({
  _tag: "Started", turn, runId: RunId.make(`run-${turn}`), origin: "user", resumes: Option.fromNullishOr(resumes), claimed: [], input: Option.map(Option.fromNullishOr(input), InboxItemId.make),
})
const ended = (turn: number, reason: Extract<DrainEvent, { _tag: "Ended" }>["reason"], code?: string, seq = 100 + turn): DrainEvent => ({ _tag: "Ended", turn, reason, code: Option.fromNullishOr(code), seq })
const enqueued = (id: string): DrainEvent => ({ _tag: "Enqueued", id: InboxItemId.make(id), delivery: Option.some("next") })
const policy = (resume: DrainPolicy["resume"], attempts = 3, baseline?: number): DrainPolicy => ({ resume, attempts, baseline: Option.fromNullishOr(baseline) })
const before = policy({ _tag: "Before" })
const never = policy({ _tag: "Never" })

describe("inbox drain policy and scheduler", () => {
  test("owners, attempts and bounded policy are checked; the default resume message is an exact host note and a host's override is kept", () => {
    expect(Schema.decodeUnknownOption(InboxDrainConfig)({ ...inboxDrainDefaults, owners: [] })).toEqual(Option.none())
    expect(Schema.decodeUnknownOption(InboxDrainConfig)({ ...inboxDrainDefaults, owners: ["owner"], backoff: { initialMs: 5, maxMs: 4 } })).toEqual(Option.none())
    expect(Schema.decodeUnknownOption(InboxDrainConfig)({ ...inboxDrainDefaults, owners: ["owner"], attempts: 0 })).toEqual(Option.none())
    expect(inboxDrainDefaults.attempts).toBe(3)
    expect(resumeMessageOf({ _tag: "Before" }).text).toBe("[Host note: The previous turn stopped before it finished. Continue it.]")
    expect(resumeMessageOf({ _tag: "Before", userMessage: new UserMessage({ text: "Resume this work." }) })).toEqual(new UserMessage({ text: "Resume this work." }))
  })

  test("a failed resume keeps the oldest eligible root; explicit cancellation of the latest resume stops automatic recovery", () => {
    const events: ReadonlyArray<DrainEvent> = [started(1), ended(1, "interrupted", "turn.lease"), started(2, 1), ended(2, "failed")]
    expect(targetOf(drainHistoryOf(events), Option.none(), before, false)).toEqual(Option.some({ _tag: "Resume", turn: 1, after: 2 }))
    expect(targetOf(drainHistoryOf([...events, started(3, 1), ended(3, "cancelled")]), Option.none(), before, false)).toEqual(Option.none())
    expect(targetOf(drainHistoryOf(events), Option.none(), never, false)).toEqual(Option.none())
  })

  test("only a turn whose holder was gone, or one an earlier process left interrupted, is resumed: never a time limit or the host's own interruption", () => {
    const stopped = (code?: string, seq?: number) => drainHistoryOf([started(1), ended(1, "interrupted", code, seq)])
    const resume = Option.some({ _tag: "Resume" as const, turn: 1, after: 1 })
    expect(targetOf(stopped("turn.lease"), Option.none(), before, false)).toEqual(resume)
    expect(targetOf(stopped("turn.takeover"), Option.none(), before, false)).toEqual(resume)
    expect(targetOf(stopped("turn.shutdown"), Option.none(), before, false)).toEqual(resume)
    expect(targetOf(drainHistoryOf([started(1)]), Option.none(), before, false)).toEqual(resume)
    expect(targetOf(stopped("turn.time-limit"), Option.none(), before, false)).toEqual(Option.none())
    expect(targetOf(stopped("turn.time-limit", 5), Option.none(), policy({ _tag: "Before" }, 3, 10), false)).toEqual(Option.none())
    expect(targetOf(stopped("turn.interrupted", 5), Option.none(), before, false)).toEqual(Option.none())
    expect(targetOf(stopped(undefined, 5), Option.none(), before, false)).toEqual(Option.none())
    // Interrupted before the startup sweep saw the session (an earlier process stopped), not after it.
    expect(targetOf(stopped("turn.interrupted", 5), Option.none(), policy({ _tag: "Before" }, 3, 5), false)).toEqual(resume)
    expect(targetOf(stopped("turn.interrupted", 6), Option.none(), policy({ _tag: "Before" }, 3, 5), false)).toEqual(Option.none())
    // A host's manual resume of a time-limited turn whose holder then died is recovered.
    expect(targetOf(drainHistoryOf([started(1), ended(1, "interrupted", "turn.time-limit"), started(2, 1), ended(2, "interrupted", "turn.lease")]), Option.none(), before, false))
      .toEqual(Option.some({ _tag: "Resume", turn: 1, after: 2 }))
  })

  test("a deliberately stopped queued input is parked at once and later input passes it", () => {
    const history = drainHistoryOf([enqueued("long"), enqueued("later"), started(1, undefined, "long"), ended(1, "interrupted", "turn.time-limit")])
    expect(targetOf(history, Option.none(), before, false)).toEqual(Option.some(target("later")))
    expect(isParked(history, target("long"), before)).toBe(true)
    expect(targetPending(history, target("long"), before)).toBe(false)
    expect(history.slots.map((slot) => String(slot.id))).toEqual(["long", "later"])
    // Its holder gone instead, it runs again first, uncounted.
    const lost = drainHistoryOf([enqueued("long"), enqueued("later"), started(1, undefined, "long"), ended(1, "interrupted", "turn.lease")])
    expect(targetOf(lost, Option.none(), never, false)).toEqual(Option.some(target("long")))
    expect(isParked(lost, target("long"), never)).toBe(false)
  })

  test("an input that keeps failing or stopping partial is parked after the attempt limit and stays queued while later input runs", () => {
    const runs = (outcomes: ReadonlyArray<"failed" | "partial">): ReadonlyArray<DrainEvent> => outcomes.flatMap((reason, index) => [started(index + 1, undefined, "poison"), ended(index + 1, reason)])
    const after = (outcomes: ReadonlyArray<"failed" | "partial">) => drainHistoryOf([enqueued("poison"), enqueued("later"), ...runs(outcomes)])
    expect(targetOf(after(["failed", "partial"]), Option.none(), before, false)).toEqual(Option.some(target("poison")))
    expect(isParked(after(["failed", "partial"]), target("poison"), before)).toBe(false)
    const parked = after(["failed", "partial", "failed"])
    expect(targetOf(parked, Option.none(), before, false)).toEqual(Option.some(target("later")))
    expect(isParked(parked, target("poison"), before)).toBe(true)
    expect(parked.slots.map((slot) => String(slot.id))).toEqual(["poison", "later"])
    expect(targetOf(after(["failed"]), Option.none(), policy({ _tag: "Before" }, 1), false)).toEqual(Option.some(target("later")))
  })

  test("failed resumes of one root park the branch after the attempt limit, with the input it reclaimed", () => {
    const resumes = (count: number): ReadonlyArray<DrainEvent> => Array.from({ length: count }, (_, index) => [started(index + 2, 1, "root-input"), ended(index + 2, "failed")]).flat()
    const branch = (count: number) => drainHistoryOf([enqueued("root-input"), enqueued("later"), started(1, undefined, "root-input"), ended(1, "interrupted", "turn.lease"), ...resumes(count)])
    expect(targetOf(branch(2), Option.none(), before, false)).toEqual(Option.some({ _tag: "Resume", turn: 1, after: 3 }))
    expect(targetOf(branch(3), Option.none(), before, false)).toEqual(Option.some(target("later")))
    expect(isParked(branch(3), { _tag: "Resume", turn: 1, after: 4 }, before)).toBe(true)
    expect(isParked(branch(3), target("root-input"), before)).toBe(true)
  })

  test("blocked claims retain retry identity until acknowledgment, and a cancelled resume stays stopped", () => {
    const queued: DrainEvent = { _tag: "Enqueued", id: InboxItemId.make("held"), delivery: Option.some("next") }
    const claim: DrainEvent = started(1, undefined, "held")
    const pending = drainHistoryOf([queued, claim])
    expect(targetPending(pending, target("held"), never)).toBe(true)
    expect(targetPending(drainHistoryOf([queued, claim, ended(1, "completed")]), target("held"), never)).toBe(false)
    expect(targetPending(drainHistoryOf([started(1), ended(1, "interrupted", "turn.lease"), started(2, 1)]), { _tag: "Resume", turn: 1, after: 2 }, before)).toBe(true)
    expect(targetPending(drainHistoryOf([started(1), ended(1, "interrupted", "turn.lease"), started(2, 1), ended(2, "cancelled")]), { _tag: "Resume", turn: 1, after: 2 }, before)).toBe(false)
  })

  test("queue facts keep taken/acknowledged input absent and release partial input without concatenating notices", () => {
    const events: ReadonlyArray<DrainEvent> = [
      enqueued("q"),
      { _tag: "Enqueued", id: InboxItemId.make("notice"), delivery: Option.none() },
      started(1, undefined, "q"), ended(1, "partial"),
    ]
    expect(targetOf(drainHistoryOf(events), Option.none(), never, false)).toEqual(Option.some(target("q")))
    expect(targetOf(drainHistoryOf([...events, { _tag: "Removed", id: InboxItemId.make("q") }]), Option.none(), never, false)).toEqual(Option.some({ _tag: "Inbox", first: InboxItemId.make("notice") }))
    expect(drainHistoryOf([...events, started(2, 1, "q"), ended(2, "cancelled"), started(3, 1, "q"), ended(3, "failed")]).slots.map((slot) => String(slot.id))).toEqual(["notice"])
  })

  test("waiting acknowledges only the asking turn's claim and preserves an early answer for a new turn", () => {
    const input = InboxItemId.make("asking")
    const answer = InboxItemId.make("early-answer")
    const history = drainHistoryOf([
      { _tag: "Enqueued", id: input, delivery: Option.some("next") },
      started(1, undefined, "asking"),
      { _tag: "Enqueued", id: answer, delivery: Option.some("next") },
      ended(1, "waiting"),
    ])
    expect(history.slots.map((slot) => slot.id)).toEqual([answer])
    expect(targetPending(history, target("asking"), before)).toBe(false)
    expect(targetOf(history, Option.none(), before, false)).toEqual(Option.some(target("early-answer")))
    expect(targetOf(drainHistoryOf([started(1), ended(1, "waiting")]), Option.none(), before, false)).toEqual(Option.none())
    const notice = drainHistoryOf([
      { _tag: "Enqueued", id: input, delivery: Option.none() },
      { ...started(1), origin: "inbox", claimed: [input] },
      ended(1, "waiting"),
    ])
    expect(notice.slots).toEqual([])
  })

  test("wakes preserve a payload's delay; retry tickets yield to other sessions and startup takeover names one turn and is consumed once", () => {
    const first = address(1)
    const second = address(2)
    const seen = Option.some({ turn: 4, runId: RunId.make("abandoned") })
    const observed = observeDrains(emptyDrainScheduler, [{ address: first, target: target("q"), takeOver: seen }, { address: second, target: target("other"), takeOver: Option.none() }], true)
    const [claimed, running] = claimDrain(observed, 0)
    expect(Option.map(claimed, (job) => job.takeOver)).toEqual(Option.some(seen))
    expect(running.jobs[drainKeyOf(first)]?.takeOver).toEqual(Option.none())
    const job = Option.getOrThrow(claimed)
    const failed = finishDrain(running, job, Option.some(job.target), true, 0, { initialMs: 5, maxMs: 20 })
    const woken = observeDrains(failed, [{ address: first, target: target("q"), takeOver: seen }, { address: second, target: target("other"), takeOver: Option.none() }], false)
    expect(woken.jobs[drainKeyOf(first)]).toMatchObject({ _tag: "Delayed", due: 5, failures: 1, takeOver: Option.none() })
    expect(Option.map(claimDrain(woken, 100)[0], (next) => targetIdentity(next.target))).toEqual(Option.some(targetIdentity(target("other"))))
    const [next, state] = claimDrain(observeDrains(emptyDrainScheduler, [{ address: first, target: target("q"), takeOver: seen }], true), 0)
    const delayed = finishDrain(state, Option.getOrThrow(next), next.pipe(Option.map((value) => value.target)), true, 0, { initialMs: 5, maxMs: 20 })
    expect(Option.map(claimDrain(delayed, 5)[0], (value) => value.takeOver)).toEqual(Option.some(Option.none()))
    expect(observeDrains(delayed, [], false).jobs[drainKeyOf(first)]).toMatchObject({ _tag: "Delayed", due: 5 })
    // A later scan grants no takeover, even for a session it sees for the first time.
    expect(observeDrains(emptyDrainScheduler, [{ address: second, target: target("other"), takeOver: seen }], false).jobs[drainKeyOf(second)]?.takeOver).toEqual(Option.none())
  })
})
