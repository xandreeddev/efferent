/**
 * How `processShell` runs commands (ADR 0028).
 *
 * - `cwd`: the absolute folder a command starts in when its request names none, and that a relative `cwd` of a
 *   request is read against. A starting folder only: a command reaches whatever the host's rights reach.
 * - `env`: every variable a command is given, and nothing else: the adapter never reads the host process's own
 *   environment. Empty by default. The shell is started by its absolute path, so it needs no variable to start;
 *   with no `PATH`, `sh` looks commands up on its own default path. A host that wants its own `PATH`, `HOME` or
 *   `LANG` passes them here.
 * - `shell`: the absolute path of a POSIX `sh`, `/bin/sh` by default.
 * - `outputBytes`: how many of the last bytes of each of stdout and stderr a run keeps, 8,192 by default: a result of
 *   `runCommand` is stored and, under a memory that sends every result, sent in every later prompt, so two streams at
 *   the default put at most 16 KiB there per call.
 * - `timeoutMs`: how long a command runs when its request names no time, 120,000 by default.
 *
 * @public
 */
export interface ProcessShellOptions {
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly shell?: string
  readonly outputBytes?: number
  readonly timeoutMs?: number
}

/** The defaults of `ProcessShellOptions`. */
export const PROCESS_SHELL_DEFAULTS = { shell: "/bin/sh", outputBytes: 8_192, timeoutMs: 120_000 } as const

/** How long a run waits, after the command's processes are stopped, for its output pipes to close. */
export const CLOSE_GRACE_MS = 2_000
