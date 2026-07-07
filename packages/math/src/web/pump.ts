/**
 * The math fragment pump — the web pump's pattern (one server-side model per
 * session, a sliding hub of rendered OOB batches) plus `apply`: the LOCAL fold
 * entry the typed-action handlers use for server-instant changes (grading,
 * navigation, setup) — same Ref, same render path, no agent event involved.
 *
 * Reconnect contract unchanged: every socket open gets `fullRender`; keyed
 * singleton ids make replaying it over live state idempotent.
 */
import { Effect, PubSub, Ref, Stream } from "effect"
import type { MathSession } from "../session.js"
import type { MathModel, MathPatch } from "./model.js"
import { reduceMathEvent } from "./reduce.js"
import { renderMathPatch, renderMathSync, type MathMeta } from "./render.js"
import { replayMath } from "./replay.js"

export interface MathPump {
  /** Idempotent full render of the current model — one reconnect batch. */
  readonly fullRender: Effect.Effect<string>
  readonly snapshot: Effect.Effect<MathModel>
  /** Live fragment batches; N sockets subscribe, one publish per change. */
  readonly hub: PubSub.PubSub<string>
  /** Fold a server-local change (instant grading / navigation) into the model
   *  and publish its fragments — the same pipeline agent events ride. */
  readonly apply: (
    f: (m: MathModel) => { readonly model: MathModel; readonly patches: ReadonlyArray<MathPatch> },
  ) => Effect.Effect<MathModel>
  /** A generation turn is in flight (coalesces the agent-bound actions). */
  readonly busy: Effect.Effect<boolean>
}

/** Scoped: the subscribe fiber lives for the caller's scope. */
export const makeMathPump = (
  session: MathSession,
  meta: MathMeta,
  history: ReadonlyArray<import("@xandreed/engine").AgentMessage>,
  seed?: { grade?: number; theme?: string },
) =>
  Effect.gen(function* () {
    const state = yield* session.state
    const model = yield* Ref.make(replayMath(history, seed))
    const hub = yield* PubSub.sliding<string>(256)

    const publishPatches = (m: MathModel, patches: ReadonlyArray<MathPatch>) => {
      if (patches.length === 0) return Effect.void
      const batch = [...new Set(patches)]
        .map((p) => renderMathPatch(m, meta, p))
        .filter((s) => s.length > 0)
        .join("\n")
      return batch.length === 0 ? Effect.void : PubSub.publish(hub, batch).pipe(Effect.asVoid)
    }

    yield* Effect.forkScoped(
      session.subscribe(state.cursor).pipe(
        Stream.runForEach((se) =>
          Ref.modify(model, (m) => {
            const r = reduceMathEvent(m, se.event)
            return [r, r.model] as const
          }).pipe(Effect.flatMap((r) => publishPatches(r.model, r.patches))),
        ),
        // The ledger stream ends only on shutdown; a transport error must not
        // kill the pump silently — tabs full-render on their next reconnect.
        Effect.catchAll(() => Effect.void),
      ),
    )

    const pump: MathPump = {
      fullRender: Ref.get(model).pipe(Effect.map((m) => renderMathSync(m, meta))),
      snapshot: Ref.get(model),
      hub,
      apply: (f) =>
        Ref.modify(model, (m) => {
          const r = f(m)
          return [r, r.model] as const
        }).pipe(
          Effect.tap((r) => publishPatches(r.model, r.patches)),
          Effect.map((r) => r.model),
        ),
      busy: Ref.get(model).pipe(Effect.map((m) => m.generating)),
    }
    return pump
  })
