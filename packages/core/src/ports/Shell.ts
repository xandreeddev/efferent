import { Context, Data, type Effect } from "effect"

export class ShellError extends Data.TaggedError("ShellError")<{
  readonly cause: unknown
  readonly message: string
}> {}

export class ShellTimeout extends Data.TaggedError("ShellTimeout")<{
  readonly command: string
  readonly timeoutMs: number
}> {}

export class ShellAborted extends Data.TaggedError("ShellAborted")<{
  readonly command: string
}> {}

export interface ShellExecInput {
  readonly command: string
  readonly cwd: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface ShellExecResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
}

export class Shell extends Context.Tag("@agent/core/Shell")<
  Shell,
  {
    readonly exec: (
      input: ShellExecInput,
    ) => Effect.Effect<
      ShellExecResult,
      ShellTimeout | ShellAborted | ShellError
    >
  }
>() {}
