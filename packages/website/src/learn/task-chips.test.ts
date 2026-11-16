// The chat's task chips (lesson 17), as a fold of what the page hears: a task
// starts from startTask's stored result, ends as its own session's turn does,
// waits, is reported, cancelled, stopped with the program or dropped. These
// feed the fold the records a run makes, in the orders a run can make them;
// lesson 17's page tests read the same chips from real runs.
import { describe, expect, test } from "bun:test"
import { assistantMessage, Seq, SessionId, ToolCallId, toolResult, turnEnded, TurnNumber, turnStarted } from "@xandreed/core/kernel"
import type { StoredDraft } from "@xandreed/core/kernel"
import { TaskId, taskReport } from "@xandreed/sdk/kernel"
import type { Trace } from "./runtime.ts"
import { chipLine, heardTask, noTasks } from "./task-chips.ts"
import type { TaskChips } from "./task-chips.ts"

const CHAT = "chat"
let seq = 0
/** A record stored in `session`, as the page hears it announced. */
const storedIn = (session: string, draft: StoredDraft, turn = 1): Trace =>
  ({ _tag: "Event", event: { _tag: "Stored", session: SessionId.make(session), seq: Seq.make(++seq), at: 0, turn: TurnNumber.make(turn), ...draft } })

const call = (id: string, name: string, params: Record<string, string>) => assistantMessage("", { toolCalls: [{ id: ToolCallId.make(id), name, params }] })
const started = (id: string, task: string, session: string): ReadonlyArray<Trace> => [
  storedIn(CHAT, call(id, "startTask", { task })),
  storedIn(CHAT, toolResult({ id: ToolCallId.make(id), name: "startTask" }, { task: "t1", session })),
]
const endedAs = (session: string, outcome: Parameters<typeof turnEnded>[1]): Trace => storedIn(session, turnEnded(TurnNumber.make(1), outcome))
const reportOf = (session: string, outcome: "Finished" | "Failed") =>
  storedIn(CHAT, taskReport({ task: TaskId.make("t1"), parent: SessionId.make(CHAT), session: SessionId.make(session), outcome, text: "It is 42." }), 2)

const fold = (traces: ReadonlyArray<Trace>): TaskChips => traces.reduce((all, trace) => heardTask(all, trace, CHAT), noTasks)
const lines = (all: TaskChips) => all.chips.map(chipLine)

describe("task chips (lesson 17)", () => {
  test("a task runs from startTask's result, ends as its session's turn ends, waits, and is reported; keyed by its session", () => {
    const steps = [...started("c1", "what is 6 * 7?", "s1"), storedIn("s1", turnStarted(TurnNumber.make(1)))]
    expect(lines(fold(steps))).toEqual(["t1 running"])
    expect(fold(steps).chips[0]).toMatchObject({ session: "s1", task: "t1", text: "what is 6 * 7?" })
    const ended = [...steps, endedAs("s1", { _tag: "Completed" })]
    expect(lines(fold(ended))).toEqual(["t1 done, report on its way"])
    const waiting = [...ended, { _tag: "Reported", task: "t1", session: "s1" } as const]
    expect(lines(fold(waiting))).toEqual(["t1 done, report waits"])
    expect(lines(fold([...waiting, reportOf("s1", "Finished")]))).toEqual(["t1 reported"])
  })

  test("a failed task says so; a cancelled one is cancelled, its turn's end heard first; one cut short by the program's stop is stopped", () => {
    expect(lines(fold([...started("c1", "x", "s1"), endedAs("s1", { _tag: "Failed", reason: "no" }), reportOf("s1", "Failed")]))).toEqual(["t1 failed, reported"])
    const cancelled = [
      ...started("c1", "x", "s1"),
      endedAs("s1", { _tag: "Interrupted" }),
      storedIn(CHAT, call("c2", "cancelTask", { task: "t1" })),
      storedIn(CHAT, toolResult({ id: ToolCallId.make("c2"), name: "cancelTask" }, "Cancelled t1. It reports nothing.")),
    ]
    expect(lines(fold(cancelled))).toEqual(["t1 cancelled"])
    expect(lines(fold([...started("c1", "x", "s1"), endedAs("s1", { _tag: "Interrupted" })]))).toEqual(["t1 stopped with the program"])
  })

  test("ids start again with every program: a new t1 is a chip of its own, a report dropped as the program stopped says so, and a cancel names the latest t1", () => {
    const first = [...started("c1", "first", "s1"), endedAs("s1", { _tag: "Completed" }), { _tag: "Reported", task: "t1", session: "s1" } as const, { _tag: "ReportsDropped", sessions: ["s1"] } as const]
    const second = [...first, ...started("c2", "second", "s2"), storedIn(CHAT, call("c3", "cancelTask", { task: "t1" })), storedIn(CHAT, toolResult({ id: ToolCallId.make("c3"), name: "cancelTask" }, "Cancelled t1. It reports nothing."))]
    expect(lines(fold(second))).toEqual(["t1 report dropped", "t1 cancelled"])
    expect(fold(second).chips.map((chip) => chip.session)).toEqual(["s1", "s2"])
  })

  test("a helper's turn that ends before startTask's result is stored is kept, and its chip starts as it ended", () => {
    const early = [storedIn(CHAT, call("c1", "startTask", { task: "x" })), endedAs("s1", { _tag: "Completed" }), { _tag: "Reported", task: "t1", session: "s1" } as const, storedIn(CHAT, toolResult({ id: ToolCallId.make("c1"), name: "startTask" }, { task: "t1", session: "s1" }))]
    expect(lines(fold(early))).toEqual(["t1 done, report waits"])
    // A failed start makes no chip.
    expect(lines(fold([storedIn(CHAT, call("c1", "startTask", { task: "x" })), storedIn(CHAT, toolResult({ id: ToolCallId.make("c1"), name: "startTask" }, "too many", true))]))).toEqual([])
  })
})
