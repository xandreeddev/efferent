import { Effect, Option } from "effect"
import type { HolderProcess, ProcessLiveness } from "./sessions-state.entity.js"

/** The runtime's process, where it has one. */
const running = Effect.sync(() => Option.fromNullishOr(typeof globalThis.process === "object" ? globalThis.process : undefined))

/** The host's name: from `node:os` where the runtime offers it, else the environment's. */
const hostOf = (current: typeof globalThis.process): Option.Option<string> => {
  const os = typeof current.getBuiltinModule === "function" ? Option.fromNullishOr(current.getBuiltinModule("node:os")) : Option.none()
  return Option.flatMap(os, (module) => Option.fromNullishOr(module.hostname())).pipe(
    Option.orElse(() => Option.fromNullishOr(current.env.HOSTNAME)),
    Option.filter((host) => host.length > 0),
  )
}

/** `kill(pid, 0)` signals nothing and tells whether the pid runs; only ESRCH says it does not (EPERM: another user's process). */
const signalled = (error: unknown): boolean => !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")

/**
 * Process ownership's default liveness: this process by its host, pid and
 * start time, and a pid of this host runs while `kill(pid, 0)` finds it.
 * Without a process (another runtime), turns name none and nothing is asked.
 */
export const processLiveness: ProcessLiveness = {
  current: running.pipe(Effect.map(Option.flatMap((current) => Option.map(hostOf(current), (host): HolderProcess => ({
    host, pid: current.pid, startedAt: Math.round(performance.timeOrigin),
  }))))),
  alive: (pid) => running.pipe(Effect.flatMap(Option.match({
    onNone: () => Effect.succeed(true),
    onSome: (current) => pid <= 0 ? Effect.succeed(false) : Effect.try({ try: () => current.kill(pid, 0), catch: signalled }).pipe(
      Effect.as(true),
      Effect.catch((alive) => Effect.succeed(alive)),
    ),
  }))),
}
