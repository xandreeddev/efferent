// The chat's task chips (lesson 17, ADR 0018): one chip for each background
// task the conversation shown started, and how it stands, as a pure fold of
// what the page hears. A task is keyed by its session, which never repeats:
// its id (`t1`) starts again with every program the page builds. It starts
// from `startTask`'s stored result in the chat's journal; how its work ended
// is read from its own session's journal (its turn's end); that its report
// waits, or was dropped, from the page's own traces; and that it was answered
// from the report stored in the chat's journal, a message whose `from` is the
// task's session. A cancel is `cancelTask`'s stored result.
import { Option, Predicate } from "effect"
import { assistantMessageEvent, dataOf, toolResultEvent, turnEndedEvent, userMessageEvent } from "@xandreed/core/kernel"
import { CANCEL_TASK, START_TASK } from "@xandreed/sdk/kernel"
import type { Trace } from "./runtime.ts"

/**
 * How a task stands: its work runs; it ended (finished, or failed) and its report is on its way; its report waits
 * in the chat's queue; the conversation took its report; it was cancelled; its work was cut short as the program
 * stopped (Stop, Rebuild, Clear context); or its report waited as the program stopped, and was dropped.
 */
export type TaskState = "running" | "ended" | "waiting" | "reported" | "cancelled" | "stopped" | "dropped"

export interface TaskChip {
  /** The task's own session: what keys it. */
  readonly session: string
  /** Its id, as `startTask` answered it (`t1`). */
  readonly task: string
  /** What the helper was asked, as the call that started it said it. */
  readonly text: string
  readonly state: TaskState
  /** Its work failed: its report says why. */
  readonly failed: boolean
}

export interface TaskChips {
  readonly chips: ReadonlyArray<TaskChip>
  /** The parameters of each tool call the chat's model made, by the call's id: a task's text, a cancel's id. */
  readonly calls: ReadonlyMap<string, unknown>
  /**
   * What was heard of a session before its task's start was: a fast helper's turn can end before the chat's
   * journal stores `startTask`'s result. Each change waits here, by session, and is made when the chip is.
   */
  readonly early: ReadonlyMap<string, ReadonlyArray<(chip: TaskChip) => TaskChip>>
}

export const noTasks: TaskChips = { chips: [], calls: new Map(), early: new Map() }

const textParam = (params: unknown, key: string): string => (Predicate.hasProperty(params, key) ? String(params[key]) : "")

/** The chip of a session, changed; a session with no chip yet keeps the change for when it has one. */
const change = (all: TaskChips, session: string, to: (chip: TaskChip) => TaskChip): TaskChips =>
  all.chips.some((chip) => chip.session === session)
    ? { ...all, chips: all.chips.map((chip) => (chip.session === session ? to(chip) : chip)) }
    : { ...all, early: new Map(all.early).set(session, [...(all.early.get(session) ?? []), to]) }

/** A state that nothing after it changes: the task is over, and the conversation knows how. */
const settled = (state: TaskState): boolean => state === "reported" || state === "cancelled" || state === "dropped"

/** The chips after one more trace of the page's, for the conversation `chat` shows. */
export const heardTask = (all: TaskChips, trace: Trace, chat: string): TaskChips => {
  if (trace._tag === "Reported") return change(all, trace.session, (chip) => (settled(chip.state) ? chip : { ...chip, state: "waiting" }))
  if (trace._tag === "ReportsDropped") return trace.sessions.reduce((now, session) => change(now, session, (chip) => (settled(chip.state) ? chip : { ...chip, state: "dropped" })), all)
  if (trace._tag !== "Event" || trace.event._tag !== "Stored") return all
  const event = trace.event
  if (event.session !== chat) {
    // A task's own session: its turn's end says how its work ended.
    return Option.match(dataOf(turnEndedEvent, event), {
      onNone: () => all,
      onSome: ({ outcome }) => change(all, event.session, (chip) => {
        if (chip.state !== "running") return chip
        if (outcome._tag === "Completed") return { ...chip, state: "ended" }
        if (outcome._tag === "Failed") return { ...chip, state: "ended", failed: true }
        return { ...chip, state: "stopped" }
      }),
    })
  }
  const message = event.message
  if (event.name === assistantMessageEvent.name && message?._tag === "Assistant") {
    return { ...all, calls: new Map([...all.calls, ...message.toolCalls.map((call) => [call.id, call.input] as const)]) }
  }
  if (event.name === toolResultEvent.name && message?._tag === "ToolResult" && !message.isFailure) {
    const result = message.result
    if (message.name === START_TASK && typeof result === "object" && result !== null && "task" in result && "session" in result) {
      const session = String(result.session)
      const started: TaskChip = { session, task: String(result.task), text: textParam(all.calls.get(message.id), "task"), state: "running", failed: false }
      const chip = (all.early.get(session) ?? []).reduce((now, to) => to(now), started)
      return { ...all, chips: [...all.chips.filter((one) => one.session !== session), chip], early: new Map([...all.early].filter(([id]) => id !== session)) }
    }
    if (message.name === CANCEL_TASK) {
      // The task cancelled is the latest one started under that id: ids start again with each program.
      const id = textParam(all.calls.get(message.id), "task").trim()
      const latest = all.chips.findLast((chip) => chip.task === id)
      return latest === undefined ? all : change(all, latest.session, (chip) => (settled(chip.state) ? chip : { ...chip, state: "cancelled" }))
    }
    return all
  }
  // The conversation took a task's report: a message whose `from` is the task's session.
  if (event.name === userMessageEvent.name && message?._tag === "User" && typeof event.data === "object" && event.data !== null && "from" in event.data && typeof event.data.from === "string") {
    return change(all, event.data.from, (chip) => ({ ...chip, state: "reported" }))
  }
  return all
}

/** What a chip says: the task's id and how it stands, in a few words. */
export const chipLine = (chip: TaskChip): string => {
  const how: Record<TaskState, string> = {
    running: "running",
    ended: chip.failed ? "failed, report on its way" : "done, report on its way",
    waiting: chip.failed ? "failed, report waits" : "done, report waits",
    reported: chip.failed ? "failed, reported" : "reported",
    cancelled: "cancelled",
    stopped: "stopped with the program",
    dropped: "report dropped",
  }
  return `${chip.task} ${how[chip.state]}`
}
