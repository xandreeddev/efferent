import { Effect, Layer } from "effect"
import { WorkspacePath } from "../domain/Brands.js"
import { ImplementorError } from "../domain/Errors.js"
import { Implementor } from "../ports/Implementor.js"
import { writeWorkspaceFile } from "./tempWorkspace.js"

export interface ScriptedWrite {
  readonly path: string
  readonly content: string
}

/**
 * A deterministic implementor: attempt N writes `steps[N-1]` — how the loop
 * is exercised key-free in tests and CI (an attempt past the script writes
 * nothing, so the verdict repeats until a cap trips).
 */
export const makeScriptedImplementor = (
  steps: ReadonlyArray<ReadonlyArray<ScriptedWrite>>,
): Layer.Layer<Implementor> =>
  Layer.succeed(Implementor, {
    implement: ({ attempt, workspaceDir }) => {
      const writes = steps[attempt - 1] ?? []
      return Effect.forEach(writes, (write) =>
        writeWorkspaceFile(workspaceDir, write.path, write.content),
      ).pipe(
        Effect.mapError((e) => new ImplementorError({ attempt, message: e.message })),
        Effect.as({ filesTouched: writes.map((w) => WorkspacePath.make(w.path)) }),
      )
    },
  })
