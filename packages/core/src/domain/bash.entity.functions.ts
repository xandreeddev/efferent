import { Clock, Effect, Option, Stream } from "effect"
import { BASH_ENV_ALLOWLIST } from "./bash.entity.js"
import type { BashError, BashEvent, BashExit, BashOptions, BashResult } from "./bash.entity.js"

/**
 * The environment a command gets: the parent's variables `inheritEnv`
 * admits (all, none, or an allowlist where a trailing `*` matches a prefix;
 * `BASH_ENV_ALLOWLIST` by default), then `env` over them. Unset parent
 * variables are skipped. Every `Bash` adapter builds the environment with
 * this, so the allowlist means the same everywhere.
 */
export const resolveBashEnv = (
  parent: Readonly<Record<string, string | undefined>>,
  options: Pick<BashOptions, "env" | "inheritEnv">,
): Readonly<Record<string, string>> => {
  const inherit = options.inheritEnv ?? BASH_ENV_ALLOWLIST
  const admitted = (name: string): boolean => typeof inherit === "boolean" ? inherit
    : inherit.some((entry) => entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry)
  const inherited = Object.entries(parent).flatMap(([name, value]) => value !== undefined && admitted(name) ? [[name, value] as const] : [])
  return { ...Object.fromEntries(inherited), ...options.env }
}

interface Collected {
  readonly stdout: string
  readonly stderr: string
  readonly exit: Option.Option<BashExit>
}

/**
 * A command's events folded into its result: `Bash.exec` is this over
 * `Bash.stream`. A stream that ends without its `BashExit` (its consumer
 * cut it short, e.g. with `Stream.interruptWhen`, and the adapter killed
 * the command) gives `termination: "interrupted"` with the output so far.
 */
export const collectBashResult = <R>(events: Stream.Stream<BashEvent, BashError, R>): Effect.Effect<BashResult, BashError, R> => Effect.gen(function* () {
  const started = yield* Clock.currentTimeMillis
  const collected = yield* Stream.runFold(events, (): Collected => ({ stdout: "", stderr: "", exit: Option.none() }), (state, event): Collected =>
    event._tag === "BashExit" ? { ...state, exit: Option.some(event) }
      : event.stream === "stdout" ? { ...state, stdout: state.stdout + event.text } : { ...state, stderr: state.stderr + event.text })
  const ended = yield* Clock.currentTimeMillis
  return Option.match(collected.exit, {
    onNone: (): BashResult => ({
      stdout: collected.stdout, stderr: collected.stderr, exitCode: Option.none(), signal: Option.none(), termination: "interrupted", durationMs: ended - started,
    }),
    onSome: (exit): BashResult => ({
      stdout: collected.stdout, stderr: collected.stderr, exitCode: exit.exitCode, signal: exit.signal, termination: exit.termination, durationMs: exit.durationMs,
    }),
  })
})
