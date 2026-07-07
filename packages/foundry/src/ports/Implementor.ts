import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { AttemptNumber, WorkspacePath } from "../domain/Brands.js"
import type { ImplementorError } from "../domain/Errors.js"
import type { Spec } from "../domain/Spec.js"

export interface ImplementInput {
  readonly spec: Spec
  readonly attempt: AttemptNumber
  /** `renderFeedback`'s brief from the previous attempt; `None` on attempt 1. */
  readonly feedback: Option.Option<string>
  readonly workspaceDir: string
}

export interface ImplementReceipt {
  readonly filesTouched: ReadonlyArray<WorkspacePath>
}

/**
 * The generator — the thing that writes code into the workspace. An agent,
 * a `claude -p` subprocess, or a deterministic script (tests/CI). Foundry
 * never talks to an LLM directly; this port is the seam.
 */
export class Implementor extends Context.Tag("@xandreed/foundry/Implementor")<
  Implementor,
  {
    readonly implement: (
      input: ImplementInput,
    ) => Effect.Effect<ImplementReceipt, ImplementorError>
  }
>() {}
