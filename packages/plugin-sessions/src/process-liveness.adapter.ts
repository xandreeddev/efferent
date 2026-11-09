import { hostname } from "node:os"
import process from "node:process"
import { Effect, Option } from "effect"
import { errorCodeOf } from "@xandreed/core"
import type { HolderProcess, ProcessLiveness } from "./sessions-state.entity.js"

/** Only ESRCH proves death; EPERM is another user's live process. */
const signalled = (error: unknown): boolean => !Option.contains(errorCodeOf(error), "ESRCH")

/** The declared Node/Bun process adapter. Hosts may supply another ProcessLiveness. @public */
export const processLiveness: ProcessLiveness = {
  current: Effect.sync(() => Option.some<HolderProcess>({ host: hostname(), pid: process.pid, startedAt: Math.round(performance.timeOrigin) })),
  alive: (pid) => pid <= 0 ? Effect.succeed(false) : Effect.try({ try: () => process.kill(pid, 0), catch: signalled }).pipe(
    Effect.as(true), Effect.catch((alive) => Effect.succeed(alive)),
  ),
}
