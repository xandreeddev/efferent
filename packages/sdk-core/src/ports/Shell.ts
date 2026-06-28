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

/** A background process id that is no longer tracked (finished + reaped, or never existed). */
export class ShellProcessNotFound extends Data.TaggedError("ShellProcessNotFound")<{
  readonly id: string
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

/** Start a long-lived process that OUTLIVES the spawning tool call. */
export interface ShellSpawnInput {
  readonly command: string
  readonly cwd: string
  /** Tags the process so teardown can kill just one session's background procs. */
  readonly conversationId?: string
}

export interface ShellSpawnResult {
  readonly id: string
  readonly pid: number | null
}

export interface ShellReadInput {
  readonly id: string
  /** Return only output produced after this opaque cursor (omit / 0 = from the start). */
  readonly sinceCursor?: number
}

export interface ShellReadResult {
  readonly stdout: string
  readonly stderr: string
  /** null while the process is still running. */
  readonly exitCode: number | null
  readonly running: boolean
  /** Opaque cursor to pass as the next `sinceCursor` for incremental output. */
  readonly cursor: number
}

export interface ShellProcInfo {
  readonly id: string
  readonly command: string
  readonly running: boolean
  readonly startedAt: number
  readonly pid: number | null
}

export class Shell extends Context.Tag("@xandreed/sdk-core/Shell")<
  Shell,
  {
    readonly exec: (
      input: ShellExecInput,
    ) => Effect.Effect<
      ShellExecResult,
      ShellTimeout | ShellAborted | ShellError
    >
    /**
     * Background process family — a process spawned here keeps running after the
     * tool call returns; its output is buffered and read incrementally, and it is
     * killed (by process group) explicitly or on session teardown. The default
     * one-shot `exec` is unchanged.
     */
    readonly spawnBackground: (
      input: ShellSpawnInput,
    ) => Effect.Effect<ShellSpawnResult, ShellError>
    readonly readBackground: (
      input: ShellReadInput,
    ) => Effect.Effect<ShellReadResult, ShellProcessNotFound>
    readonly killBackground: (
      id: string,
    ) => Effect.Effect<{ readonly killed: boolean }>
    readonly listBackground: (
      conversationId?: string,
    ) => Effect.Effect<ReadonlyArray<ShellProcInfo>>
    /** Teardown hook: group-kill every background proc (optionally scoped to a session). */
    readonly killAllBackground: (conversationId?: string) => Effect.Effect<void>
  }
>() {}
