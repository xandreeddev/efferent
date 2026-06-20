import type { AgentDefinition, Scope, Skill } from "@xandreed/sdk-core"
import type { InstructionFile } from "../usecases/discoverInstructionFiles.js"
import type { ToolDefinition } from "../usecases/loadTools.js"

/**
 * The TUI driver lives in `packages/code/src/cli/` (OpenTUI + SolidJS) — the
 * frontend for the agent. This module is the stable `TuiModeInput` seam:
 * `main.ts` builds one and hands it to `runTuiModeSolid` (`cli/runtime.ts`),
 * loaded via a lazy
 * dynamic `import()` so `@opentui/core`'s native FFI library is touched ONLY on
 * the interactive-TUI path — print / json / rpc never import it.
 *
 * Kept as a type-only module (no value export) on purpose: a static value
 * re-export here would pull the native renderer into every mode's startup.
 */
export interface TuiModeInput {
  readonly cwd: string
  readonly skills: ReadonlyArray<Skill>
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly rootScope: Scope
  readonly instructionFiles: ReadonlyArray<InstructionFile>
  readonly resumeConversationId?: string
}
