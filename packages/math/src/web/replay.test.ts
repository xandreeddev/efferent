import { describe, expect, test } from "bun:test"
import { ToolCallId } from "@xandreed/engine"
import type { AgentMessage } from "@xandreed/engine"
import type { MathItem } from "../domain/MathContent.js"
import { advance, applyGrade, emptyMathModel, putItems, type MathModel } from "./model.js"
import { composeAgentMessage } from "../protocol.js"
import { reduceMathEvent } from "./reduce.js"
import { replayMath } from "./replay.js"

const ex = (id: string): MathItem => ({
  kind: "exercise",
  id,
  prompt: `What is 1/4 + 2/4? (${id})`,
  answer: { kind: "fraction", value: "3/4" },
  hint: "Add the numerators.",
  solution: [{ text: "1/4 + 2/4 = 3/4" }],
})

const userMsg = (content: string): AgentMessage => ({ role: "user", content })
const renderCall = (items: ReadonlyArray<unknown>): AgentMessage => ({
  role: "assistant",
  content: [
    {
      type: "tool-call",
      toolCallId: ToolCallId.make("t1"),
      toolName: "render_math",
      input: { items },
    },
  ],
})

describe("math replay", () => {
  test("replay ≡ live-fold: the same batches through events and through the log agree", () => {
    const batch1 = [ex("ex-1"), ex("ex-2"), { kind: "note", text: "welcome" } as MathItem]
    const batch2 = [ex("ex-3")]

    // Live: fold math_render events through the reducer.
    const live = [batch1, batch2].reduce<MathModel>(
      (m, items) => reduceMathEvent(m, { type: "math_render", items }).model,
      emptyMathModel({ grade: 4, theme: "fractions" }),
    )

    // Replay: the same items as persisted tool-call parts.
    const replayed = replayMath(
      [
        userMsg(composeAgentMessage([], { kind: "start", grade: 4, theme: "fractions" })),
        renderCall(batch1),
        renderCall(batch2),
      ],
      { grade: 4, theme: "fractions" },
    )

    expect(replayed.exercises.map((e) => e.item.id)).toEqual(
      live.exercises.map((e) => e.item.id),
    )
    expect(replayed.note).toBe(live.note)
    expect(replayed.currentId).toBe(live.currentId)
    expect(replayed.started).toBe(true)
    expect(replayed.grade).toBe(4)
    expect(replayed.theme).toBe("fractions")
  })

  test("reported [progress] restores verdicts — answered exercises never re-serve", () => {
    // Live session: solve ex-1, abandon ex-2, then the driver drained the
    // progress into the next agent-bound message.
    const l0 = putItems(emptyMathModel(), [ex("ex-1"), ex("ex-2"), ex("ex-3")])
    const l1 = advance(applyGrade(l0, "ex-1", "3/4").model) // now on ex-2
    const live = advance(applyGrade(l1, "ex-2", "nope").model) // abandons ex-2 → ex-3
    const progress = live.pendingProgress

    const replayed = replayMath([
      userMsg(composeAgentMessage([], { kind: "start", grade: 4, theme: "fractions" })),
      renderCall([ex("ex-1"), ex("ex-2"), ex("ex-3")]),
      userMsg(composeAgentMessage(progress, { kind: "more" })),
      renderCall([ex("ex-4")]),
    ])

    expect(replayed.exercises.find((e) => e.item.id === "ex-1")?.verdict).toBe("correct")
    expect(replayed.solved).toBe(1)
    expect(replayed.exercises.find((e) => e.item.id === "ex-2")?.verdict).not.toBe("fresh")
    // The current pointer lands on the first still-fresh exercise.
    expect(replayed.currentId).toBe("ex-3")
    expect(replayed.generating).toBe(false)
  })

  test("a topic switch mid-log drops the old topic's unserved exercises", () => {
    const replayed = replayMath([
      userMsg(composeAgentMessage([], { kind: "start", grade: 4, theme: "fractions" })),
      renderCall([ex("ex-1"), ex("ex-2")]),
      userMsg(composeAgentMessage([], { kind: "topic", grade: 6, theme: "decimals" })),
      renderCall([ex("ex-5")]),
    ])
    expect(replayed.grade).toBe(6)
    expect(replayed.theme).toBe("decimals")
    expect(replayed.exercises.map((e) => e.item.id)).toEqual(["ex-5"])
    expect(replayed.currentId).toBe("ex-5")
  })

  test("foreign user messages and malformed tool args are skipped structurally", () => {
    const replayed = replayMath([
      userMsg("hello there"),
      { role: "assistant", content: [{ type: "text", text: "hi" }] } as AgentMessage,
      renderCall([{ kind: "exercise", id: "bad" }]), // rejected per item
      renderCall([ex("ex-1")]),
    ])
    expect(replayed.exercises.map((e) => e.item.id)).toEqual(["ex-1"])
  })
})
