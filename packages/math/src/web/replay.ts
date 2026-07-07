/**
 * Rebuild the MathModel from the PERSISTED message log (the canvasReplay
 * pattern): `render_math` is a tool, so every call's full args live in the
 * ConversationStore as assistant tool-call parts and replay through the SAME
 * `parseMathItems` + `putItems` fold the live path uses — replay ≡ live-fold
 * by construction. The driver's own machine-formatted user messages
 * (`[action]`/`[progress]`, parsed by the same module that formats them)
 * restore grade/theme and every verdict the agent was TOLD about, so answered
 * exercises never re-serve after `--resume`.
 *
 * Accepted resume losses (cosmetic): attempt counts in progress on an
 * unfinished exercise, and graded-but-not-yet-reported results (pending
 * progress that never rode a message).
 */
import type { AgentMessage } from "@xandreed/sdk-core"
import { parseMathItems } from "../domain/MathContent.js"
import {
  applyTopic,
  emptyMathModel,
  putItems,
  type ExerciseState,
  type MathModel,
  type Verdict,
} from "./model.js"
import { Option } from "effect"
import { parseAgentBoundMessage, type ProgressEntry } from "../protocol.js"

const applyProgressEntry = (m: MathModel, entry: ProgressEntry): MathModel => {
  const idx = m.exercises.findIndex((e) => e.item.id === entry.ex)
  if (idx === -1) return m
  const prev = m.exercises[idx] as ExerciseState
  const verdict: Verdict =
    entry.result === "correct"
      ? "correct"
      : entry.result === "reported"
        ? "reported"
        : "revealed" // revealed, or wrong-gave-up (never re-serves)
  const exercises = m.exercises.map((e, i) =>
    i === idx
      ? {
          ...e,
          verdict,
          attempts: entry.attempts,
          ...(entry.student !== undefined ? { lastAnswer: entry.student } : {}),
        }
      : e,
  )
  return {
    ...m,
    exercises,
    solved: m.solved + (entry.result === "correct" && prev.verdict !== "correct" ? 1 : 0),
  }
}

const foldUserMessage = (m: MathModel, content: string): MathModel =>
  Option.match(parseAgentBoundMessage(content), {
    onNone: () => m,
    onSome: (parsed) => {
      const withProgress = parsed.progress.reduce(applyProgressEntry, m)
      const a = parsed.action
      return a !== undefined && (a.kind === "start" || a.kind === "topic")
        ? applyTopic(withProgress, a.grade, a.theme)
        : withProgress
    },
  })

const foldAssistantMessage = (m: MathModel, content: ReadonlyArray<unknown>): MathModel =>
  content.reduce<MathModel>((acc, part) => {
    if (typeof part !== "object" || part === null) return acc
    const p = part as { type?: unknown; toolName?: unknown; input?: unknown }
    if (p.type !== "tool-call" || p.toolName !== "render_math") return acc
    const input = p.input
    const items =
      typeof input === "object" && input !== null
        ? (input as { items?: unknown }).items
        : undefined
    const { accepted } = parseMathItems(items)
    return accepted.length > 0 ? putItems(acc, accepted) : acc
  }, m)

export const replayMath = (
  history: ReadonlyArray<AgentMessage>,
  seed?: { grade?: number; theme?: string },
): MathModel => {
  const m = history.reduce<MathModel>((acc, msg) => {
    if (msg.role === "user") return foldUserMessage(acc, msg.content)
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      return foldAssistantMessage(acc, msg.content)
    }
    return acc
  }, emptyMathModel(seed))
  // Serve the first still-fresh exercise; a finished session shows Next-less
  // done state until the student asks for more.
  const fresh = m.exercises.find((e) => e.verdict === "fresh")
  return {
    ...m,
    ...(fresh !== undefined ? { currentId: fresh.item.id } : {}),
    generating: false,
    acceptedThisTurn: 0,
  }
}
