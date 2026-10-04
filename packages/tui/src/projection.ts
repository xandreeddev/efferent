import type { EventBody, SessionEvent } from "@xandreed/core"
import type { Transcript, TranscriptBlock } from "./presentation.entity.js"
import { Option } from "effect"
import { failureMessageSummary, toolFailureSummary } from "./presentation.entity.functions.js"
export type { Transcript, TranscriptBlock } from "./presentation.entity.js"

const failureText = (value: unknown) => {
  const text = String(value ?? "")
  if (text.includes("Invalid output:")) return "The provider returned an incompatible response. Check your model or try another provider."
  return failureMessageSummary(text)
}

export const emptyTranscript: Transcript = { blocks: [], status: "Ready", runId: "", tokens: 0, outputTokens: 0, totalTokens: 0, seq: -1, startedAt: 0, journalPositions: {}, journalTurns: {} }
export const stringify = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? ""
export const toolLabel = (name: unknown, args: unknown): string => {
  const values = typeof args === "object" && args !== null ? args as Record<string, unknown> : {}
  const subject = values.path ?? values.file_path ?? values.command ?? values.pattern ?? values.query
  return `${String(name ?? "tool")}${typeof subject === "string" ? ` · ${subject.replace(/\s+/g, " ").slice(0, 100)}` : ""}`
}
export const add = (state: Transcript, block: TranscriptBlock): Transcript => ({ ...state, blocks: [...state.blocks, block] })
export const upsert = (state: Transcript, block: TranscriptBlock): Transcript => state.blocks.some((candidate) => candidate.id === block.id)
  ? { ...state, blocks: state.blocks.map((candidate) => candidate.id === block.id ? block : candidate) } : add(state, block)
export const toolCategory = (name: string): NonNullable<TranscriptBlock["category"]> =>
  /read|search|grep|glob|list|^ls$/.test(name) ? "read" : /edit|write|patch/.test(name) ? "edit" : /check|test|verify/.test(name) ? "check" : /handoff|delegate/.test(name) ? "handoff" : "other"
const nativeTurn = (event: EventBody) => event.runId && typeof event.data.turnIndex === "number" && Number.isInteger(event.data.turnIndex) && event.data.turnIndex >= 0
  ? { runId: event.runId, turnIndex: event.data.turnIndex } : {}
// Transient text may precede durable blocks from earlier turns across batches.
// Keep each run's assistant before its tools, and its turns in logical order.
export const addTurnBlock = (state: Transcript, event: EventBody, block: TranscriptBlock): Transcript => {
  const runId = event.runId
  const turn = event.data.turnIndex
  if (!runId || typeof turn !== "number" || !Number.isInteger(turn) || turn < 0) return add(state, block)
  const index = state.blocks.findIndex((candidate) => candidate.runId === runId && candidate.sourceSession === block.sourceSession && typeof candidate.turnIndex === "number" && (
    candidate.turnIndex > turn || (candidate.turnIndex === turn && block.kind === "assistant" && candidate.kind === "tool")
  ))
  return index < 0 ? add(state, block) : { ...state, blocks: [...state.blocks.slice(0, index), block, ...state.blocks.slice(index)] }
}

export type EventRenderer = (event: SessionEvent) => ReadonlyArray<TranscriptBlock>
export type EventRenderers = Readonly<Record<string, EventRenderer>>

