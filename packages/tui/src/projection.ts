import type { EventBody, SessionEvent } from "@xandreed/core"

const failureText = (value: unknown) => {
  const text = String(value ?? "")
  if (text.includes("Invalid output:")) return "The provider returned an incompatible response. Check your model or try another provider."
  return text.split("\n")[0]!.replace(/^(?:(?:HarnessError|UnknownError|Error):\s*)+/, "").slice(0, 600)
}

export interface TranscriptBlock {
  readonly id: string
  readonly kind: "user" | "assistant" | "tool" | "notice"
  readonly text: string
  readonly detail: string
  readonly status: "pending" | "running" | "complete" | "failed" | "cancelled"
  /** Native loop blocks carry their exact run and step; custom renderers may omit them. */
  readonly runId?: string
  readonly turnIndex?: number
}
export interface Transcript {
  readonly blocks: ReadonlyArray<TranscriptBlock>
  readonly status: string
  readonly runId: string
  readonly tokens: number
  readonly seq: number
}
export const emptyTranscript: Transcript = { blocks: [], status: "Ready", runId: "", tokens: 0, seq: -1 }
const stringify = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? ""
const toolLabel = (name: unknown, args: unknown): string => {
  const values = typeof args === "object" && args !== null ? args as Record<string, unknown> : {}
  const subject = values.path ?? values.file_path ?? values.command ?? values.pattern ?? values.query
  return `${String(name ?? "tool")}${typeof subject === "string" ? ` · ${subject.replace(/\s+/g, " ").slice(0, 100)}` : ""}`
}
const add = (state: Transcript, block: TranscriptBlock): Transcript => ({ ...state, blocks: [...state.blocks, block] })
const nativeTurn = (event: EventBody) => event.runId && typeof event.data.turnIndex === "number" && Number.isInteger(event.data.turnIndex) && event.data.turnIndex >= 0
  ? { runId: event.runId, turnIndex: event.data.turnIndex } : {}
// Transient text may precede durable blocks from earlier turns across batches.
// Keep each run's assistant before its tools, and its turns in logical order.
const addTurnBlock = (state: Transcript, event: EventBody, block: TranscriptBlock): Transcript => {
  const runId = event.runId
  const turn = event.data.turnIndex
  if (!runId || typeof turn !== "number" || !Number.isInteger(turn) || turn < 0) return add(state, block)
  const index = state.blocks.findIndex((candidate) => candidate.runId === runId && typeof candidate.turnIndex === "number" && (
    candidate.turnIndex > turn || (candidate.turnIndex === turn && block.kind === "assistant" && candidate.kind === "tool")
  ))
  return index < 0 ? add(state, block) : { ...state, blocks: [...state.blocks.slice(0, index), block, ...state.blocks.slice(index)] }
}

export type EventRenderer = (event: SessionEvent) => ReadonlyArray<TranscriptBlock>
export type EventRenderers = Readonly<Record<string, EventRenderer>>

export const projectEvent = (state: Transcript, event: SessionEvent, renderers: EventRenderers = {}): Transcript => {
  if (event.seq <= state.seq) return state
  const next = { ...state, seq: event.seq }
  const custom = renderers[event.name]
  if (custom !== undefined) return { ...next, blocks: [...next.blocks, ...custom(event)] }
  const data = event.data
  if (event.name === "input.queued") return add(next, { id: String(data.id), kind: "user", text: String(data.text), detail: "", status: "pending" })
  if (event.name === "input.claimed") return { ...next, blocks: next.blocks.map((block) => block.id === data.id ? { ...block, status: "complete" } : block) }
  if (event.name === "run.started") return { ...next, status: "Working", runId: event.runId ?? "" }
  if (event.name === "loop.event") {
    if (data.type === "assistant_message") {
      const id = `${event.runId}:${data.turnIndex}:assistant`
      const text = String(data.text ?? "")
      const settled: TranscriptBlock = { id, kind: "assistant", text, detail: String(data.reasoning ?? ""), status: "complete", ...nativeTurn(event) }
      const updated = text.length === 0 ? { ...next, blocks: next.blocks.filter((block) => block.id !== id) }
        : next.blocks.some((block) => block.id === id) ? { ...next, blocks: next.blocks.map((block) => block.id === id ? settled : block) } : addTurnBlock(next, event, settled)
      return { ...updated, tokens: typeof data.usage === "object" && data.usage !== null && "inputTokens" in data.usage ? Number(data.usage.inputTokens) : next.tokens }
    }
    if (data.type === "tool_start" || data.type === "tool_end") {
      const id = `${event.runId}:tool:${String(data.toolCallId ?? data.toolName)}:${data.turnIndex}`
      const existing = next.blocks.find((block) => block.id === id)
      const block: TranscriptBlock = { id, kind: "tool", text: existing?.text ?? toolLabel(data.toolName, data.args), detail: data.type === "tool_start" ? stringify(data.args) : `${existing?.detail ? `Arguments\n${existing.detail}\n\n` : ""}Result\n${stringify(data.result)}`, status: data.type === "tool_start" ? "running" : data.ok === false ? "failed" : "complete", ...nativeTurn(event) }
      return existing === undefined ? addTurnBlock(next, event, block) : { ...next, blocks: next.blocks.map((item) => item.id === id ? block : item) }
    }
  }
  if (["run.completed", "run.failed", "run.cancelled"].includes(event.name)) {
    const status = event.name === "run.failed" ? "Failed" : event.name === "run.cancelled" ? "Cancelled" : data.outcome === "partial" ? "Stopped at limit" : "Ready"
    const settled = { ...next, status, runId: "", blocks: next.blocks.map((block) => block.status === "running" ? { ...block, status: "cancelled" as const } : block) }
    if (event.name === "run.completed") {
      const text = String(data.text ?? "")
      return text.length > 0 && !settled.blocks.some((block) => block.kind === "assistant" && block.id.startsWith(`${event.runId}:`) && block.text === text)
        ? add(settled, { id: event.id, kind: "assistant", text, detail: "", status: "complete" }) : settled
    }
    return add(settled, { id: event.id, kind: "notice", text: status, detail: failureText(data.message ?? data.reason), status: event.name === "run.failed" ? "failed" : "cancelled" })
  }
  if (event.name === "config.applied") return next
  if (["context.failed", "context.compacted"].includes(event.name)) return add(next, { id: event.id, kind: "notice", text: event.name.replaceAll(".", " "), detail: stringify(data), status: "complete" })
  return next
}

export const projectDelta = (state: Transcript, event: EventBody): Transcript => {
  if (event.name !== "assistant.delta" || event.data.channel !== "text" || event.runId !== state.runId) return state
  const id = `${event.runId}:${event.data.turnIndex}:assistant`
  const existing = state.blocks.find((block) => block.id === id)
  if (existing?.status === "complete") return state
  const block: TranscriptBlock = { id, kind: "assistant", text: `${existing?.text ?? ""}${String(event.data.delta ?? "")}`, detail: "", status: "running", ...nativeTurn(event) }
  return existing === undefined ? addTurnBlock(state, event, block) : { ...state, blocks: state.blocks.map((item) => item.id === id ? block : item) }
}
