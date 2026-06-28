import { Effect, Layer } from "effect"
import {
  Shell,
  TerminalSession,
  TerminalSessionError,
  type TerminalSessionInfo,
} from "@xandreed/sdk-core"

const TMUX_TIMEOUT_MS = 10_000
const SESSION_PREFIX = "efferent"

/** Single-quote for safe `bash -c` interpolation. */
const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/** Namespace-safe id fragment (tmux session names dislike most punctuation). */
const slug = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12)

/**
 * tmux-backed interactive sessions. Each session is a detached tmux session that
 * outlives the spawning tool call; the agent drives it with `send` and reads its
 * pane with `read`. Session ids are namespaced `efferent-<conv>-<n>` so a human
 * can `tmux attach -t <id>` to the same live pane. Shells out via the `Shell`
 * port — short, bounded commands.
 */
export const TmuxTerminalSessionLive = Layer.effect(
  TerminalSession,
  Effect.gen(function* () {
    const shell = yield* Shell
    // sessionId -> conversationId, for teardown scoping (tmux itself doesn't know).
    const owned = new Map<string, string | undefined>()
    let seq = 0

    const tmux = (args: string) =>
      shell
        .exec({ command: `tmux ${args}`, cwd: ".", timeoutMs: TMUX_TIMEOUT_MS })
        .pipe(
          Effect.mapError(
            (e) => new TerminalSessionError({ message: `tmux invocation failed (${e._tag})` }),
          ),
        )

    const available = tmux("-V").pipe(
      Effect.map((r) => r.exitCode === 0),
      Effect.catchAll(() => Effect.succeed(false)),
    )

    return {
      available,

      start: ({ name, command, cwd, conversationId }) =>
        Effect.gen(function* () {
          const id = `${SESSION_PREFIX}-${slug(conversationId ?? "s")}-${++seq}${
            name !== undefined ? `-${slug(name)}` : ""
          }`
          const launch = command !== undefined ? ` ${sq(command)}` : ""
          const r = yield* tmux(`new-session -d -s ${sq(id)} -c ${sq(cwd)}${launch}`)
          if (r.exitCode !== 0) {
            return yield* Effect.fail(
              new TerminalSessionError({
                message: `tmux new-session failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`,
              }),
            )
          }
          owned.set(id, conversationId)
          return { sessionId: id }
        }),

      send: ({ sessionId, keys, enter }) =>
        Effect.gen(function* () {
          const r = yield* tmux(`send-keys -t ${sq(sessionId)} ${sq(keys)}`)
          if (r.exitCode !== 0) {
            return yield* Effect.fail(
              new TerminalSessionError({
                message: `tmux send-keys failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`,
              }),
            )
          }
          if (enter !== false) {
            yield* tmux(`send-keys -t ${sq(sessionId)} Enter`)
          }
        }),

      read: ({ sessionId, lines }) =>
        Effect.gen(function* () {
          const scroll = lines !== undefined ? ` -S -${Math.max(1, Math.trunc(lines))}` : ""
          const r = yield* tmux(`capture-pane -t ${sq(sessionId)} -p${scroll}`)
          if (r.exitCode !== 0) {
            return yield* Effect.fail(
              new TerminalSessionError({
                message: `tmux capture-pane failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`,
              }),
            )
          }
          return { screen: r.stdout }
        }),

      kill: (sessionId) =>
        tmux(`kill-session -t ${sq(sessionId)}`).pipe(
          Effect.map((r) => {
            owned.delete(sessionId)
            return { killed: r.exitCode === 0 }
          }),
          Effect.catchAll(() => Effect.succeed({ killed: false })),
        ),

      list: () =>
        Effect.sync(() => {
          const out: Array<TerminalSessionInfo> = []
          for (const sessionId of owned.keys()) out.push({ sessionId })
          return out
        }),

      killAll: (conversationId) =>
        Effect.gen(function* () {
          for (const [sessionId, conv] of [...owned]) {
            if (conversationId !== undefined && conv !== conversationId) continue
            yield* tmux(`kill-session -t ${sq(sessionId)}`).pipe(Effect.ignore)
            owned.delete(sessionId)
          }
        }),
    }
  }),
)

/**
 * No-op `TerminalSession` for evals/CI/tests that have no tmux and don't need
 * interactive sessions. `available` is false; ops fail with a clear message.
 */
export const NoopTerminalSessionLive = Layer.succeed(
  TerminalSession,
  TerminalSession.of({
    available: Effect.succeed(false),
    start: () =>
      Effect.fail(
        new TerminalSessionError({
          message: "interactive terminal sessions are unavailable in this environment",
        }),
      ),
    send: () =>
      Effect.fail(new TerminalSessionError({ message: "interactive sessions unavailable" })),
    read: () =>
      Effect.fail(new TerminalSessionError({ message: "interactive sessions unavailable" })),
    kill: () => Effect.succeed({ killed: false }),
    list: () => Effect.succeed([]),
    killAll: () => Effect.void,
  }),
)
