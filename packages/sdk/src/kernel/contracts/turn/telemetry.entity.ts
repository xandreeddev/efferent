import { Metric } from "effect"

/*
 * What the kernel says about its work to a tracer and a metric registry (ADR 0030): the attribute keys every span
 * and metric shares, and the tool calls' count. The model calls' counts are the Node entry's charge's
 * (`model-spend.entity.ts`), which sees every call a provider sends. The spans and the metrics are
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
/** The model a call was sent to and priced as (the provider's `model`). */
export const MODEL_ATTRIBUTE = "efferent.model"
/** A count's kind of token (`TokenKind`). */
export const TOKEN_KIND_ATTRIBUTE = "efferent.token.kind"
/** The tool a call ran, `unknown` when the toolkit has no tool of the name the model wrote. */
export const TOOL_ATTRIBUTE = "efferent.tool"

/** The name the model wrote for a tool the toolkit has not: its text, which the export leaves out unless content is on. */
export const ASKED_ATTRIBUTE = "efferent.tool.asked"

/** The name a metric or a span gives a tool it cannot name. */
export const UNKNOWN = "unknown"

/**
 * How a model call a provider sent ended: its answer whole (`answered`), stopped (`interrupted`), refused by the
 * provider before it generated anything (`refused`), never sent because the connection did not open (`unsent`), or
 * failed after it was sent (`failed`).
 */
export type CallOutcome = "answered" | "failed" | "refused" | "unsent" | "interrupted"

/** A kind of token a provider reported: apart, as the charge prices them, so they sum to the call's input and output. */
export type TokenKind = "input" | "cache_read" | "cache_write" | "output"

/** What a cost point was settled from: the provider's bill, its usage at the host's price, or the hold (nothing reported). */
export const COST_BASIS_ATTRIBUTE = "efferent.cost.basis"

/** The basis of a cost point (`efferent.cost.basis`): only `held` is an estimate, the call's worst case. */
export type CostBasis = "billed" | "usage" | "held"

/** The calls `callTool` ran, by tool (`efferent.tool`) and whether their stored result is a failure (`efferent.outcome`). */
export const toolCalls = Metric.counter("efferent.tool.calls", {
  description: "tool calls callTool ran, by tool and whether the stored result is a failure",
  incremental: true,
})
