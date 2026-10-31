import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { ConversationId, InboxItemId, RunId, UserMessage } from "@xandreed/core"
import { claimDrain, drainHistoryOf, drainKeyOf, emptyDrainScheduler, finishDrain, observeDrains, resumeMessageOf, targetOf, targetIdentity, targetPending } from "./inbox-drain.entity.functions.js"
import { inboxDrainDefaults, InboxDrainConfig } from "./inbox-drain.entity.js"
import type { DrainEvent, DrainTarget } from "./inbox-drain.entity.js"

const address = (n: number) => ({ owner: "owner", id: ConversationId.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`) })
const target = (id: string): DrainTarget => ({ _tag: "Queued", input: InboxItemId.make(id) })
const started = (turn: number, resumes?: number): Extract<DrainEvent, { _tag: "Started" }> => ({ _tag: "Started", turn, runId: RunId.make(`run-${turn}`), origin: "user", resumes: Option.fromNullishOr(resumes), claimed: [], input: Option.none() })

describe("inbox drain policy and scheduler", () => {
  test("owners and bounded policy are checked; default resume wording and host override are exact", () => {
    expect(Schema.decodeUnknownOption(InboxDrainConfig)({ ...inboxDrainDefaults, owners: [] })).toEqual(Option.none())
    expect(Schema.decodeUnknownOption(InboxDrainConfig)({ ...inboxDrainDefaults, owners: ["owner"], backoff: { initialMs: 5, maxMs: 4 } })).toEqual(Option.none())
    expect(resumeMessageOf({ _tag: "Before" }).text).toBe("Continue.")
    expect(resumeMessageOf({ _tag: "Before", userMessage: new UserMessage({ text: "Resume this work." }) })).toEqual(new UserMessage({ text: "Resume this work." }))
  })

  test("a failed resume keeps the oldest eligible root; explicit cancellation of the latest resume stops automatic recovery", () => {
    const events: ReadonlyArray<DrainEvent> = [started(1), { _tag: "Ended", turn: 1, reason: "interrupted" }, started(2, 1), { _tag: "Ended", turn: 2, reason: "failed" }]
    expect(targetOf(drainHistoryOf(events), Option.none(), { _tag: "Before" }, false)).toEqual(Option.some({ _tag: "Resume", turn: 1, after: 2 }))
    expect(targetOf(drainHistoryOf([...events, started(3, 1), { _tag: "Ended", turn: 3, reason: "cancelled" }]), Option.none(), { _tag: "Before" }, false)).toEqual(Option.none())
    expect(targetOf(drainHistoryOf(events), Option.none(), { _tag: "Never" }, false)).toEqual(Option.none())
  })

  test("blocked claims retain retry identity until acknowledgment, and a cancelled resume stays stopped", () => {
    const queued: DrainEvent = { _tag: "Enqueued", id: InboxItemId.make("held"), delivery: Option.some("next") }
    const claim: DrainEvent = { ...started(1), input: Option.some(InboxItemId.make("held")) }
    const pending = drainHistoryOf([queued, claim])
    expect(targetPending(pending, target("held"), { _tag: "Never" })).toBe(true)
    expect(targetPending(drainHistoryOf([queued, claim, { _tag: "Ended", turn: 1, reason: "completed" }]), target("held"), { _tag: "Never" })).toBe(false)
    expect(targetPending(drainHistoryOf([started(1), { _tag: "Ended", turn: 1, reason: "interrupted" }, started(2, 1)]), { _tag: "Resume", turn: 1, after: 2 }, { _tag: "Before" })).toBe(true)
    expect(targetPending(drainHistoryOf([started(1), { _tag: "Ended", turn: 1, reason: "interrupted" }, started(2, 1), { _tag: "Ended", turn: 2, reason: "cancelled" }]), { _tag: "Resume", turn: 1, after: 2 }, { _tag: "Before" })).toBe(false)
  })

  test("queue facts keep taken/acknowledged input absent and release partial input without concatenating notices", () => {
    const events: ReadonlyArray<DrainEvent> = [
      { _tag: "Enqueued", id: InboxItemId.make("q"), delivery: Option.some("next") },
      { _tag: "Enqueued", id: InboxItemId.make("notice"), delivery: Option.none() },
      { ...started(1), input: Option.some(InboxItemId.make("q")) }, { _tag: "Ended", turn: 1, reason: "partial" },
    ]
    expect(targetOf(drainHistoryOf(events), Option.none(), { _tag: "Never" }, false)).toEqual(Option.some(target("q")))
    expect(targetOf(drainHistoryOf([...events, { _tag: "Removed", id: InboxItemId.make("q") }]), Option.none(), { _tag: "Never" }, false)).toEqual(Option.some({ _tag: "Inbox", first: InboxItemId.make("notice") }))
    expect(drainHistoryOf([...events, { ...started(2, 1), input: Option.some(InboxItemId.make("q")) }, { _tag: "Ended", turn: 2, reason: "cancelled" }, { ...started(3, 1), input: Option.some(InboxItemId.make("q")) }, { _tag: "Ended", turn: 3, reason: "failed" }]).slots.map((slot) => String(slot.id))).toEqual(["notice"])
  })

  test("waiting acknowledges only the asking turn's claim and preserves an early answer for a new turn", () => {
    const input = InboxItemId.make("asking")
    const answer = InboxItemId.make("early-answer")
    const history = drainHistoryOf([
      { _tag: "Enqueued", id: input, delivery: Option.some("next") },
      { ...started(1), input: Option.some(input) },
      { _tag: "Enqueued", id: answer, delivery: Option.some("next") },
      { _tag: "Ended", turn: 1, reason: "waiting" },
    ])
    expect(history.slots.map((slot) => slot.id)).toEqual([answer])
    expect(targetPending(history, target("asking"), { _tag: "Before" })).toBe(false)
    expect(targetOf(history, Option.none(), { _tag: "Before" }, false)).toEqual(Option.some(target("early-answer")))
    expect(targetOf(drainHistoryOf([started(1), { _tag: "Ended", turn: 1, reason: "waiting" }]), Option.none(), { _tag: "Before" }, false)).toEqual(Option.none())
    const notice = drainHistoryOf([
      { _tag: "Enqueued", id: input, delivery: Option.none() },
      { ...started(1), origin: "inbox", claimed: [input] },
      { _tag: "Ended", turn: 1, reason: "waiting" },
    ])
    expect(notice.slots).toEqual([])
  })

  test("wakes preserve a payload's delay; retry tickets yield to other sessions and startup takeover is consumed once", () => {
    const first = address(1)
    const second = address(2)
    const observed = observeDrains(emptyDrainScheduler, [{ address: first, target: target("q") }, { address: second, target: target("other") }], true)
    const [claimed, running] = claimDrain(observed, 0)
    expect(Option.map(claimed, (job) => job.startup)).toEqual(Option.some(true))
    const job = Option.getOrThrow(claimed)
    const failed = finishDrain(running, job, Option.some(job.target), true, 0, { initialMs: 5, maxMs: 20 })
    const woken = observeDrains(failed, [{ address: first, target: target("q") }, { address: second, target: target("other") }], false)
    expect(woken.jobs[drainKeyOf(first)]).toMatchObject({ _tag: "Delayed", due: 5, failures: 1, startup: false })
    expect(Option.map(claimDrain(woken, 100)[0], (next) => targetIdentity(next.target))).toEqual(Option.some(targetIdentity(target("other"))))
    const [next, state] = claimDrain(observeDrains(emptyDrainScheduler, [{ address: first, target: target("q") }], true), 0)
    const delayed = finishDrain(state, Option.getOrThrow(next), next.pipe(Option.map((value) => value.target)), true, 0, { initialMs: 5, maxMs: 20 })
    expect(Option.map(claimDrain(delayed, 5)[0], (value) => value.startup)).toEqual(Option.some(false))
    expect(observeDrains(delayed, [], false).jobs[drainKeyOf(first)]).toMatchObject({ _tag: "Delayed", due: 5 })
  })
})
