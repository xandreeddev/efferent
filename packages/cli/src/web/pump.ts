/**
 * The fragment pump: ONE server-side model per session, shared by every
 * browser tab. Seeds from `Workspace.getState` + `projectHistory` (the same
 * projection the TUI resyncs with), then folds the live event stream through
 * the web reducer and publishes rendered OOB fragment batches onto a bounded
 * hub. Deliberately needs ONLY a Workspace value + a session id — the door to
 * mounting the same UI on the shared daemon later.
 *
 * Reconnect contract: every socket open (first or re-) gets `fullRender` —
 * keyed ids make replaying it over live state idempotent. The hub is sliding
 * (a wedged tab drops old frames and heals on its next reconnect).
 */
import { Effect, PubSub, Ref, Stream } from "effect"
import type { SessionId, Workspace } from "@xandreed/sdk-core"
import { projectHistory } from "../cli/presentation/historyProjection.js"
import { replayCanvas } from "./canvasReplay.js"
import { emptyModel, identityOf, type WebModel } from "./model.js"
import { makeWebReducer } from "./reduce.js"
import { renderPatch, renderSync, type WebMeta } from "./render.js"

export interface FragmentPump {
  /** Idempotent full render of the current model — one reconnect batch. */
  readonly fullRender: Effect.Effect<string>
  /** The current model (GET / renders the whole page from it). */
  readonly snapshot: Effect.Effect<WebModel>
  /** Live fragment batches; N sockets subscribe, one publish per event. */
  readonly hub: PubSub.PubSub<string>
  /** Optimistically queue a prompt typed while a turn runs (the daemon queues
   *  server-side too; the authoritative `user_message` drains this echo). */
  readonly enqueueLocal: (prompt: string) => Effect.Effect<void>
  /** Is a turn in flight right now (drives queue-vs-run on POST /send)? */
  readonly busy: Effect.Effect<boolean>
}

type WorkspaceValue = ReturnType<typeof Workspace.of>

/** Scoped: the subscribe fiber lives for the caller's scope. */
export const makeFragmentPump = (ws: WorkspaceValue, sessionId: SessionId, meta: WebMeta) =>
  Effect.gen(function* () {
    const state = yield* ws.getState(sessionId)
    // The active window already excludes any folded prefix; checkpoints aren't
    // carried on SessionState, so the "⚑ folded" divider is a conscious v1 cut.
    const proj = projectHistory([...state.log], [], state.logBaseOffset ?? 0)

    let seed: WebModel = emptyModel({
      phase: state.phase ?? (state.busy ? "thinking" : "idle"),
      openToolCount: 0,
    })
    for (const block of proj.blocks) {
      const inherent = identityOf(block)
      const key = inherent ?? `h:${seed.seq + 1}`
      seed = {
        ...seed,
        seq: inherent === undefined ? seed.seq + 1 : seed.seq,
        blocks: [...seed.blocks, { key, block }],
      }
    }
    // Pages replay from the persisted render_ui tool calls — they survive a
    // driver restart and --resume (same merge as the live fold).
    const replayed = replayCanvas([...state.log])
    seed = {
      ...seed,
      plan: proj.plan,
      canvas: replayed.canvas,
      activePage: replayed.activePage,
      queue: state.queue ?? [],
      ...(state.pendingApproval !== null
        ? {
            approval: {
              tool: state.pendingApproval.tool,
              summary: state.pendingApproval.summary,
              cwd: state.pendingApproval.cwd,
              ruleKey: state.pendingApproval.ruleKey,
            },
          }
        : {}),
    }

    const model = yield* Ref.make(seed)
    const hub = yield* PubSub.sliding<string>(256)
    const reduce = makeWebReducer(String(sessionId))

    yield* Effect.forkScoped(
      ws.subscribe(sessionId, state.cursor).pipe(
        Stream.runForEach((se) =>
          Ref.modify(model, (m) => {
            const r = reduce(m, se.event)
            return [r, r.model] as const
          }).pipe(
            Effect.flatMap((r) => {
              if (r.patches.length === 0) return Effect.void
              const batch = r.patches
                .map((p) => renderPatch(r.model, meta, p))
                .filter((s) => s.length > 0)
                .join("\n")
              return batch.length === 0 ? Effect.void : PubSub.publish(hub, batch).pipe(Effect.asVoid)
            }),
          ),
        ),
        // The ledger stream ends only on shutdown; a transport error must not
        // kill the pump silently — tabs full-render on their next reconnect.
        Effect.catchAll(() => Effect.void),
      ),
    )

    const pump: FragmentPump = {
      fullRender: Ref.get(model).pipe(Effect.map((m) => renderSync(m, meta))),
      snapshot: Ref.get(model),
      hub,
      enqueueLocal: (prompt: string) =>
        Ref.modify(model, (m) => {
          const next: WebModel = { ...m, queue: [...m.queue, prompt] }
          return [next, next] as const
        }).pipe(
          Effect.flatMap((m) =>
            PubSub.publish(hub, renderPatch(m, meta, { kind: "queue" })).pipe(Effect.asVoid),
          ),
        ),
      busy: Ref.get(model).pipe(Effect.map((m) => m.phase.phase !== "idle")),
    }
    return pump
  })
