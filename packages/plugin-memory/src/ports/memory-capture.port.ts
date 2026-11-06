import { Context, Effect } from "effect"
import type { Option } from "effect"
import type { KnowledgeError, SessionAddress, SessionListCursor } from "@xandreed/core"
import type { MemoryCaptureDecision, MemoryCaptureTurn, MemorySyncResult } from "../memory.entity.js"

/** Owner-checked journal synchronization; only durably closed turns become sources. @public */
export class MemoryCapture extends Context.Service<MemoryCapture, {
  readonly sync: (address: SessionAddress) => Effect.Effect<MemorySyncResult, KnowledgeError>
  readonly backfill: (input: { readonly owner: string; readonly before?: SessionListCursor; readonly limit?: number }) => Effect.Effect<{
    readonly sources: number; readonly next: Option.Option<SessionListCursor>
    /** How many turns the host's admission refused across the page; absent when none was. */
    readonly refused?: number
  }, KnowledgeError>
}>()("@xandreed/plugin-memory/MemoryCapture") {}

/**
 * Screens each committed turn before capture stores it: `MemoryCapture.sync` asks it once per
 * closed turn it reaches, after rendering the turn's evidence and before enqueuing any of it, as
 * do `backfill`, the committed-turn observer and the catch-up the `memory.recalled` section runs.
 * `Admit` stores the evidence, or the decision's `text` in its place; `Refuse` stores nothing, and
 * the checkpoint still moves past the turn, so later syncs never read it again. A failure fails
 * the sync before that turn's checkpoint, and an invalid decision fails it as `Invalid`: the turn
 * is asked again on the next sync. A turn whose checkpoint was lost is asked again too, so decide
 * from the turn alone. The default admits every turn as is. A host provides its own among the
 * agent's or the turn's services, or around its own `sync` and `backfill` calls.
 * @public
 */
export const MemoryCaptureAdmission = Context.Reference<{
  readonly admit: (turn: MemoryCaptureTurn) => Effect.Effect<MemoryCaptureDecision, KnowledgeError>
}>("@xandreed/plugin-memory/MemoryCaptureAdmission", { defaultValue: () => ({ admit: () => Effect.succeed({ _tag: "Admit" }) }) })
