import { Context, Schema } from "effect"
import type { Effect } from "effect"

export class ShellError extends Schema.TaggedError<ShellError>()("ShellError", {
  message: Schema.String,
}) {}

export class ShellResult extends Schema.Class<ShellResult>("ShellResult")({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Number,
}) {}

/**
 * Subprocess execution. A non-zero exit is a RESULT (the model reads the
 * code + stderr and adapts), never an error — the error channel carries only
 * spawn/timeout infrastructure failures.
 */
export class Shell extends Context.Tag("@xandreed/engine/Shell")<
  Shell,
  {
    readonly exec: (
      command: string,
      options?: { readonly cwd?: string; readonly timeoutMs?: number },
    ) => Effect.Effect<ShellResult, ShellError>
  }
>() {}
