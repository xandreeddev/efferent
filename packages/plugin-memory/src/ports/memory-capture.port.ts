import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { KnowledgeError, SessionAddress, SessionListCursor } from "@xandreed/core"
import type { MemorySyncResult } from "../memory.entity.js"

/** Owner-checked journal synchronization; only durably closed turns become sources. @public */
export class MemoryCapture extends Context.Service<MemoryCapture, {
  readonly sync: (address: SessionAddress) => Effect.Effect<MemorySyncResult, KnowledgeError>
  readonly backfill: (input: { readonly owner: string; readonly before?: SessionListCursor; readonly limit?: number }) => Effect.Effect<{
    readonly sources: number; readonly next: Option.Option<SessionListCursor>
  }, KnowledgeError>
}>()("@xandreed/plugin-memory/MemoryCapture") {}
