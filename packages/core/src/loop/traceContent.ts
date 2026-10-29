import { Context, References, Tracer } from "effect"

/**
 * Whether spans may carry prompt and response content: the step loop's
 * `engine.step.input` and `engine.step.output`, the models plugin's
 * `llm.reasoning`. Off by default. Read per call, never when a layer is
 * built: the step loop provides it for each run from
 * `StepRequest.captureTraceContent` (the policy's `captureTraceContent`,
 * else the agent's, else this reference where the run starts). Hosts own
 * consent, masking and exporter retention.
 *
 * A context reference, like `CurrentPromptCacheKey`: ambient call metadata
 * that flows through the loop's fibers without threading a parameter.
 */
export const CurrentTraceContent = Context.Reference<boolean>("@xandreed/core/CurrentTraceContent", {
  defaultValue: () => false,
})

/**
 * A context captured to be provided again later (the services a layer was
 * built with, the services where a turn's tools were opened), without the
 * trace state of the place it was captured, so the work it runs is traced
 * where that work runs:
 * - the parent span (`Tracer.ParentSpan`): spans nest under the span current
 *   where the work runs, not under the span current at capture;
 * - the span annotations and links (`Effect.annotateSpans`,
 *   `Effect.linkSpans`): providing the captured ones would replace those of
 *   where the work runs, the turn's ids among them;
 * - `CurrentTraceContent`, which is read per call.
 * The work then runs with the values of the fiber it runs in. Removing
 * these keys removes nothing the context's type names.
 */
export const replayableContext = <S>(context: Context.Context<S>): Context.Context<S> =>
  Context.omit(Tracer.ParentSpan, References.TracerSpanAnnotations, References.TracerSpanLinks, CurrentTraceContent)(context) as Context.Context<S>
