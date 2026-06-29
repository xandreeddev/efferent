import { LanguageModel, Prompt, type Tool, type Toolkit } from "@effect/ai"
import { Clock, Effect, FiberRef } from "effect"
import { Compression, type CompressionBudget, type CompressionPolicy } from "../entities/Compression.js"
import type { AgentHooks } from "../entities/AgentHooks.js"
import type { AgentMessage, AgentResult } from "../entities/Conversation.js"
import { recordError, recordToolCall, recordTurn, usageAttributes } from "../telemetry/metrics.js"
import { agentSpanAttributes, toolSpanName, turnSpanName } from "../telemetry/spanNames.js"
import { RunContextRef } from "./runContext.js"
import { DEFAULT_TOOL_RESULT_MAX_CHARS, Compaction } from "./compaction.js"
import {
  attachUsageToAssistant,
  ensureToolCallIds,
  extractUsage,
  responseReasoning,
  responseToAgentMessages,
  responseToolCalls,
  responseToolResults,
  toPromptMessages,
} from "./promptMapping.js"

/**
 * Provider-agnostic agent loop on `@effect/ai`. `@effect/ai` resolves the
 * tool calls within a single `generateText` (its handlers are our Effects),
 * but it does NOT iterate across turns — so iteration is ours: we re-invoke
 * with the growing message buffer until the model stops requesting tools or
 * `maxSteps` is hit.
 *
 * Each turn the response's content parts become the `AgentMessage` tail
 * (carrying `thought_signature` through `providerOptions`); the prior hook
 * vocabulary (`onTurnStart` / tool events / `onAssistantMessage`) is emitted
 * from the resolved response so existing drivers render unchanged.
 */

export interface RunAgentLoopInput<
  Tools extends Record<string, Tool.Any>,
  R,
> {
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly toolkit: Toolkit.Toolkit<Tools>
  readonly maxSteps?: number
  readonly hooks?: AgentHooks<R>
  /**
   * Concurrency for resolving one step's tool calls (`@effect/ai` runs the
   * handlers with `Effect.forEach`). Parallelism is what makes fan-out worth
   * the latency: a model that emits three `run_agent` calls in one turn gets
   * three sub-agents running at once (folder sandboxing keeps disjoint
   * folders write-safe; same-folder spawns serialize on a per-folder lock).
   * Bounded — not unbounded — so a 20-call turn doesn't stampede the
   * provider's rate limit. Default {@link DEFAULT_TOOL_CONCURRENCY}.
   */
  readonly toolConcurrency?: number
  /**
   * Compaction: per-string budget (chars) for a tool result entering the
   * buffer — over it, the string is clipped head+tail with a reversible
   * marker (+ a FAST-tier digest of the dropped middle when `UtilityLlm` is
   * around). Append-time, so the prompt-cache prefix is never rewritten.
   * Default {@link DEFAULT_TOOL_RESULT_MAX_CHARS}; 0 disables.
   */
  readonly toolResultMaxChars?: number
  /**
   * The agent's compression policy (moment 1 tail + moment 2 context). When
   * omitted, the loop reads it from `RunContextRef` (so sub-agents inherit the
   * root agent's policy), falling back to `Compaction.default()`. An explicit
   * value here overrides both — handy for direct/test callers.
   */
  readonly compression?: CompressionPolicy
  /**
   * Persist each turn's appended messages the moment they land (incremental
   * persistence) instead of the caller bulk-appending `newTail` at the very
   * end — so a session is restorable to its last completed turn after a crash.
   * Called with the SAME messages accumulated into `newTail` (model responses
   * AND synthetic correctives), per turn, in order. When omitted, the caller
   * persists `newTail` itself (the direct/eval/test path is unchanged).
   */
  readonly onTail?: (
    messages: ReadonlyArray<AgentMessage>,
  ) => Effect.Effect<ReadonlyArray<number>, never, R>
}

