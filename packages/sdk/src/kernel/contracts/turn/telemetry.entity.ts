import { Metric } from "effect"

/*
 * What the kernel says about its work to a tracer and a metric registry (ADR 0030). The spans and the metrics are
 * Effect's own: with no exporter installed they are kept in the process and dropped, and nothing a turn stores, sends
 * or returns changes. A span's attributes name the session and the turn it is about; a metric's never do, so a
 * metric's series stay few however many conversations run.
 */

/** The session a span is about: the key the old engine's spans carry it under. */
export const SESSION_ATTRIBUTE = "efferent.session.id"
/** The session a span is about, under OpenTelemetry's name for a conversation, which tracing backends read. */
export const CONVERSATION_ATTRIBUTE = "gen_ai.conversation.id"
/** A turn's number in its session. */
export const TURN_ATTRIBUTE = "efferent.turn"
/** How a turn, a model call or a tool call ended, in a word. */
export const OUTCOME_ATTRIBUTE = "efferent.outcome"
/** The model that answered a call, `unknown` when no part of the stream named one. */
export const MODEL_ATTRIBUTE = "efferent.model"
/** A count's kind of token: `input` (not read from the cache), `cache_read` or `output`. */
export const TOKEN_KIND_ATTRIBUTE = "efferent.token.kind"
/** The tool a call ran, `unknown` when the toolkit has no tool of the name the model wrote. */
export const TOOL_ATTRIBUTE = "efferent.tool"

/** The name the model wrote for a tool the toolkit has not: its text, which the export leaves out unless content is on. */
export const ASKED_ATTRIBUTE = "efferent.tool.asked"

/** The name a metric gives a model or a tool it cannot name. */
export const UNKNOWN = "unknown"

/** How a model call `modelAnswer` read ended: its answer stored, failed, cut after content went on (`AnswerCut`), or stopped. */
export type AnswerOutcome = "answered" | "failed" | "cut" | "interrupted"

/** A kind of token a model reported: those kinds sum to the call's input and output. */
export type TokenKind = "input" | "cache_read" | "output"

/**
 * The model calls `modelAnswer` read, by the model that answered (`efferent.model`) and how the call ended
 * (`efferent.outcome`, an `AnswerOutcome`). A call a plan tried again counts once, as the answer it made.
 */
export const modelCalls = Metric.counter("efferent.model.calls", {
  description: "model calls modelAnswer read, by the model that answered and how the call ended",
  incremental: true,
})

/**
 * The tokens a model reported for the calls `modelAnswer` read, by model and kind (`efferent.token.kind`): the input
 * not read from the cache, the cache's reads, the output. A call whose provider reported no usage adds none.
 */
export const modelTokens = Metric.counter("efferent.model.tokens", {
  description: "tokens the model reported for each call modelAnswer read, by model and kind",
  incremental: true,
})

/** The calls `callTool` ran, by tool (`efferent.tool`) and whether their stored result is a failure (`efferent.outcome`). */
export const toolCalls = Metric.counter("efferent.tool.calls", {
  description: "tool calls callTool ran, by tool and whether the stored result is a failure",
  incremental: true,
})
