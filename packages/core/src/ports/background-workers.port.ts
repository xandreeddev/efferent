import { Context } from "effect"
import type { Effect } from "effect"

/** A runtime worker whose queued work is durable outside its fiber. @public */
export interface BackgroundWorker {
  readonly id: string
  /** Admitted claims and claimed work only: sleeping pollers and durable pending jobs do not count. */
  readonly running: Effect.Effect<number>
  /** Completes once no admitted claim or claimed work remains; a sleeping poller is idle. */
  readonly idle: Effect.Effect<void>
  /** Idempotently stop claiming new work; producers may still enqueue durably. */
  readonly stop: Effect.Effect<void>
  /** Interrupt local work, leaving unfinished jobs recoverable by their leases. */
  readonly interrupt: Effect.Effect<void>
}

/**
 * MULTI-provider workers, in graph order, independent of TaskActivity.
 * processActivity and awaitIdle count them; shutdownGracefully stops claims,
 * waits within its shared deadline and interrupts remaining local work.
 * Runtime scope finalizers must stop them before closing their stores.
 * @public
 */
export class BackgroundWorkers extends Context.Service<BackgroundWorkers, ReadonlyArray<BackgroundWorker>>()("@xandreed/core/BackgroundWorkers") {}