/** Tool calls resolved concurrently per step (interruption-safe via Effect). */
export const DEFAULT_TOOL_CONCURRENCY = 4

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}…`)

/** Tools designed to be POLLED — called repeatedly with the same args while
 *  their target keeps running; an unchanged result is correct, not a degenerate
 *  loop. Excluded from the repeat circuit breaker so a legitimately long
 *  `wait_for_agents` / `bash_output` poll is never mistaken for a spin. */
const POLLABLE_REPEAT_TOOLS = new Set(["wait_for_agents", "bash_output"])

/**
 * A stable signature of one turn's tool activity: the (sorted) multiset of
 * `tool(args)` calls paired with their `ok:result`. Identical signatures on
 * consecutive turns mean the model is repeating the SAME call and getting the
 * SAME result — zero progress (live: a root that called `list_scheduled_jobs`
 * ~30× before doing anything). Returns "" for turns that must NOT count: no
 * tool calls (plain narration), or purely polling calls. Including the RESULT is
 * deliberate — a call that returns new info each time (different result) yields a
 * different signature and never trips the breaker.
 */
const repeatSignature = (content: ReadonlyArray<unknown>): string => {
  const calls = responseToolCalls(content)
  if (calls.length === 0) return ""
  if (calls.every((c) => POLLABLE_REPEAT_TOOLS.has(c.toolName))) return ""
  const callPart = calls
    .map((c) => `${c.toolName}(${JSON.stringify(c.args)})`)
    .sort()
    .join("|")
  const resultPart = responseToolResults(content)
    .map((r) => `${r.toolName}:${r.ok ? "ok" : "err"}:${clip(JSON.stringify(r.result ?? null), 200)}`)
    .sort()
    .join("|")
  return `${callPart}=>${resultPart}`
}

/** Consecutive identical-signature turns before the breaker NUDGES (injects a
 *  corrective) and, failing that, BREAKS the loop. Generous enough that a normal
 *  2–3× retry never trips, tight enough that a true spin stops by the 6th turn. */
const REPEAT_NUDGE_AT = 3
const REPEAT_BREAK_AT = 5

/** Injected once when the model has repeated the same no-progress call
 *  {@link REPEAT_NUDGE_AT} times — a chance to course-correct before the break. */
export const DEGENERATE_REPEAT_NUDGE =
  "You've called the same tool(s) with the same arguments and gotten the same result several " +
  "times in a row — you're looping without making progress. STOP repeating that call. Take a " +
  "DIFFERENT concrete action toward the task; if you're genuinely stuck, say what's blocking you " +
  "and stop."

/** Final text stamped when the breaker force-stops a run that ignored the nudge
 *  and kept repeating — so the caller reads a loop-stop, not a real answer. */
export const DEGENERATE_LOOP_STOP =
  "[stopped: repeated the same tool call with no progress — the run was looping]"

/**
 * A short, safe one-line label for a tool call on its `agent.tool` span. NOT a
 * parse or a validation — by the time this runs `@effect/ai` has already
 * schema-decoded the args (a bad shape never reaches the handler), and here the
 * toolkit is generic so `params` is type-erased (`unknown`). This only PROJECTS
 * the args for display, so it stays a *total, schema-free, tool-agnostic* read
 * over arbitrary (and future) tool shapes: keep short scalar fields, and drop
 * arrays/objects and any long string — a file's contents or a big diff is noise
 * (and unwanted) in a trace label. A label, not a contract — best-effort by
 * design; clipped as a final backstop.
 */
export const safeArgsSummary = (params: unknown): string => {
  if (params === null || typeof params !== "object") return ""
  const parts: string[] = []
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    // Long strings are a file's contents / a big diff — never surfaced. Short
    // scalars (path, command, query, pattern, timeout, …) are the useful label;
    // arrays/objects (edit lists, nested params) are dropped as noise.
    if (typeof v === "string") {
      if (v.length > 0 && v.length <= 120) parts.push(`${k}=${v}`)
    } else if (typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k}=${v}`)
    }
  }
  return clip(parts.join(" "), 200)
}

/**
 * A best-effort, throw-free projection of a tool *result* for the trace log
 * narrative — every string/scalar leaf as `key: value`, bounded depth,
 * ref-cycle-safe (the malformed-call wrapper points `result`/`encodedResult`
 * at the *same* object, so the seen-set drops the duplicate). Clipped as a
 * backstop. A log breadcrumb, not a contract — no JSON.stringify (it can throw,
 * banned in core), no schema knowledge, total over arbitrary tool shapes.
 */
