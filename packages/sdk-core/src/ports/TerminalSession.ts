import { Context, Data, type Effect } from "effect"

/** Any tmux/session failure, surfaced to the model as a returnable tool failure. */
export class TerminalSessionError extends Data.TaggedError(
  "TerminalSessionError",
)<{
  readonly message: string
}> {}

export interface TerminalSessionStartInput {
  /** Human-friendly label; the real id is namespaced for `tmux attach`. */
  readonly name?: string
  /** Optional command to launch in the pane (e.g. a TUI / REPL). Omit for a shell. */
  readonly command?: string
  readonly cwd: string
  /** Tags the session so teardown can kill just one conversation's sessions. */
  readonly conversationId?: string
}

export interface TerminalSessionStartResult {
  readonly sessionId: string
}

export interface TerminalSessionSendInput {
  readonly sessionId: string
  /** Literal keys to type. tmux key syntax is honored (e.g. `C-c`, `Enter`). */
  readonly keys: string
  /** Append an Enter after the keys (default true). */
  readonly enter?: boolean
}

export interface TerminalSessionReadInput {
  readonly sessionId: string
  /** How many trailing lines of the pane to capture (default: the visible screen). */
  readonly lines?: number
}

export interface TerminalSessionReadResult {
  readonly screen: string
}

export interface TerminalSessionInfo {
  readonly sessionId: string
}

/**
 * Persistent, INTERACTIVE terminal sessions backed by tmux — the thing
 * `Shell.exec` (one-shot, pipes, no TTY) can't do. A session outlives the tool
 * call: start it, drive it with keystrokes, capture its screen across many
 * turns, kill it. Sessions are namespaced so a human can `tmux attach` to the
 * same live pane. Optional: when tmux isn't installed, `available` is false and
 * the ops return a graceful `TerminalSessionError`, never a crash.
 */
export class TerminalSession extends Context.Tag(
  "@xandreed/sdk-core/TerminalSession",
)<
  TerminalSession,
  {
    /** Feature-detect: is `tmux` on PATH? */
    readonly available: Effect.Effect<boolean>
    readonly start: (
      input: TerminalSessionStartInput,
    ) => Effect.Effect<TerminalSessionStartResult, TerminalSessionError>
    readonly send: (
      input: TerminalSessionSendInput,
    ) => Effect.Effect<void, TerminalSessionError>
    readonly read: (
      input: TerminalSessionReadInput,
    ) => Effect.Effect<TerminalSessionReadResult, TerminalSessionError>
    readonly kill: (
      sessionId: string,
    ) => Effect.Effect<{ readonly killed: boolean }>
    readonly list: () => Effect.Effect<ReadonlyArray<TerminalSessionInfo>>
    /** Teardown hook: kill every session (optionally scoped to a conversation). */
    readonly killAll: (conversationId?: string) => Effect.Effect<void>
  }
>() {}
