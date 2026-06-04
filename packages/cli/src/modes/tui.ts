import type { InstructionFile, Scope, Skill } from "@efferent/core"

/**
 * The TUI driver moved to `packages/cli/src/tui-solid/` (OpenTUI + SolidJS).
 * This module is now just the stable `TuiModeInput` seam: `main.ts` builds one
 * and hands it to `runTuiModeSolid` (`tui-solid/runtime.ts`), loaded via a lazy
 * dynamic `import()` so `@opentui/core`'s native FFI library is touched ONLY on
 * the interactive-TUI path — print / json / rpc never import it.
 *
 * Kept as a type-only module (no value export) on purpose: a static value
 * re-export here would pull the native renderer into every mode's startup.
 */
export interface TuiModeInput {
  readonly cwd: string
  readonly skills: ReadonlyArray<Skill>
  readonly rootScope: Scope
  readonly instructionFiles: ReadonlyArray<InstructionFile>
  readonly resumeConversationId?: string
}
