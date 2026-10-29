import { Context } from "effect"
import type { Effect, Stream } from "effect"
import type { BashError, BashEvent, BashOptions, BashResult } from "../domain/bash.entity.js"

/**
 * Commands run with `bash -c`, each in a process group of its own. A
 * non-zero exit, a signal and a timeout are results the caller reads,
 * never errors: `BashError` means the command could not run at all. When a
 * command times out or its caller stops waiting (the stream or the `exec`
 * is interrupted), the adapter kills its whole process group, so what it
 * started in the background goes with it; an adapter may also do that when
 * the command exits. The environment is built with `resolveBashEnv`.
 * `bashConformance` is the contract as runnable checks.
 */
export class Bash extends Context.Service<Bash, {
    /** Output chunks as they arrive, then exactly one `BashExit`. */
    readonly stream: (command: string, options: BashOptions) => Stream.Stream<BashEvent, BashError>
    /** The whole output and how the command ended (`collectBashResult` over `stream`). */
    readonly exec: (command: string, options: BashOptions) => Effect.Effect<BashResult, BashError>
  }>()("@xandreed/core/Bash") {}