export const projectEvent = (state: Transcript, event: SessionEvent, renderers: EventRenderers = {}, sourceSession?: string): Transcript => {
  if (sourceSession === undefined && event.seq <= state.seq) return state
  const next = { ...state, seq: Math.max(state.seq, event.seq) }
  const source = sourceSession === undefined ? {} : { sourceSession }
  const prefix = sourceSession === undefined ? "" : `${sourceSession}:`
  const custom = renderers[event.name]
  if (custom !== undefined) return { ...next, blocks: [...next.blocks, ...custom(event).map((block) => ({ ...block, id: `${prefix}${block.id}`, ...source }))] }
  const data = event.data
  if (event.name === "input.queued") return next.blocks.some((block) => block.id === String(data.id)) ? next : add(next, { id: String(data.id), kind: "user", text: String(data.text), detail: "", status: "pending", ...source })
  if (event.name === "input.claimed") return { ...next, blocks: next.blocks.map((block) => block.id === data.id ? { ...block, status: "complete" } : block) }
  if (event.name === "run.started") return { ...next, status: "Working", runId: event.runId ?? "", startedAt: event.at }
  if (event.name === "loop.event") {
    if (data.type === "assistant_message") {
      const id = `${prefix}${event.runId}:${data.turnIndex}:assistant`
      const text = String(data.text ?? "")
      const settled: TranscriptBlock = { id, kind: "assistant", text, detail: String(data.reasoning ?? ""), status: "complete", ...(typeof data.model === "string" ? { model: data.model } : {}), ...source, ...nativeTurn(event) }
      const updated = text.length === 0 ? { ...next, blocks: next.blocks.filter((block) => block.id !== id) }
        : next.blocks.some((block) => block.id === id) ? { ...next, blocks: next.blocks.map((block) => block.id === id ? settled : block) } : addTurnBlock(next, event, settled)
      return { ...updated, tokens: typeof data.usage === "object" && data.usage !== null && "inputTokens" in data.usage ? Number(data.usage.inputTokens) : next.tokens }
    }
    if (data.type === "tool_start" || data.type === "tool_end") {
      const id = `${prefix}${event.runId}:tool:${String(data.toolCallId ?? data.toolName)}:${data.turnIndex}`
      const existing = next.blocks.find((block) => block.id === id)
      const failure = data.type === "tool_start" ? Option.none<string>() : toolFailureSummary(data.result, data.ok === false)
      const block: TranscriptBlock = { id, kind: "tool", text: existing?.text ?? toolLabel(data.toolName, data.args), detail: data.type === "tool_start" ? stringify(data.args) : `${existing?.detail ? `Arguments\n${existing.detail}\n\n` : ""}Result\n${stringify(data.result)}`, status: data.type === "tool_start" ? "running" : data.ok === false || Option.isSome(failure) ? "failed" : "complete", ...Option.match(failure, { onNone: () => ({}), onSome: (summary) => ({ summary }) }), category: toolCategory(String(data.toolName)), ...source, ...nativeTurn(event) }
      return existing === undefined ? addTurnBlock(next, event, block) : { ...next, blocks: next.blocks.map((item) => item.id === id ? block : item) }
    }
  }
  if (["run.completed", "run.failed", "run.cancelled"].includes(event.name)) {
    const status = event.name === "run.failed" ? "Failed" : event.name === "run.cancelled" ? "Cancelled" : data.outcome === "partial" ? "Stopped at limit" : "Ready"
    const settled = { ...next, status, runId: "", startedAt: 0, blocks: next.blocks.map((block) => block.status === "running" && (sourceSession === undefined || block.sourceSession === sourceSession) ? { ...block, status: "cancelled" as const } : block) }
    if (event.name === "run.completed") {
      const text = String(data.text ?? "")
      return text.length > 0 && !settled.blocks.some((block) => block.kind === "assistant" && block.runId === event.runId && block.text === text && (sourceSession === undefined || block.sourceSession === sourceSession))
        ? add(settled, { id: `${prefix}${event.id}`, kind: "assistant", text, detail: "", status: "complete", ...source }) : settled
    }
    return add(settled, { id: `${prefix}${event.id}`, kind: "notice", text: status, summary: failureText(data.message ?? data.reason), detail: stringify(data.message ?? data.reason ?? ""), status: event.name === "run.failed" ? "failed" : "cancelled", ...source })
  }
  if (event.name === "config.applied") return next
  if (["context.failed", "context.compacted"].includes(event.name)) return add(next, { id: `${prefix}${event.id}`, kind: "notice", text: event.name.replaceAll(".", " "), detail: stringify(data), status: "complete", ...source })
  return next
}

export const projectDelta = (state: Transcript, event: EventBody): Transcript => {
  if (event.name !== "assistant.delta" || event.data.channel !== "text" || event.runId !== state.runId) return state
  const step = event.data.turnIndex ?? event.data.step
  const source = typeof event.data.sourceSession === "string" ? event.data.sourceSession : ""
  const modern = typeof event.data.step === "number" || source.length > 0
  const nativeSource = source || Object.values(state.journalTurns).find((turn) => turn.runId === event.runId)?.sourceSession || ""
  const id = `${modern ? `${nativeSource}:` : ""}${event.runId}:${step}:assistant`
  const existing = state.blocks.find((block) => block.id === id)
  if (existing?.status === "complete") return state
  const normalized = { ...event, data: { ...event.data, turnIndex: step } }
  const block: TranscriptBlock = { id, kind: "assistant", text: `${existing?.text ?? ""}${String(event.data.delta ?? "")}`, detail: "", status: "running", ...(modern ? { sourceSession: nativeSource } : {}), ...nativeTurn(normalized) }
  return existing === undefined ? addTurnBlock(state, normalized, block) : { ...state, blocks: state.blocks.map((item) => item.id === id ? block : item) }
}
