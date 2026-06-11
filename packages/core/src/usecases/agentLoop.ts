import { LanguageModel, Prompt, type Tool, type Toolkit } from "@effect/ai"
import { Effect } from "effect"
import type { AgentHooks } from "../entities/AgentHooks.js"
import type { AgentMessage, AgentResult } from "../entities/Conversation.js"
import { compressToolResults, DEFAULT_TOOL_RESULT_MAX_CHARS } from "./headroom.js"
import {
  attachUsageToAssistant,
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
   * Headroom: per-string budget (chars) for a tool result entering the
   * buffer — over it, the string is clipped head+tail with a reversible
   * marker (+ a FAST-tier digest of the dropped middle when `UtilityLlm` is
   * around). Append-time, so the prompt-cache prefix is never rewritten.
   * Default {@link DEFAULT_TOOL_RESULT_MAX_CHARS}; 0 disables.
   */
  readonly toolResultMaxChars?: number
}

/** Tool calls resolved concurrently per step (interruption-safe via Effect). */
export const DEFAULT_TOOL_CONCURRENCY = 4

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}…`)

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
    )
  return { tools: base.tools, handle } as unknown as Toolkit.WithHandler<Tools>
}

export const runAgentLoop = <Tools extends Record<string, Tool.Any>, R>(
  input: RunAgentLoopInput<Tools, R>,
) =>
  Effect.gen(function* () {
    const hooks = input.hooks
    const maxSteps = input.maxSteps ?? 20
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

    // A response whose parts don't decode — most often a hallucinated tool
    // *name* (not in the toolkit's name union), which fails INSIDE
    // `generateText` before any handler runs, so `recoverMalformedToolCalls`
    // never sees it — would otherwise abort the whole turn. Instead we feed the
    // decode error back as a corrective message and let the model retry,
    // bounded so a persistently-broken model can't spin forever.
    let consecutiveMalformed = 0
    const MAX_MALFORMED = 3
    // Whether the latest response still asked for tool calls — at loop exit
    // this distinguishes "finished" from "cut off by the step cap".
    let stillWantedMore = false

    while (turnIndex < maxSteps) {
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

      const outcome = yield* LanguageModel.generateText({
        prompt,
        toolkit,
        concurrency: input.toolConcurrency ?? DEFAULT_TOOL_CONCURRENCY,
      }).pipe(
        Effect.map((res) => ({ _tag: "ok" as const, res })),
        Effect.catchAll((err) =>
          (err as { readonly _tag?: string } | null)?._tag === "MalformedOutput"
            ? Effect.succeed({ _tag: "malformed" as const, err })
            : Effect.fail(err),
        ),
      )

      // Response didn't decode (e.g. an unknown tool name): feed the decode
      // error back as a corrective turn and retry, instead of aborting.
      if (outcome._tag === "malformed") {
        consecutiveMalformed++
        if (consecutiveMalformed > MAX_MALFORMED) return yield* Effect.fail(outcome.err)
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
        turnIndex++
        continue
      }
      consecutiveMalformed = 0
      const res = outcome.res

      const content = res.content as ReadonlyArray<unknown>
      const rawTail = responseToAgentMessages(content)
      // Headroom: oversized tool results are compressed HERE — the only
      // moment they enter the buffer — so the persisted history and every
      // future prompt prefix carry the clipped form from byte one (caches
      // stay warm; nothing is ever rewritten). Hooks below still emit the
      // RAW results, so the human-facing rail shows the full output.
      const compressed = yield* compressToolResults(
        rawTail,
        input.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
      )
      const tail = [...compressed.messages]
      if (compressed.helperUsage !== undefined && hooks?.onHelperUsage) {
        yield* hooks.onHelperUsage({ role: "fast", usage: compressed.helperUsage })
      }
      const usage = extractUsage(res.usage, content)
      attachUsageToAssistant(tail, usage)
      messages = [...messages, ...tail]
      newTail.push(...tail)

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
      if (hooks?.onAfterToolCall) {
        for (const tr of responseToolResults(content)) {
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

      turnIndex++

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
