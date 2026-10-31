import { Context } from "effect"
import type { Effect, Stream } from "effect"
import type { ProcessCommand, ProcessEvent } from "../process-protocol.entity.js"
import type { ProcessPeerError } from "../process-peer.entity.js"

/**
 * One scoped, bounded, ordered NDJSON connection. `commands` has one lifetime
 * consumer. Input EOF completes it only at a frame boundary. Accepted sends
 * survive caller interruption; `flush` awaits every send accepted before its
 * snapshot and preserves the first output failure. Closing the peer does not
 * close host-owned native streams. `processPeerConformance` is the runnable contract.
 * @public
 */
export class ProcessPeer extends Context.Service<ProcessPeer, {
  readonly commands: Stream.Stream<ProcessCommand, ProcessPeerError>
  /** Accept and acknowledge one complete output frame, or fail without partial interleaving. */
  readonly send: (event: ProcessEvent) => Effect.Effect<void, ProcessPeerError>
  /** Barrier for all writes accepted before this call; output failures remain failures. */
  readonly flush: Effect.Effect<void, ProcessPeerError>
}>()("@xandreed/process-host/ProcessPeer") {}
