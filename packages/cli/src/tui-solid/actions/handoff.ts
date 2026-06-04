import { batch } from "solid-js"
import { Effect } from "effect"
import { ConversationStore, createHandoff, type ConversationId } from "@efferent/core"
import { buildContextView } from "../presentation/contextView.js"
import { formatFullError } from "../util/errorFormat.js"
import type { TuiStore } from "../state/store.js"
import { applyContextRebuild } from "./session.js"

/**
 * Generate a handoff (summarise the loaded view → write a checkpoint), then
 * refresh the context viewer and drop a `checkpoint` block on the rail. Lifted
 * from `tui.ts`'s `:handoff` fork — but here the caller (`runCommand`) forks it
 * via `ctx.run`, so this is a plain Effect that owns its own busy flag.
 *
 * `createHandoff` needs `ConversationStore | LanguageModel`, both ambient in
 * `AppServices`; a failure surfaces as an `error` block, never an aborted turn.
 */
export const runHandoff = (store: TuiStore, cid: ConversationId) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      store.setBusy(true)
      store.setNote("generating handoff…")
      store.pushBlock({ kind: "info", text: "⟳ generating handoff…" })
    })

    const result = yield* createHandoff(cid).pipe(Effect.either)
    if (result._tag === "Left") {
      yield* Effect.sync(() =>
        batch(() => {
          store.pushBlock({ kind: "error", text: `handoff failed: ${formatFullError(result.left)}` })
          store.setBusy(false)
          store.setNote(undefined)
        }),
      )
      return
    }

    const cs = yield* ConversationStore
    const cp = yield* cs
      .getLatestCheckpoint(cid)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
    const history = yield* cs.list(cid).pipe(Effect.catchAll(() => Effect.succeed([])))
    const checkpoints = yield* cs
      .listCheckpoints(cid)
      .pipe(Effect.catchAll(() => Effect.succeed([])))

    yield* Effect.sync(() =>
      batch(() => {
        applyContextRebuild(store, buildContextView(history, checkpoints))
        if (cp !== undefined) store.pushBlock({ kind: "checkpoint", text: cp.summary })
        else store.pushBlock({ kind: "info", text: "nothing new to hand off" })
        store.setBusy(false)
        store.setNote(undefined)
      }),
    )
  })
