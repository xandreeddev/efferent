import { Context } from "effect"
import type { Effect } from "effect"
import type { WorkspaceError } from "../domain/Errors.js"
import type { FactoryRun } from "../domain/FactoryRun.js"

/** Persists the encoded `FactoryRun` artifact — the run's durable record. */
export class RunSink extends Context.Tag("@xandreed/foundry/RunSink")<
  RunSink,
  {
    readonly persist: (run: FactoryRun) => Effect.Effect<string, WorkspaceError>
  }
>() {}