export const safeResultSummary = (value: unknown, max: number): string => {
  const seen = new Set<object>()
  const walk = (v: unknown, depth: number): string => {
    if (typeof v === "string") return v
    if (typeof v === "number" || typeof v === "boolean") return String(v)
    if (v === null || v === undefined || depth >= 4 || typeof v !== "object") return ""
    if (seen.has(v)) return ""
    seen.add(v)
    if (Array.isArray(v)) {
      return v.map((x) => walk(x, depth + 1)).filter((s) => s.length > 0).join(", ")
    }
    const parts: string[] = []
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const s = walk(val, depth + 1)
      if (s.length > 0) parts.push(`${k}: ${s}`)
    }
    return parts.join("\n")
  }
  return clip(walk(value, 0), max)
}

/**
 * `@effect/ai` decodes a *known* tool call's parameters inside `Toolkit.handle`,
 * before our handler runs — so a wrong-shaped call (right name, bad args) fails
 * with `AiError.MalformedOutput`, which `failureMode: "return"` never sees (it
 * only catches *handler* failures), aborting the whole turn.
 *
 * Wrapping the resolved handler turns those **model-caused** failures into an
 * ordinary tool *result* (`isFailure: true`): the assistant tool-call ↔
 * tool-result pairing stays valid, the loop keeps iterating, and the model
 * gets the decode error back as feedback and retries — the same recovery path
 * as any returned tool failure. `MalformedInput` is let through on purpose:
 * that's a result encode/validate failure (our bug, not the model's) and
 * should surface rather than be silently masked.
 *
 * NOTE: a *hallucinated tool name* (one not in the toolkit) fails one layer
 * earlier — when `generateText` decodes the response, the `ToolCallPart.name`
 * literal union rejects it — so it never reaches `handle` and this wrapper
 * can't catch it. That case is recovered in `runAgentLoop` itself (the
 * `MalformedOutput` catch around `generateText`).
 */
export const recoverMalformedToolCalls = <Tools extends Record<string, Tool.Any>>(
  base: Toolkit.WithHandler<Tools>,
): Toolkit.WithHandler<Tools> => {
  const rawHandle = base.handle as (
    name: unknown,
    params: unknown,
  ) => Effect.Effect<unknown, unknown, unknown>
  const handle = (name: unknown, params: unknown) =>
    rawHandle(name, params).pipe(
      Effect.catchAll((err) => {
        const e = err as { readonly _tag?: string; readonly description?: string } | null
        if (e?._tag !== "MalformedOutput") return Effect.fail(err)
        const failure = {
          error: "InvalidToolCall",
          message: `${clip(
            e.description ?? "the tool call could not be processed",
            800,
          )} — the arguments did not match the tool's schema; re-call the tool with parameters that match its documented shape.`,
        }
        return Effect.succeed({ isFailure: true, result: failure, encodedResult: failure })
      }),
      // One span per tool execution — the seam every tool call funnels through
      // (base tools, run_agent, sub-agent tools), so the trace waterfall shows
      // the tools under each turn (a graceful `failureMode:"return"` failure is
      // a *result* with `isFailure:true`, marked on the span so TraceQL
      // `{ status = error }` and the RED panels see it).
      Effect.tap((r) =>
        Effect.gen(function* () {
          const failed = (r as { readonly isFailure?: boolean } | null)?.isFailure === true
          // Scope this tool span to its root conversation so dashboards can
          // filter it WITHOUT name-matching or the `>>` descendant operator —
          // the conversation id is ambient on `RunContextRef`.
          const rc = yield* FiberRef.get(RunContextRef)
          yield* Effect.annotateCurrentSpan({
            ...(failed ? { "agent.tool.ok": false, error: true } : { "agent.tool.ok": true }),
            ...(rc.rootConversationId !== null
              ? { "agent.conversation_id": rc.rootConversationId }
              : {}),
          })
          // Tool I/O as a trace+span-correlated log, emitted INSIDE the
          // `agent.tool` span so Grafana's "Logs for this span" on a tool call
          // shows its args + result (the same idea as the llm.generate I/O
          // logs). Clipped — the full result still lives in the buffer/span.
          yield* Effect.logInfo(
            `tool ${String(name)}(${safeArgsSummary(params)}) ${failed ? "✗ failed" : "▸ ok"}\n` +
              safeResultSummary(r, 1500),
          )
        }),
      ),
      Effect.withSpan(toolSpanName(String(name)), {
        attributes: {
          "agent.kind": "tool",
          "agent.tool.name": String(name),
          "agent.tool.args_summary": safeArgsSummary(params),
        },
      }),
    )
  return { tools: base.tools, handle } as unknown as Toolkit.WithHandler<Tools>
}

