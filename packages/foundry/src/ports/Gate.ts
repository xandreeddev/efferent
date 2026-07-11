import type { Effect } from "effect"
import type { GateName, WorkspacePath } from "../domain/Brands.js"
import type { GateCrash } from "../domain/Errors.js"
import type { Finding } from "../domain/Finding.js"

/**
 * A gate is a VALUE, not a service (like an eval `Scorer`): pipelines are
 * data you compose. Only genuinely shared infrastructure (`TsProject`,
 * `Implementor`, `RunSink`) is a `Context.Tag`; a gate's own requirements
 * flow up into the pipeline type through `R`.
 */

/** Cost/determinism class. Cheap+deterministic ranks run before
 *  expensive+stochastic ones — never run tests on code that doesn't
 *  typecheck, never spend judge tokens on code that fails the AST rules. */
export type GateKind = "static" | "typecheck" | "test" | "eval" | "judge"

export const kindRank: Record<GateKind, number> = {
  static: 0,
  typecheck: 1,
  test: 2,
  eval: 3,
  judge: 4,
}

/** The snapshot a pipeline judges: an absolute root + relative file list. */
export interface Workspace {
  readonly rootDir: string
  readonly files: ReadonlyArray<WorkspacePath>
}

/** A per-file stat signature of the workspace — the forge loop's movement
 *  oracle. Diffing two of these OBSERVES what actually changed on disk, so
 *  work done through Bash (heredocs, generators, formatters) counts the same
 *  as tool-call writes (the zig re-forge recorded "0 files touched" across
 *  three attempts while `main.zig` was being rewritten via `cat >`). */
export type WorkspaceFingerprint = ReadonlyMap<WorkspacePath, string>

export interface Gate<R = never> {
  readonly name: GateName
  readonly kind: GateKind
  /** `false` for judge gates — reported on the verdict, never hidden. */
  readonly deterministic: boolean
  /**
   * Gates report findings; the PIPELINE classifies pass/fail (one rule, one
   * place — `toVerdict`). The error channel carries only "the gate could not
   * run" (`GateCrash`), which the pipeline folds fail-closed.
   */
  readonly run: (workspace: Workspace) => Effect.Effect<ReadonlyArray<Finding>, GateCrash, R>
}
