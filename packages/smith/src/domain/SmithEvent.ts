import type { Option } from "effect"
import type { FactoryRun, GateReport, Spec } from "@xandreed/foundry"
import type { AgentEvent, SpecDoc } from "@xandreed/sdk-core"

/**
 * The ONE event union the smith UIs consume — in-process only (never a wire
 * format). Two hook families fan into a single queue:
 * - foundry's `ForgeHooks` → the loop-level events (`attempt_start` /
 *   `implement_end` / `gate_report`), plus `forge_start`/`forge_end`/
 *   `forge_error` emitted by the session driver and `gate_start` from the
 *   gate decorator (`withGateEvents`);
 * - the efferent coder's `AgentHooks` (via sdk-core's `makeAgentEventHooks`)
 *   → wrapped verbatim as `{ type: "agent", event }` — tool calls, assistant
 *   text, sub-agent lifecycle, llm retries.
 */
export type SmithEvent =
  | { readonly type: "refine_start"; readonly idea: Option.Option<string> }
  | { readonly type: "spec_draft"; readonly doc: SpecDoc; readonly path: string }
  | { readonly type: "spec_locked"; readonly doc: SpecDoc; readonly path: string }
  | { readonly type: "refine_error"; readonly message: string }
  | {
      readonly type: "forge_start"
      readonly spec: Spec
      readonly gateNames: ReadonlyArray<string>
      /** The locked SpecDoc driving this run (None on the legacy flag path). */
      readonly doc: Option.Option<SpecDoc>
    }
  | { readonly type: "attempt_start"; readonly attempt: number }
  | {
      readonly type: "implement_end"
      readonly attempt: number
      readonly filesTouched: ReadonlyArray<string>
      readonly ref: Option.Option<string>
    }
  | { readonly type: "gate_start"; readonly gate: string }
  | {
      readonly type: "gate_report"
      readonly attempt: number
      readonly report: GateReport
      readonly feedback: Option.Option<string>
    }
  | {
      readonly type: "forge_end"
      readonly run: FactoryRun
      readonly artifact: string
    }
  | { readonly type: "forge_error"; readonly message: string }
  | { readonly type: "agent"; readonly event: AgentEvent }
