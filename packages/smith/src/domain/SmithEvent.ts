import type { Option } from "effect"
import type { FactoryRun, GateReport, Spec } from "@xandreed/foundry"
import type { LoopEvent, SpecDoc } from "@xandreed/engine"

/**
 * The ONE event union the smith UIs consume — in-process only (never a wire
 * format). Two hook families fan into a single queue:
 * - foundry's `ForgeHooks` → the loop-level events (`attempt_start` /
 *   `implement_end` / `gate_report`), plus `forge_start`/`forge_end`/
 *   `forge_error` emitted by the session driver and `gate_start` from the
 *   gate decorator (`withGateEvents`);
 * - the efferent coder's `AgentHooks` (via the engine loop's `onEvent` sink)
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
  /** RED-FIRST: accept checks that already PASS on the untouched workspace —
   *  vacuous (they cannot measure this spec's work). A warning, not a stop. */
  | { readonly type: "vacuous_checks"; readonly names: ReadonlyArray<string> }
  /** The harness capabilities loaded for this run — workspace skills and the
   *  external MCP tools, surfaced once at session start so what the coder can
   *  reach is VISIBLE (progressive disclosure is otherwise silent). */
  | {
      readonly type: "capabilities"
      readonly skills: number
      readonly mcpServers: number
      readonly mcpTools: number
    }
  | { readonly type: "attempt_start"; readonly attempt: number }
  /** ATTEMPT-BOUNDARY COMPACTION: the trail outgrew the healthy context range
   *  and was folded into a handoff summary before this attempt ran. */
  | { readonly type: "context_folded"; readonly attempt: number; readonly tokens: number }
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
  /** MEMORY v2: the post-forge curator appended verbs to the workspace's
   *  memory ledger — the counts per consolidation verb. */
  | {
      readonly type: "memory_updated"
      readonly created: number
      readonly updated: number
      readonly corroborated: number
      readonly invalidated: number
    }
  /** The curator distilled corroborated memory into `learned-<topic>` skill
   *  files — the loop authoring its own procedures. Names of the skills now
   *  present; only emitted when at least one was written. */
  | { readonly type: "skills_distilled"; readonly names: ReadonlyArray<string> }
  /** The SHIP sequence (branch → stage → commit → push → PR) — one event per
   *  step; a failed step stops the sequence, its detail carries the stderr. */
  | {
      readonly type: "ship_step"
      readonly step: string
      readonly ok: boolean
      readonly detail: string
    }
  | { readonly type: "agent"; readonly event: LoopEvent }
