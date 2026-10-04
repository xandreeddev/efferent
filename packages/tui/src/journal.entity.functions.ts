import { AgentMessage, LogBody, SessionEvent, TokenUsage, TurnEndedData, TurnStartedData } from "@xandreed/core"
import type { SessionLogEvent } from "@xandreed/core"
import { Option, Schema } from "effect"
import type { JournalTurn, Transcript, TranscriptBlock } from "./presentation.entity.js"
import { addTurnBlock, projectEvent, stringify, toolCategory, toolLabel, upsert } from "./projection.js"
import type { EventRenderers } from "./projection.js"
import type { JournalRenderers } from "./journal.entity.js"
import { toolFailureSummary } from "./presentation.entity.functions.js"

const object = (value: unknown): Readonly<Record<string, unknown>> => typeof value === "object" && value !== null ? value as Readonly<Record<string, unknown>> : {}
const turnKey = (event: SessionLogEvent) => `${event.session}:${Option.getOrElse(event.turn, () => 0)}`
const stepOf = (event: SessionLogEvent): number => typeof event.data.step === "number" ? event.data.step : 0
const assistantId = (source: string, run: string, step: number) => `${source}:${run}:${step}:assistant`
const toolId = (source: string, run: string, step: number, call: string) => `${source}:${run}:tool:${call}:${step}`
const ordered = (state: Transcript, block: TranscriptBlock): Transcript => state.blocks.some((candidate) => candidate.id === block.id) ? upsert(state, block)
  : addTurnBlock(state, { name: "native", runId: block.runId, data: { turnIndex: block.turnIndex } }, block)
const metadata = (turn: JournalTurn, step: number) => ({ runId: turn.runId, sourceSession: turn.sourceSession, turnIndex: step })

