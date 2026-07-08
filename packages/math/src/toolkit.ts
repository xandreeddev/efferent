import { Tool, Toolkit } from "@effect/ai"
import { Effect, Layer, Ref, Schema } from "effect"
import type { AgentConfig } from "@xandreed/engine"
import { parseMathItems, type MathItem } from "./domain/MathContent.js"
import { mathAgentPrompt } from "./prompt.js"

/**
 * `render_math` — the tutor's ONLY tool and only output channel. Items are
 * validated ONE BY ONE (`parseMathItems`): accepted items publish to the UI
 * immediately; rejected ones return to the model as data (`failureMode:
 * "return"` discipline — a partial batch is a graceful, fixable result, never
 * a dead turn). The tool's parameter schema is permissive (`Unknown` items)
 * for exactly that per-item salvage: a strict array schema would fail the
 * WHOLE call on one malformed item, upstream of the handler.
 */
const RenderMath = Tool.make("render_math", {
  description:
    "Present a batch of math exercises (and at most one coach note) to the student. Each item is validated server-side; rejected items come back with the reason — fix exactly what the rejection says and re-send ONLY the fixed items.",
  parameters: {
    items: Schema.Array(Schema.Unknown).annotations({
      description: "The batch: exercise items and at most one note item.",
    }),
  },
  success: Schema.Struct({
    accepted: Schema.Number,
    rejected: Schema.Array(
      Schema.Struct({ index: Schema.Number, reason: Schema.String }),
    ),
  }),
  failure: Schema.Struct({
    error: Schema.String,
    message: Schema.optional(Schema.String),
  }),
  failureMode: "return",
})

export const mathToolkit = Toolkit.make(RenderMath)

/** Where accepted items go — the session wires this to its event ledger. */
export type MathRenderSink = (items: ReadonlyArray<MathItem>) => Effect.Effect<void>

export const makeMathHandlers = (sink: MathRenderSink, served: Ref.Ref<ReadonlySet<string>>) => ({
  render_math: (params: { readonly items: ReadonlyArray<unknown> }) =>
    Effect.gen(function* () {
      const seen = yield* Ref.get(served)
      const parsed = parseMathItems(params.items, seen)
      const servedIds = parsed.accepted.flatMap((i) => (i.kind === "note" ? [] : [i.id]))
      if (servedIds.length > 0) {
        yield* Ref.update(served, (s) => new Set([...s, ...servedIds]))
      }
      if (parsed.accepted.length > 0) {
        yield* sink(parsed.accepted)
      }
      return {
        accepted: parsed.accepted.length,
        rejected: parsed.rejected.map((r) => ({ index: r.index, reason: r.reason })),
      }
    }),
})

/** The math tutor's agent config + its handler layer, bound to a render sink. */
export interface MathAgentBundle {
  readonly agentConfig: AgentConfig<(typeof mathToolkit)["tools"]>
  readonly handlerLayer: Layer.Layer<Tool.Handler<"render_math">>
}

/**
 * `served` is the SESSION-scope dedup memory: every exercise id the handler
 * has accepted this session. A later batch re-sending one bounces with a
 * "write a NEW exercise" reason — the model cannot pad a set by re-serving.
 * The caller owns the Ref so it outlives individual turns.
 */
export const mathAgentBundle = (
  sink: MathRenderSink,
  served: Ref.Ref<ReadonlySet<string>>,
): MathAgentBundle => ({
  agentConfig: {
    system: mathAgentPrompt().text,
    toolkit: mathToolkit,
    maxSteps: 12,
  },
  handlerLayer: mathToolkit.toLayer(makeMathHandlers(sink, served)),
})