export const runAgentLoop = <Tools extends Record<string, Tool.Any>, R>(
  input: RunAgentLoopInput<Tools, R>,
) =>
  Effect.gen(function* () {
    const hooks = input.hooks
    // Default for the loop when `maxSteps` is unset — generous so a root
    // orchestrating a fleet (spawn → wait_for_agents loop → synthesize across
    // pieces) isn't truncated mid-coordination. A ceiling, not a target: a normal
    // turn still ends as soon as the model stops calling tools.
    const maxSteps = input.maxSteps ?? 100
    let messages: ReadonlyArray<AgentMessage> = input.messages
    let finalText = ""
    let turnIndex = 0
    // Everything the loop appends — model responses AND its own synthetic
    // correctives — tracked explicitly so callers persist exactly this,
    // never an index-arithmetic slice of the (transformable) buffer.
    const newTail: AgentMessage[] = []

    // Resolve the toolkit's handler once (it reads the handler Layer from
    // context), then wrap it so a malformed tool call is fed back as a tool
    // *result* the model can correct on the next turn — instead of a decode
    // failure aborting the turn. Handlers are stable across turns, so this is
    // resolved a single time, not per request.
    const toolkit = recoverMalformedToolCalls(yield* input.toolkit)
    const toolNames = Object.keys(toolkit.tools)

    // The root conversation id is ambient on `RunContextRef` (seeded by
    // `runAgent`, re-seeded per sub-agent). Stamp it on every turn span so
    // dashboards scope turns to a conversation by a stable attribute, not by
    // the (renamable) span name.
    const runContext = yield* FiberRef.get(RunContextRef)

    // Compression is an agent property: an explicit override on the input wins,
    // else the policy threaded on RunContext (so a sub-agent inherits its root's
    // policy), else the SDK default (today's compaction tail + identity context).
    const compression = input.compression ?? runContext.compression ?? Compaction.default()
    const tailCompressor = compression.tail ?? Compression.passthroughTail

    // A response whose parts don't decode — most often a hallucinated tool
    // *name* (not in the toolkit's name union), which fails INSIDE
    // `generateText` before any handler runs, so `recoverMalformedToolCalls`
    // never sees it — would otherwise abort the whole turn. Instead we feed the
    // decode error back as a corrective message and let the model retry,
    // bounded so a persistently-broken model can't spin forever.
    let consecutiveMalformed = 0
    const MAX_MALFORMED = 3
    // Degenerate-repeat circuit breaker state: the previous turn's tool-activity
    // signature and how many consecutive turns have matched it (see the loop
    // body and `repeatSignature`).
    let consecutiveRepeats = 0
    let lastRepeatSig = ""
    // Whether the latest response still asked for tool calls — at loop exit
    // this distinguishes "finished" from "cut off by the step cap".
    let stillWantedMore = false

    // Cumulative token usage across the whole run — annotated onto the enclosing
    // `agent.run` span at the end so the run total reads at a glance.
    let totalIn = 0
    let totalOut = 0
    let totalCache = 0

    while (turnIndex < maxSteps) {
      // Moment 2 — in-memory whole-context transform before the prompt is built.
      // The agent's policy runs first, then the driver's hook (both respected;
      // neither is persisted). Default policy context is identity (off).
      if (compression.context) {
        messages = yield* compression.context(messages)
      }
      if (hooks?.onTransformContext) {
        messages = yield* hooks.onTransformContext(messages)
      }
      if (hooks?.onTurnStart) {
        yield* hooks.onTurnStart({ turnIndex, messages })
      }

      const prompt = Prompt.make([
        { role: "system", content: input.system },
        ...toPromptMessages(messages),
      ] as never)

      const turnStart = yield* Clock.currentTimeMillis
      const outcome = yield* LanguageModel.generateText({
        prompt,
        toolkit,
        concurrency: input.toolConcurrency ?? DEFAULT_TOOL_CONCURRENCY,
      }).pipe(
        Effect.tap((res) =>
          Effect.annotateCurrentSpan({
            "agent.turn": turnIndex,
            "agent.finish_reason": String(res.finishReason),
            "agent.tool_calls": responseToolCalls(res.content as ReadonlyArray<unknown>).length,
            // Per-turn token usage on the turn span itself, so the waterfall is
            // readable without expanding the child llm.generate span.
            ...usageAttributes(extractUsage(res.usage, res.content as ReadonlyArray<unknown>)),
          }),
        ),
        Effect.map((res) => ({ _tag: "ok" as const, res })),
        Effect.catchAll((err) =>
          (err as { readonly _tag?: string } | null)?._tag === "MalformedOutput"
            ? Effect.succeed({ _tag: "malformed" as const, err })
            : Effect.fail(err),
        ),
        Effect.withSpan(turnSpanName(turnIndex), {
          attributes: {
            ...agentSpanAttributes("turn", runContext.rootConversationId),
            "agent.turn": turnIndex,
          },
        }),
      )
      yield* recordTurn((yield* Clock.currentTimeMillis) - turnStart)

      // Response didn't decode (e.g. an unknown tool name): feed the decode
      // error back as a corrective turn and retry, instead of aborting.
      if (outcome._tag === "malformed") {
        consecutiveMalformed++
        yield* recordError("turn", "malformed")
        if (consecutiveMalformed >= MAX_MALFORMED) return yield* Effect.fail(outcome.err)
        const desc = clip(
          String(
            (outcome.err as { readonly description?: unknown }).description ??
              "the response could not be parsed",
          ),
          600,
        )
        yield* Effect.logWarning(`recovering from malformed response: ${desc}`)
        const corrective: AgentMessage = {
          role: "user",
          content:
            `Your previous reply could not be parsed: ${desc}\n\n` +
            `This usually means you called a tool that doesn't exist or used the wrong ` +
            `argument shape. The only tools available are: ${toolNames.join(", ")}. ` +
            `Reply again using one of those tools, or plain text if you're done.`,
        }
        messages = [...messages, corrective]
        newTail.push(corrective)
        if (input.onTail) yield* input.onTail([corrective])
        turnIndex++
        continue
      }
      consecutiveMalformed = 0
      const res = outcome.res

      const content = res.content as ReadonlyArray<unknown>
      // Mint a deterministic id for any tool call/result the provider returned
      // WITHOUT one (Gemini does this), in place on the response content BEFORE
      // it fans out into the persisted tail AND the emitted events — so the live
      // pump and a later re-projection compute the SAME rail-pill key (no
      // duplicate / jump-to-end on re-attach). A real provider id is left as-is.
      ensureToolCallIds(content, turnIndex)
      const rawTail = responseToAgentMessages(content)
      // Moment 1 — the agent's tail compressor runs HERE, the only moment a
      // tool result enters the buffer, so the persisted history and every
      // future prompt prefix carry the compressed form from byte one (caches
      // stay warm; nothing is ever rewritten). Hooks below still emit the RAW
      // results, so the human-facing rail shows the full output.
      const budget: CompressionBudget = {
        maxChars: input.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
      }
      const compressed = yield* tailCompressor(rawTail, budget)
      const tail = [...compressed.messages]
      if (compressed.helperUsage !== undefined && hooks?.onHelperUsage) {
        yield* hooks.onHelperUsage({ role: "fast", usage: compressed.helperUsage })
      }
      const usage = extractUsage(res.usage, content)
      attachUsageToAssistant(tail, usage)
      totalIn += usage.inputTokens
      totalOut += usage.outputTokens
      totalCache += usage.cacheReadTokens
      messages = [...messages, ...tail]
      newTail.push(...tail)
      // Persist the tail (assigning store positions) BEFORE the hooks fire, so
      // the assistant message's durable position is known when we emit its
      // event — the UI keys the rail block on it. `onTail` returns the assigned
      // positions aligned with `tail`; the assistant message is `tail`'s lone
      // `role:"assistant"` entry.
      const tailPositions = input.onTail ? yield* input.onTail(tail) : undefined
      const assistantTailIdx = tail.findIndex((m) => m.role === "assistant")
      const assistantPosition =
        tailPositions !== undefined && assistantTailIdx >= 0
          ? tailPositions[assistantTailIdx]
          : undefined

      const text = res.text
      if (text.length > 0) finalText = text
      const reasoning = responseReasoning(content)
      const toolCalls = responseToolCalls(content)

      // Re-emit the legacy hook vocabulary from the resolved response so
      // the CLI's execution tree / token gauge keep working unchanged.
      // The assistant message (reasoning + narration) fires *before* the
      // tool events so per step it renders above that step's tool pills.
      if (hooks?.onAssistantMessage) {
        yield* hooks.onAssistantMessage({
          turnIndex,
          text,
          reasoning,
          toolCalls,
          usage: extractUsage(res.usage, content),
          ...(assistantPosition !== undefined ? { position: assistantPosition } : {}),
        })
      }
      if (hooks?.onBeforeToolCall) {
        for (const tc of toolCalls) {
          yield* hooks.onBeforeToolCall({
            turnIndex,
            toolCallId: tc.id,
            toolName: tc.toolName,
            args: tc.args,
          })
        }
      }
      for (const tr of responseToolResults(content)) {
        yield* recordToolCall(tr.toolName, tr.ok)
        if (!tr.ok) {
          yield* recordError("tool", tr.toolName)
          // A trace-correlated log of the failure (visible in "Logs for this
          // trace" via the OTLP→Loki pipeline when telemetry is on).
          yield* Effect.logWarning(`tool ${tr.toolName} failed`)
        }
        if (hooks?.onAfterToolCall) {
          yield* hooks.onAfterToolCall({
            turnIndex,
            toolCallId: tr.id,
            toolName: tr.toolName,
            args: {},
            ok: tr.ok,
            result: tr.result,
          })
        }
      }

      // Per-turn heartbeat → the trace's log narrative (OTLP→Loki, correlated
      // by trace_id; inherits the run's `conversationId` annotation). One line
      // per turn, so "Logs for this trace" reads the execution at a glance.
      yield* Effect.logInfo(
        `turn ${turnIndex}: ${res.finishReason}` +
          (toolCalls.length > 0
            ? ` · ${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"}`
            : "") +
          ` · ${usage.totalTokens} tok`,
      )

      turnIndex++

      // --- Degenerate-repeat circuit breaker (mirrors the malformed breaker) ---
      // Same call(s) + same result(s) as the previous turn ⇒ no progress. Nudge
      // once at the threshold (a chance to course-correct), then force-stop if it
      // keeps repeating — so a fixating model (e.g. `list_scheduled_jobs` ×30)
      // can't spin the loop to its step cap, burning tokens and saturating the
      // provider. Pollable tools never count (see `repeatSignature`).
      const repeatSig = repeatSignature(content)
      if (repeatSig !== "" && repeatSig === lastRepeatSig) consecutiveRepeats++
      else consecutiveRepeats = 0
      lastRepeatSig = repeatSig
      if (repeatSig !== "" && consecutiveRepeats >= REPEAT_BREAK_AT) {
        yield* recordError("turn", "degenerate-loop")
        yield* Effect.logWarning(
          `breaking a degenerate tool-call loop: ${consecutiveRepeats + 1} identical no-progress turns`,
        )
        if (finalText.length === 0) finalText = DEGENERATE_LOOP_STOP
        stillWantedMore = false
        break
      }
      if (repeatSig !== "" && consecutiveRepeats === REPEAT_NUDGE_AT) {
        const corrective: AgentMessage = { role: "user", content: DEGENERATE_REPEAT_NUDGE }
        messages = [...messages, corrective]
        newTail.push(corrective)
        if (input.onTail) yield* input.onTail([corrective])
      }

      const wantsMore = res.finishReason === "tool-calls" && toolCalls.length > 0
      if (!wantsMore) {
        stillWantedMore = false
        break
      }
      stillWantedMore = true
      if (hooks?.onShouldStopAfterTurn) {
        const stop = yield* hooks.onShouldStopAfterTurn({
          turnIndex,
          finishReason: res.finishReason,
        })
        if (stop) break
      }
    }

    // Run-level rollup on the enclosing `agent.run` span (the turn spans have
    // closed, so the current span is the run). Distinct `agent.total_*` keys.
    yield* Effect.annotateCurrentSpan({
      "agent.turns": turnIndex,
      "agent.total_input_tokens": totalIn,
      "agent.total_output_tokens": totalOut,
      "agent.total_cache_read_tokens": totalCache,
    })

    if (hooks?.onAgentEnd) {
      yield* hooks.onAgentEnd({ messages, finalText })
    }

    // Exhausted the step cap while the model still asked for tools → the last
    // text is mid-thought, not a final answer. Tell the caller.
    const stoppedAtMaxSteps = turnIndex >= maxSteps && stillWantedMore
    return {
      finalText,
      messages,
      newTail,
      ...(stoppedAtMaxSteps ? { stoppedAtMaxSteps } : {}),
    } satisfies AgentResult as AgentResult
  })