/** Join the journal's existing payloads; the terminal never writes a parallel log. */
export const projectJournal = (state: Transcript, event: SessionLogEvent, renderers: JournalRenderers = {}, legacy: EventRenderers = {}, selectedSession: string = event.session): Transcript => {
  if (event.seq <= (state.journalPositions[event.session] ?? 0)) return state
  const next = { ...state, journalPositions: { ...state.journalPositions, [event.session]: event.seq } }
  if (event.kind === "harness.event") return Option.match(Schema.decodeUnknownOption(SessionEvent)(event.data.event), {
    onNone: () => next,
    onSome: (entry) => {
      const projected = projectEvent(next, entry, legacy, event.session)
      return event.session === selectedSession ? projected : { ...projected, seq: next.seq, status: next.status, runId: next.runId, startedAt: next.startedAt }
    },
  })
  if (event.kind === "turn.started") return Option.match(Schema.decodeUnknownOption(TurnStartedData)(event.data), {
    onNone: () => next,
    onSome: (started) => ({ ...next,
      blocks: next.blocks.some((block) => block.id === started.key) || started.origin !== "user" ? next.blocks : [...next.blocks, { id: started.key, kind: "user" as const, text: started.userMessage.text, detail: "", status: "complete" as const, runId: started.runId, sourceSession: event.session }],
      journalTurns: { ...next.journalTurns, [turnKey(event)]: { runId: started.runId, sourceSession: event.session, turn: Option.getOrElse(event.turn, () => 0) } } }),
  })
  const turn = Option.fromNullishOr(next.journalTurns[turnKey(event)])
  const custom = renderers[event.kind]
  if (custom !== undefined) return custom(event, turn).reduce(upsert, next)
  return Option.match(turn, { onNone: () => next, onSome: (current) => {
    const step = stepOf(event)
    const meta = metadata(current, step)
    if (event.kind === "memory.message") return Option.match(Schema.decodeUnknownOption(AgentMessage)(object(event.data.body).message), {
      onNone: () => next,
      onSome: (message) => {
        if (message.role !== "assistant") return next
        const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
        const reasoning = message.content.flatMap((part) => part.type === "reasoning" ? [part.text] : []).join("\n")
        const id = assistantId(event.session, current.runId, step)
        // A rejected call can have no lifecycle start. Its model call is still
        // authoritative evidence of the arguments and belongs to the same row.
        const calls = message.content.flatMap((part) => part.type === "tool-call" ? [part] : [])
        const seeded = calls.reduce((state, call) => {
          const id = toolId(event.session, current.runId, step, call.toolCallId)
          const existing = state.blocks.find((block) => block.id === id)
          return ordered(state, { id, kind: "tool", text: toolLabel(call.toolName, call.input), detail: stringify(call.input), status: "pending", category: toolCategory(call.toolName), ...meta, ...existing })
        }, next)
        const existing = seeded.blocks.find((block) => block.id === id)
        return text.length === 0 ? { ...seeded, blocks: seeded.blocks.filter((block) => block.id !== id) }
          : ordered(seeded, { ...existing, id, kind: "assistant", text, detail: reasoning, status: "complete", ...meta })
      },
    })
    if (event.kind === "step.usage") return Option.match(Schema.decodeUnknownOption(TokenUsage)(event.data.usage), {
      onNone: () => next,
      onSome: (usage) => {
        const model = Option.getOrElse(Schema.decodeUnknownOption(Schema.OptionFromNullOr(Schema.String))(event.data.model), () => Option.none<string>())
        return { ...next, tokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: next.totalTokens + usage.totalTokens,
          blocks: next.blocks.map((block) => block.id === assistantId(event.session, current.runId, step) ? { ...block, ...Option.match(model, { onNone: () => ({}), onSome: (model) => ({ model }) }) } : block) }
      },
    })
    if (event.kind === "tool.started" || event.kind === "tool.completed") {
      const id = toolId(event.session, current.runId, step, String(event.data.toolCallId ?? event.data.invocationId))
      const existing = next.blocks.find((block) => block.id === id)
      const labels = object(event.data.labels)
      const role = typeof labels.role === "string" ? { role: labels.role } : {}
      return ordered(next, { ...existing, id, kind: "tool", text: existing?.text ?? toolLabel(event.data.tool, event.data.input),
        detail: existing?.detail ?? stringify(event.data.input), status: event.kind === "tool.started" ? "running" : event.data.ok === false ? "failed" : "complete",
        category: toolCategory(String(event.data.tool)), ...(typeof event.data.durationMs === "number" ? { durationMs: event.data.durationMs } : {}), ...role, ...meta })
    }
    if (event.kind === "memory.tool-result") return Option.match(Schema.decodeUnknownOption(LogBody)({ ...object(event.data.body), _tag: "ToolResult" }), {
      onNone: () => next,
      onSome: (body) => {
        if (body._tag !== "ToolResult") return next
        const id = toolId(event.session, current.runId, step, body.toolCallId)
        const existing = next.blocks.find((block) => block.id === id)
        const failure = toolFailureSummary(body.encoded, body.isError)
        return ordered(next, { ...existing, id, kind: "tool", text: existing?.text ?? body.toolName,
          detail: `${existing?.detail ? `Arguments\n${existing.detail}\n\n` : ""}Result\n${body.view || stringify(body.encoded)}`,
          status: body.isError || Option.isSome(failure) ? "failed" : "complete", ...Option.match(failure, { onNone: () => ({}), onSome: (summary) => ({ summary }) }), category: toolCategory(body.toolName), ...meta })
      },
    })
    if (event.kind === "turn.ended") return Option.match(Schema.decodeUnknownOption(TurnEndedData)(event.data), {
      onNone: () => next,
      onSome: (ending) => ({ ...next, blocks: next.blocks.map((block) => block.runId === current.runId && block.sourceSession === event.session && block.status === "running"
        ? { ...block, status: ending.reason === "completed" ? "complete" as const : "cancelled" as const } : block) }),
    })
    return next
  } })
}
