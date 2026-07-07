import { Tool, Toolkit } from "@effect/ai"
import { Effect, Layer, Schema } from "effect"
import type { AgentConfig } from "@xandreed/sdk-core"
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

export const makeMathHandlers = (sink: MathRenderSink) => ({
  render_math: (params: { readonly items: ReadonlyArray<unknown> }) =>
    Effect.gen(function* () {
      const parsed = parseMathItems(params.items)
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

export const mathAgentBundle = (sink: MathRenderSink): MathAgentBundle => ({
  agentConfig: {
    key: "math-tutor",
    prompt: mathAgentPrompt(),
    toolkit: mathToolkit,
  },
  handlerLayer: mathToolkit.toLayer(makeMathHandlers(sink)),
})
